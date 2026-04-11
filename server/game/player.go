package game

import (
	"encoding/json"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
	maxMsgSize = 2048
)

type Keys struct {
	Left     bool `json:"left"`
	Right    bool `json:"right"`
	Jump     bool `json:"jump"`
	Fist     bool `json:"fist"`
	Leg      bool `json:"leg"`
	Uppercut bool `json:"uppercut"`
	Block    bool `json:"block"`
	Dodge    bool `json:"dodge"`
	Shoot    bool `json:"shoot"`
}

type Player struct {
	hub          *Hub
	conn         *websocket.Conn
	send         chan []byte
	closed       atomic.Bool // set to true when hub closes the send channel
	mu           sync.Mutex
	ID           int
	Name         string
	Keys         Keys
	attackEvents []string // attack events received since last tick
	Match        *Match
	authedAs     string // non-empty when name came from a verified JWT
}

type IncomingMsg struct {
	Type string   `json:"type"`
	Name string   `json:"name,omitempty"`
	Keys *Keys    `json:"keys,omitempty"`
	AB   []string `json:"ab,omitempty"` // attack events (keypresses, not key state)
}

func NewPlayer(hub *Hub, conn *websocket.Conn) *Player {
	return &Player{
		hub:  hub,
		conn: conn,
		send: make(chan []byte, 256),
	}
}

func (p *Player) Send(msg interface{}) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	p.SendBytes(data)
}

func (p *Player) SendBytes(data []byte) {
	if p.closed.Load() {
		return
	}
	select {
	case p.send <- data:
	default:
		log.Printf("send buffer full for %s", p.Name)
	}
}

func (p *Player) ReadPump() {
	defer func() {
		p.hub.unregister <- p
		p.conn.Close()
	}()

	p.conn.SetReadLimit(maxMsgSize)
	p.conn.SetReadDeadline(time.Now().Add(pongWait))
	p.conn.SetPongHandler(func(string) error {
		p.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, data, err := p.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("ws error: %v", err)
			}
			break
		}

		var msg IncomingMsg
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "join_spectate":
			// Client is on the menu page watching live — no name required yet.
			if p.authedAs != "" {
				p.Name = p.authedAs
			} else if msg.Name != "" {
				p.Name = sanitizeNickname(msg.Name)
			}
			if p.Name == "" {
				p.Name = "Spectator"
			}
			p.hub.spectate <- p

		case "join_queue":
			// If the connection was already authenticated via JWT, the name was
			// set at upgrade time; ignore whatever the client sends.
			if p.authedAs != "" {
				p.Name = p.authedAs
			} else {
				// Sanitize unauthenticated names: 2-20 alphanumeric/_/- chars.
				p.Name = sanitizeNickname(msg.Name)
				if p.Name == "" {
					p.Name = "Fighter"
				}
			}
			p.hub.queue <- p

		case "input":
			p.mu.Lock()
			if msg.Keys != nil {
				p.Keys = *msg.Keys
			}
			if len(msg.AB) > 0 {
				p.attackEvents = append(p.attackEvents, msg.AB...)
			}
			p.mu.Unlock()
		}
	}
}

func (p *Player) WritePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		p.conn.Close()
	}()

	for {
		select {
		case msg, ok := <-p.send:
			p.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				p.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := p.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			p.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := p.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
