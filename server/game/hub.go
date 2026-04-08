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
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		if baseURL != "" {
			return origin == baseURL
		}
		return true
	},
}

type Hub struct {
	queue      chan *Player
	spectate   chan *Player   // spectators joining
	unregister chan *Player
	matchDone  chan struct{}
	specBcast  chan []byte    // match goroutines push snapshots here; Hub fans out to spectators

	players    map[*Player]bool
	spectators map[*Player]bool

	stateMu       sync.RWMutex
	waitingName   string
	waitingSince  time.Time
	onlineCount   int
	activeMatches int
}

func NewHub() *Hub {
	return &Hub{
		queue:      make(chan *Player, 100),
		spectate:   make(chan *Player, 100),
		unregister: make(chan *Player, 100),
		matchDone:  make(chan struct{}, 100),
		specBcast:  make(chan []byte, 256), // buffer ~4 ticks at 60 fps per match
		players:    make(map[*Player]bool),
		spectators: make(map[*Player]bool),
	}
}

// BroadcastSpectators is called from match goroutines — non-blocking.
// Drops frames if the hub is momentarily busy; spectators tolerate frame drops.
func (h *Hub) BroadcastSpectators(data []byte) {
	select {
	case h.specBcast <- data:
	default:
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

func (h *Hub) pushQueueStatus() {
	h.stateMu.RLock()
	name  := h.waitingName
	since := h.waitingSince
	online := h.onlineCount
	active := h.activeMatches
	h.stateMu.RUnlock()

	secs := 0
	if name != "" {
		secs = int(time.Since(since).Seconds())
	}

	data, err := json.Marshal(map[string]interface{}{
		"type": "queue_status",
		"status": QueueStatus{
			WaitingName:   name,
			WaitingSecs:   secs,
			Online:        online,
			ActiveMatches: active,
		},
	})
	if err != nil {
		return
	}
	// Send to active players and spectators
	for p := range h.players {
		p.SendBytes(data)
	}
	for p := range h.spectators {
		p.SendBytes(data)
	}
}

func (h *Hub) Run() {
	var waiting *Player

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			h.stateMu.RLock()
			hasWaiter := h.waitingName != ""
			h.stateMu.RUnlock()
			if hasWaiter {
				h.pushQueueStatus()
			}

		case <-h.matchDone:
			h.pushQueueStatus()

		// ── Spectator joins ───────────────────────────────────────────────────
		case p := <-h.spectate:
			h.spectators[p] = true
			h.stateMu.Lock()
			h.onlineCount = len(h.players) + len(h.spectators)
			h.stateMu.Unlock()
			log.Printf("[spectate] %s watching", p.Name)
			h.pushQueueStatus()

		// ── Match broadcasts a snapshot → fan out to spectators ──────────────
		case data := <-h.specBcast:
			for sp := range h.spectators {
				sp.SendBytes(data)
			}

		// ── Player joins queue (may be upgrading from spectator) ──────────────
		case p := <-h.queue:
			// Move out of spectators if upgrading
			if _, isSpectator := h.spectators[p]; isSpectator {
				delete(h.spectators, p)
			}
			h.players[p] = true
			h.stateMu.Lock()
			h.onlineCount = len(h.players) + len(h.spectators)
			h.stateMu.Unlock()

			if waiting == nil {
				waiting = p
				h.setWaiting(p)
				p.Send(map[string]interface{}{
					"type":    "queued",
					"message": "Waiting for an opponent...",
				})
				log.Printf("[queue] %s is waiting", p.Name)

				if DB != nil {
					DB.Exec(`INSERT INTO queue_log (name) VALUES (?)`, p.Name)
				}
			} else {
				p1, p2 := waiting, p
				waiting = nil
				h.clearWaiting()

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

				// Notify every menu spectator who's about to fight.
				if notif, err := json.Marshal(map[string]interface{}{
					"type": "match_started",
					"p1":   p1.Name,
					"p2":   p2.Name,
				}); err == nil {
					for sp := range h.spectators {
						sp.SendBytes(notif)
					}
				}

				m := NewMatch(p1, p2, h)
				go func() {
					m.Run()
					h.stateMu.Lock()
					h.activeMatches--
					h.stateMu.Unlock()
					select {
					case h.matchDone <- struct{}{}:
					default:
					}
				}()
			}
			h.pushQueueStatus()

		// ── Disconnect ────────────────────────────────────────────────────────
		case p := <-h.unregister:
			if _, ok := h.players[p]; ok {
				delete(h.players, p)
				h.stateMu.Lock()
				h.onlineCount = len(h.players) + len(h.spectators)
				h.stateMu.Unlock()
				p.closed.Store(true)
				close(p.send)

				if waiting == p {
					waiting = nil
					h.clearWaiting()
					log.Printf("[queue] %s left queue", p.Name)
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

			} else if _, ok := h.spectators[p]; ok {
				delete(h.spectators, p)
				h.stateMu.Lock()
				h.onlineCount = len(h.players) + len(h.spectators)
				h.stateMu.Unlock()
				p.closed.Store(true)
				close(p.send)
				log.Printf("[spectate] %s left", p.Name)
			}
			h.pushQueueStatus()
		}
	}
}

// QueueStatus is the shape pushed over WS and served over HTTP.
type QueueStatus struct {
	WaitingName   string `json:"waiting_name"`
	WaitingSecs   int    `json:"waiting_secs"`
	Online        int    `json:"online"`
	ActiveMatches int    `json:"active_matches"`
}

func (h *Hub) ServeQueue(w http.ResponseWriter, r *http.Request) {
	h.stateMu.RLock()
	name  := h.waitingName
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
	if nick, ok := GetNicknameFromRequest(r); ok {
		p.authedAs = nick
		p.Name = nick
	}
	go p.WritePump()
	go p.ReadPump()
}
