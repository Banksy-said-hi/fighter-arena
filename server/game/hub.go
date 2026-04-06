package game

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

type Hub struct {
	queue      chan *Player
	unregister chan *Player
	players    map[*Player]bool

	// Real-time queue state — read by HTTP handler, written by Run() goroutine
	stateMu       sync.RWMutex
	waitingName   string
	waitingSince  time.Time
	onlineCount   int
	activeMatches int
}

func NewHub() *Hub {
	return &Hub{
		queue:      make(chan *Player, 100),
		unregister: make(chan *Player, 100),
		players:    make(map[*Player]bool),
	}
}

func (h *Hub) setWaiting(p *Player) {
	h.stateMu.Lock()
	h.waitingName = p.Name
	h.waitingSince = time.Now()
	h.stateMu.Unlock()
}

func (h *Hub) clearWaiting() {
	h.stateMu.Lock()
	h.waitingName = ""
	h.stateMu.Unlock()
}

func (h *Hub) setOnline(n int) {
	h.stateMu.Lock()
	h.onlineCount = n
	h.stateMu.Unlock()
}

func (h *Hub) Run() {
	var waiting *Player

	for {
		select {
		case p := <-h.queue:
			h.players[p] = true
			h.setOnline(len(h.players))

			if waiting == nil {
				waiting = p
				h.setWaiting(p)
				p.Send(map[string]interface{}{
					"type":    "queued",
					"message": "Waiting for an opponent...",
				})
				log.Printf("[queue] %s is waiting", p.Name)

				// Log queue entry to SQLite
				if DB != nil {
					DB.Exec(`INSERT INTO queue_log (name) VALUES (?)`, p.Name)
				}
			} else {
				p1, p2 := waiting, p
				waiting = nil
				h.clearWaiting()

				// Mark both as matched in queue_log
				if DB != nil {
					DB.Exec(`
						UPDATE queue_log SET matched_at = CURRENT_TIMESTAMP
						WHERE name = ? AND matched_at IS NULL
						ORDER BY id DESC LIMIT 1
					`, p1.Name)
				}

				h.stateMu.Lock()
				h.activeMatches++
				h.stateMu.Unlock()

				log.Printf("[match] %s vs %s", p1.Name, p2.Name)
				m := NewMatch(p1, p2)
				go func() {
					m.Run()
					h.stateMu.Lock()
					h.activeMatches--
					h.stateMu.Unlock()
				}()
			}

		case p := <-h.unregister:
			if _, ok := h.players[p]; ok {
				delete(h.players, p)
				h.setOnline(len(h.players))
				close(p.send)

				if waiting == p {
					waiting = nil
					h.clearWaiting()
					log.Printf("[queue] %s left queue", p.Name)

					// Log departure
					if DB != nil {
						DB.Exec(`
							UPDATE queue_log SET left_at = CURRENT_TIMESTAMP
							WHERE name = ? AND left_at IS NULL AND matched_at IS NULL
							ORDER BY id DESC LIMIT 1
						`, p.Name)
					}
				}

				if p.Match != nil {
					p.Match.PlayerLeft(p)
				}
				log.Printf("[disconnect] %s", p.Name)
			}
		}
	}
}

// QueueStatus is returned by the /queue endpoint.
type QueueStatus struct {
	WaitingName   string `json:"waiting_name"` // "" if nobody waiting
	WaitingSecs   int    `json:"waiting_secs"`
	Online        int    `json:"online"`
	ActiveMatches int    `json:"active_matches"`
}

func (h *Hub) ServeQueue(w http.ResponseWriter, r *http.Request) {
	h.stateMu.RLock()
	name := h.waitingName
	since := h.waitingSince
	online := h.onlineCount
	active := h.activeMatches
	h.stateMu.RUnlock()

	secs := 0
	if name != "" {
		secs = int(time.Since(since).Seconds())
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(QueueStatus{
		WaitingName:   name,
		WaitingSecs:   secs,
		Online:        online,
		ActiveMatches: active,
	})
}

func ServeWS(hub *Hub, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade error: %v", err)
		return
	}
	p := NewPlayer(hub, conn)
	go p.WritePump()
	go p.ReadPump()
}
