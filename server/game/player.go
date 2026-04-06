package game

import (
	"encoding/json"
	"log"
	"sync"
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
}

type Player struct {
	hub   *Hub
	conn  *websocket.Conn
	send  chan []byte
	mu    sync.Mutex
	ID    int
	Name  string
	Keys  Keys
	Match *Match
}

type IncomingMsg struct {
	Type string `json:"type"`
	Name string `json:"name,omitempty"`
	Keys *Keys  `json:"keys,omitempty"`
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
		case "join_queue":
			p.Name = msg.Name
			if p.Name == "" {
				p.Name = "Fighter"
			}
			p.hub.queue <- p

		case "input":
			if msg.Keys != nil {
				p.mu.Lock()
				p.Keys = *msg.Keys
				p.mu.Unlock()
			}
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
