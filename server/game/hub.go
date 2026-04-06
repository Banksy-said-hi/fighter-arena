package game

import (
	"log"
	"net/http"

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
}

func NewHub() *Hub {
	return &Hub{
		queue:      make(chan *Player, 100),
		unregister: make(chan *Player, 100),
		players:    make(map[*Player]bool),
	}
}

func (h *Hub) Run() {
	var waiting *Player

	for {
		select {
		case p := <-h.queue:
			h.players[p] = true
			if waiting == nil {
				waiting = p
				p.Send(map[string]interface{}{
					"type":    "queued",
					"message": "Waiting for an opponent...",
				})
				log.Printf("[queue] %s is waiting", p.Name)
			} else {
				p1, p2 := waiting, p
				waiting = nil
				log.Printf("[match] %s vs %s", p1.Name, p2.Name)
				m := NewMatch(p1, p2)
				go m.Run()
			}

		case p := <-h.unregister:
			if _, ok := h.players[p]; ok {
				delete(h.players, p)
				close(p.send)
				if waiting == p {
					waiting = nil
					log.Printf("[queue] %s left queue", p.Name)
				}
				if p.Match != nil {
					p.Match.PlayerLeft(p)
				}
				log.Printf("[disconnect] %s", p.Name)
			}
		}
	}
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
