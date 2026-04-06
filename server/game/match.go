package game

import (
	"log"
	"math"
	"sync"
	"time"
)

const (
	TickRate     = 30
	TickDuration = time.Second / TickRate

	MapWidth  = 800.0
	MapHeight = 450.0
	GroundY   = 370.0

	PlayerW = 50.0
	PlayerH = 80.0

	Gravity      = 0.65
	JumpVel      = -13.5
	MoveSpeed    = 5.0
	MaxFallSpeed = 18.0

	PhaseCountdown = "countdown"
	PhaseFighting  = "fighting"
	PhaseGameOver  = "gameover"

	StateIdle           = "idle"
	StateWalking        = "walking"
	StateJumping        = "jumping"
	StateAttackFist     = "attack_fist"
	StateAttackLeg      = "attack_leg"
	StateAttackUppercut = "attack_uppercut"
	StateBlocking       = "blocking"
	StateDodging        = "dodging"
	StateHurt           = "hurt"
	StateKO             = "ko"
)

type AttackBox struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

type PlayerState struct {
	ID           int        `json:"id"`
	Name         string     `json:"name"`
	Color        string     `json:"color"`
	X            float64    `json:"x"`
	Y            float64    `json:"y"`
	HP           int        `json:"hp"`
	MaxHP        int        `json:"maxHp"`
	Facing       int        `json:"facing"`
	State        string     `json:"state"`
	AttackActive bool       `json:"attackActive"`
	AttackBox    *AttackBox `json:"attackBox,omitempty"`

	// Internal (not serialised)
	vx              float64
	vy              float64
	actionTimer     int
	cooldowns       map[string]int
	dodgeInvincible bool
}

type GameSnapshot struct {
	Phase     string         `json:"phase"`
	Countdown int            `json:"countdown"`
	Players   [2]*PlayerState `json:"players"`
	Winner    string         `json:"winner"`
	Tick      int            `json:"tick"`
}

type Match struct {
	players   [2]*Player
	states    [2]*PlayerState
	phase     string
	countdown int
	winner    string
	tick      int
	done      chan struct{}
	closeOnce sync.Once
}

func NewMatch(p1, p2 *Player) *Match {
	m := &Match{
		players:   [2]*Player{p1, p2},
		phase:     PhaseCountdown,
		countdown: 3,
		done:      make(chan struct{}),
	}

	p1.Match = m
	p2.Match = m
	p1.ID = 0
	p2.ID = 1

	colors := [2]string{"#FF69B4", "#FF8C00"}
	names := [2]string{p1.Name, p2.Name}
	startX := [2]float64{120.0, MapWidth - 120.0 - PlayerW}
	facings := [2]int{1, -1}

	for i := 0; i < 2; i++ {
		m.states[i] = &PlayerState{
			ID:        i,
			Name:      names[i],
			Color:     colors[i],
			X:         startX[i],
			Y:         GroundY - PlayerH,
			HP:        100,
			MaxHP:     100,
			Facing:    facings[i],
			State:     StateIdle,
			cooldowns: make(map[string]int),
		}
	}

	for i, p := range m.players {
		p.Send(map[string]interface{}{
			"type":      "match_found",
			"player_id": i,
			"you":       names[i],
			"opponent":  names[1-i],
		})
	}

	return m
}

func (m *Match) closeDone() {
	m.closeOnce.Do(func() { close(m.done) })
}

func (m *Match) Run() {
	log.Printf("[game] %s vs %s — start", m.players[0].Name, m.players[1].Name)

	ticker := time.NewTicker(TickDuration)
	defer ticker.Stop()

	countdownTick := 0
	gameOverScheduled := false

	for {
		select {
		case <-m.done:
			log.Printf("[game] %s vs %s — done", m.players[0].Name, m.players[1].Name)
			return

		case <-ticker.C:
			m.tick++

			switch m.phase {
			case PhaseCountdown:
				countdownTick++
				if countdownTick >= TickRate {
					countdownTick = 0
					m.countdown--
					if m.countdown <= 0 {
						m.phase = PhaseFighting
						m.broadcast(map[string]interface{}{"type": "fight_start"})
					}
				}

			case PhaseFighting:
				m.update()
				if m.winner != "" {
					m.phase = PhaseGameOver
					GlobalLeaderboard.RecordWin(m.winner)
				}

			case PhaseGameOver:
				// idle — waiting for timer
			}

			m.broadcastState()

			if m.phase == PhaseGameOver && !gameOverScheduled {
				gameOverScheduled = true
				time.AfterFunc(5*time.Second, m.closeDone)
			}
		}
	}
}

func (m *Match) update() {
	inputs := [2]Keys{}
	for i, p := range m.players {
		p.mu.Lock()
		inputs[i] = p.Keys
		p.mu.Unlock()
	}

	for i := 0; i < 2; i++ {
		m.updatePlayer(i, inputs[i])
	}

	// Auto-face opponent
	for i := 0; i < 2; i++ {
		s := m.states[i]
		opp := m.states[1-i]
		if s.State == StateDodging || s.State == StateKO {
			continue
		}
		if opp.X+PlayerW/2 > s.X+PlayerW/2 {
			s.Facing = 1
		} else {
			s.Facing = -1
		}
	}

	// Combat: check each attacker vs defender
	for i := 0; i < 2; i++ {
		s := m.states[i]
		opp := m.states[1-i]

		if !s.AttackActive || s.AttackBox == nil {
			continue
		}
		if opp.State == StateKO || opp.dodgeInvincible {
			continue
		}
		if !rectsOverlap(s.AttackBox, opp.X, opp.Y, PlayerW, PlayerH) {
			continue
		}

		damage := attackDamage(s.State)
		if opp.State == StateBlocking {
			damage = damage / 4 // 75% block
			if damage < 1 {
				damage = 1
			}
		}

		opp.HP -= damage
		if opp.HP < 0 {
			opp.HP = 0
		}

		// Knockback
		kbDir := float64(s.Facing)
		opp.vx = kbDir * 5.0
		opp.vy = -4.0

		if opp.State != StateBlocking {
			opp.State = StateHurt
			opp.actionTimer = 18
		}

		// Each attack hits once
		s.AttackActive = false
		s.AttackBox = nil

		if opp.HP <= 0 {
			opp.HP = 0
			opp.State = StateKO
			m.winner = s.Name
		}
	}

	// Prevent players from walking through each other
	m.resolveOverlap()
}

func (m *Match) updatePlayer(idx int, keys Keys) {
	s := m.states[idx]

	// Tick timers
	if s.actionTimer > 0 {
		s.actionTimer--
	}
	for k := range s.cooldowns {
		if s.cooldowns[k] > 0 {
			s.cooldowns[k]--
		}
	}

	onGround := s.Y >= GroundY-PlayerH-1

	// --- KO ---
	if s.State == StateKO {
		s.vy += Gravity
		if s.vy > MaxFallSpeed {
			s.vy = MaxFallSpeed
		}
		s.Y += s.vy
		s.vx *= 0.75
		s.X += s.vx
		if s.Y >= GroundY-PlayerH {
			s.Y = GroundY - PlayerH
			s.vy = 0
		}
		clampX(s)
		return
	}

	// --- Hurt stun ---
	if s.State == StateHurt {
		applyGravity(s)
		s.vx *= 0.70
		s.X += s.vx
		clampX(s)
		if s.actionTimer <= 0 {
			s.State = StateIdle
		}
		return
	}

	// --- Dodging ---
	if s.State == StateDodging {
		s.X += s.vx
		applyGravity(s)
		clampX(s)
		if s.actionTimer <= 0 {
			s.dodgeInvincible = false
			s.vx = 0
			s.State = StateIdle
		}
		return
	}

	// --- Attacking ---
	if s.State == StateAttackFist || s.State == StateAttackLeg || s.State == StateAttackUppercut {
		applyGravity(s)
		s.vx *= 0.80
		s.X += s.vx
		clampX(s)

		// Keep attack box tracking player
		if s.AttackActive && s.AttackBox != nil {
			updateAttackBoxPos(s)
		}

		if s.actionTimer <= 0 {
			s.State = StateIdle
			s.AttackActive = false
			s.AttackBox = nil
		}
		return
	}

	// --- Blocking ---
	if s.State == StateBlocking {
		s.vx = 0
		applyGravity(s)
		if !keys.Block {
			s.State = StateIdle
		}
		return
	}

	// --- Normal: idle / walk / jump ---

	// Block (only on ground)
	if keys.Block && onGround {
		s.State = StateBlocking
		s.vx = 0
		return
	}

	// Dodge
	if keys.Dodge && s.cooldowns["dodge"] <= 0 {
		opp := m.states[1-idx]
		dashDir := -float64(s.Facing) // dash away from opponent
		if opp.X+PlayerW/2 > s.X+PlayerW/2 {
			dashDir = -1
		} else {
			dashDir = 1
		}
		s.vx = dashDir * 8.0
		s.State = StateDodging
		s.dodgeInvincible = true
		s.actionTimer = 18
		s.cooldowns["dodge"] = 48
		return
	}

	// Attacks (priority: uppercut > leg > fist)
	if keys.Uppercut && s.cooldowns["uppercut"] <= 0 {
		startAttack(s, StateAttackUppercut)
		return
	}
	if keys.Leg && s.cooldowns["leg"] <= 0 {
		startAttack(s, StateAttackLeg)
		return
	}
	if keys.Fist && s.cooldowns["fist"] <= 0 {
		startAttack(s, StateAttackFist)
		return
	}

	// Movement
	moving := false
	if keys.Left {
		s.vx = -MoveSpeed
		moving = true
	} else if keys.Right {
		s.vx = MoveSpeed
		moving = true
	} else {
		s.vx *= 0.65
		if math.Abs(s.vx) < 0.3 {
			s.vx = 0
		}
	}

	// Jump
	if keys.Jump && onGround {
		s.vy = JumpVel
	}

	applyGravity(s)
	s.X += s.vx
	clampX(s)

	if !onGround {
		s.State = StateJumping
	} else if moving {
		s.State = StateWalking
	} else {
		s.State = StateIdle
	}
}

func startAttack(s *PlayerState, attackState string) {
	s.State = attackState
	s.AttackActive = true

	var duration, cooldown int
	var aw, ah, ayOffset float64

	switch attackState {
	case StateAttackFist:
		duration, cooldown = 18, 28
		aw, ah, ayOffset = 65, 38, 22
	case StateAttackLeg:
		duration, cooldown = 22, 38
		aw, ah, ayOffset = 80, 48, 38
	case StateAttackUppercut:
		duration, cooldown = 28, 55
		aw, ah, ayOffset = 55, 65, -5
		s.vy = -5.0 // small hop
	}

	s.actionTimer = duration
	cooldownKey := map[string]string{
		StateAttackFist:     "fist",
		StateAttackLeg:      "leg",
		StateAttackUppercut: "uppercut",
	}[attackState]
	s.cooldowns[cooldownKey] = cooldown

	abX := s.X + PlayerW
	if s.Facing == -1 {
		abX = s.X - aw
	}

	s.AttackBox = &AttackBox{X: abX, Y: s.Y + ayOffset, W: aw, H: ah}
}

func updateAttackBoxPos(s *PlayerState) {
	var aw float64
	if s.AttackBox != nil {
		aw = s.AttackBox.W
	}
	abX := s.X + PlayerW
	if s.Facing == -1 {
		abX = s.X - aw
	}

	var ayOffset float64
	switch s.State {
	case StateAttackFist:
		ayOffset = 22
	case StateAttackLeg:
		ayOffset = 38
	case StateAttackUppercut:
		ayOffset = -5
	}

	s.AttackBox.X = abX
	s.AttackBox.Y = s.Y + ayOffset
}

func attackDamage(state string) int {
	switch state {
	case StateAttackFist:
		return 10
	case StateAttackLeg:
		return 15
	case StateAttackUppercut:
		return 25
	default:
		return 10
	}
}

func applyGravity(s *PlayerState) {
	s.vy += Gravity
	if s.vy > MaxFallSpeed {
		s.vy = MaxFallSpeed
	}
	s.Y += s.vy
	if s.Y >= GroundY-PlayerH {
		s.Y = GroundY - PlayerH
		s.vy = 0
	}
}

func clampX(s *PlayerState) {
	if s.X < 0 {
		s.X = 0
		s.vx = 0
	}
	if s.X > MapWidth-PlayerW {
		s.X = MapWidth - PlayerW
		s.vx = 0
	}
}

func rectsOverlap(ab *AttackBox, ox, oy, ow, oh float64) bool {
	return ab.X < ox+ow && ab.X+ab.W > ox &&
		ab.Y < oy+oh && ab.Y+ab.H > oy
}

func (m *Match) resolveOverlap() {
	s0, s1 := m.states[0], m.states[1]
	dx := math.Abs(s0.X - s1.X)
	dy := math.Abs(s0.Y - s1.Y)
	if dx < PlayerW && dy < PlayerH {
		push := (PlayerW - dx) / 2.0
		if s0.X < s1.X {
			s0.X -= push
			s1.X += push
		} else {
			s0.X += push
			s1.X -= push
		}
		clampX(s0)
		clampX(s1)
	}
}

func (m *Match) broadcastState() {
	snap := &GameSnapshot{
		Phase:     m.phase,
		Countdown: m.countdown,
		Players:   m.states,
		Winner:    m.winner,
		Tick:      m.tick,
	}
	m.broadcast(map[string]interface{}{"type": "state", "state": snap})
}

func (m *Match) broadcast(msg interface{}) {
	for _, p := range m.players {
		p.Send(msg)
	}
}

func (m *Match) PlayerLeft(p *Player) {
	for _, other := range m.players {
		if other != p {
			// Disconnecting mid-match counts as a loss — record the win
			// for the remaining player only if the match was actually underway.
			if m.phase == PhaseFighting || m.phase == PhaseCountdown {
				m.winner = other.Name
				m.phase = PhaseGameOver
				GlobalLeaderboard.RecordWin(other.Name)
			}
			other.Send(map[string]interface{}{
				"type":    "opponent_left",
				"message": "Opponent disconnected — You Win!",
			})
		}
	}
	m.closeDone()
}
