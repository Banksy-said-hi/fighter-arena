package game

import (
	"encoding/json"
	"log"
	"math"
	"math/rand"
	"sync"
	"time"
)

const (
	TickRate     = 60
	TickDuration = time.Second / TickRate

	MapWidth  = 1280.0
	MapHeight = 720.0
	GroundY   = 592.0

	PlayerW = 27.0
	PlayerH = 42.0

	// Power-up system
	PowerUpSpawnTicks  = 480  // spawn every 8s at 60fps
	PowerUpBuffTicks   = 480  // buff lasts 8s
	PowerUpCollectR    = 40.0 // collection radius (px)
	PowerUpBuffMult    = 2.5  // speed / damage multiplier
	MaxPowerUps        = 3

	// Projectile system
	ProjectileSpeed    = 10.0 // px/tick
	ProjectileDamage   = 20   // hp
	ShootBuffShots     = 5    // shots granted by shoot power-up
	ShootCooldownTicks = 30   // ticks between shots (~0.5s)

	// Physics values are per-tick. At 60fps each constant is halved vs the
	// old 30fps values so real-world feel (speed, jump arc) stays identical.
	// All values scaled ×1.6 to match the larger 1280×720 canvas.
	Gravity      = 0.52
	JumpVel      = -10.8
	MoveSpeed    = 4.0
	MaxFallSpeed = 14.4

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

type Projectile struct {
	ID      int     `json:"id"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	VX      float64 `json:"vx"`
	OwnerID int     `json:"ownerId"`
}

type PowerUp struct {
	ID   int     `json:"id"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	Kind string  `json:"kind"` // "speed" | "damage"
}

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
	SpeedBuff    int        `json:"speedBuff,omitempty"`  // ticks remaining
	DamageBuff   int        `json:"damageBuff,omitempty"` // ticks remaining
	ShootBuff    int        `json:"shootBuff,omitempty"`  // shots remaining

	// Internal (not serialised)
	vx              float64
	vy              float64
	actionTimer     int
	cooldowns       map[string]int
	dodgeInvincible bool
	attackQueue    [3]string // FIFO — max 3 slots (one per attack type)
	attackQueueLen int
}

// queueAttack appends an attack to the FIFO. Drops silently when full (3 slots
// covers all distinct attack types so this only happens on held keys).
func (s *PlayerState) queueAttack(a string) {
	if s.attackQueueLen < 3 {
		s.attackQueue[s.attackQueueLen] = a
		s.attackQueueLen++
	}
}

// dequeueAttack pops and returns the oldest queued attack, or "" if empty.
func (s *PlayerState) dequeueAttack() string {
	if s.attackQueueLen == 0 {
		return ""
	}
	a := s.attackQueue[0]
	copy(s.attackQueue[:], s.attackQueue[1:])
	s.attackQueue[s.attackQueueLen-1] = ""
	s.attackQueueLen--
	return a
}

type GameSnapshot struct {
	Phase     string          `json:"phase"`
	Countdown int             `json:"countdown"`
	Players   [2]*PlayerState `json:"players"`
	Winner    string          `json:"winner"`
	Tick      int             `json:"tick"`
	PowerUps    []*PowerUp    `json:"powerUps,omitempty"`
	Projectiles []*Projectile `json:"projectiles,omitempty"`
}

type Match struct {
	hub          *Hub          // for spectator broadcast
	players      [2]*Player
	states       [2]*PlayerState
	phase        string
	countdown    int
	winner       string
	tick         int
	done         chan struct{}
	closeOnce    sync.Once
	powerUps     []*PowerUp
	powerUpSeq   int
	spawnTimer   int
	projectiles  []*Projectile
	prevKeys     [2]Keys       // previous tick key state for edge detection
	projSeq      int
}

func NewMatch(p1, p2 *Player, hub *Hub) *Match {
	m := &Match{
		hub:        hub,
		players:    [2]*Player{p1, p2},
		phase:      PhaseCountdown,
		countdown:  3,
		done:       make(chan struct{}),
		spawnTimer: 300, // first power-up after 5s
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
	dodgeEvent := [2]bool{}
	jumpEvent := [2]bool{}
	for i, p := range m.players {
		p.mu.Lock()
		inputs[i] = p.Keys
		// Drain events: attacks go to the attack queue, dodge/jump set one-shot flags.
		for _, ev := range p.attackEvents {
			switch ev {
			case "dodge":
				dodgeEvent[i] = true
			case "jump":
				jumpEvent[i] = true
			default:
				m.states[i].queueAttack(ev)
			}
		}
		p.attackEvents = p.attackEvents[:0]
		p.mu.Unlock()
	}

	for i := 0; i < 2; i++ {
		m.updatePlayer(i, inputs[i], m.prevKeys[i], dodgeEvent[i], jumpEvent[i])
	}
	m.prevKeys = inputs

	// Power-up spawning
	m.spawnTimer--
	if m.spawnTimer <= 0 && len(m.powerUps) < MaxPowerUps {
		m.spawnTimer = PowerUpSpawnTicks
		kinds := []string{"speed", "damage", "shoot"}
		m.powerUps = append(m.powerUps, &PowerUp{
			ID:   m.powerUpSeq,
			X:    150 + rand.Float64()*(MapWidth-300),
			Y:    GroundY - PlayerH - 18,
			Kind: kinds[rand.Intn(2)],
		})
		m.powerUpSeq++
	}

	// Power-up collection
	var remaining []*PowerUp
	for _, pu := range m.powerUps {
		collected := false
		for _, s := range m.states {
			if s.State == StateKO {
				continue
			}
			cx := s.X + PlayerW/2
			cy := s.Y + PlayerH/2
			dx := cx - pu.X
			dy := cy - pu.Y
			if math.Sqrt(dx*dx+dy*dy) < PowerUpCollectR {
				switch pu.Kind {
				case "speed":
					s.SpeedBuff = PowerUpBuffTicks
				case "damage":
					s.DamageBuff = PowerUpBuffTicks
				case "shoot":
					s.ShootBuff += ShootBuffShots // stackable
				}
				collected = true
				break
			}
		}
		if !collected {
			remaining = append(remaining, pu)
		}
	}
	m.powerUps = remaining

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
		if s.DamageBuff > 0 {
			damage = int(float64(damage) * PowerUpBuffMult)
		}
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

		// Knockback — uppercut launches opponent upward dramatically
		kbDir := float64(s.Facing)
		if s.State == StateAttackUppercut {
			opp.vx = kbDir * 1.5  // minimal horizontal — it's a vertical move
			opp.vy = -11.5        // near jump velocity: sends them airborne
			if opp.State != StateBlocking {
				opp.State = StateHurt
				opp.actionTimer = 55 // fib: stays stunned through full flight arc
			}
		} else {
			opp.vx = kbDir * 4.0
			opp.vy = -3.2
			if opp.State != StateBlocking {
				opp.State = StateHurt
				opp.actionTimer = 9 // 0.15s at 60fps
			}
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

	// Projectile movement + collision
	var liveProj []*Projectile
	for _, proj := range m.projectiles {
		proj.X += proj.VX
		if proj.X < -50 || proj.X > MapWidth+50 {
			continue // off-screen, discard
		}
		hit := false
		for _, s := range m.states {
			if s.ID == proj.OwnerID || s.State == StateKO {
				continue
			}
			if proj.X+10 > s.X && proj.X-10 < s.X+PlayerW &&
				proj.Y+10 > s.Y && proj.Y-10 < s.Y+PlayerH {
				dmg := ProjectileDamage
				if m.states[proj.OwnerID].DamageBuff > 0 {
					dmg = int(float64(dmg) * PowerUpBuffMult)
				}
				if s.State == StateBlocking {
					dmg = dmg / 4
					if dmg < 1 {
						dmg = 1
					}
				}
				s.HP -= dmg
				if s.HP < 0 {
					s.HP = 0
				}
				kbDir := proj.VX / math.Abs(proj.VX)
				s.vx = kbDir * 5.0
				s.vy = -2.5
				if s.State != StateBlocking {
					s.State = StateHurt
					s.actionTimer = 28
				}
				if s.HP <= 0 {
					s.HP = 0
					s.State = StateKO
					m.winner = m.states[proj.OwnerID].Name
				}
				hit = true
				break
			}
		}
		if !hit {
			liveProj = append(liveProj, proj)
		}
	}
	m.projectiles = liveProj

	// Prevent players from walking through each other
	m.resolveOverlap()
}

func (m *Match) updatePlayer(idx int, keys Keys, prevKeys Keys, dodgeEvent bool, jumpEvent bool) {
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
	if s.SpeedBuff > 0 {
		s.SpeedBuff--
	}
	if s.DamageBuff > 0 {
		s.DamageBuff--
	}
	// ShootBuff is a shot count, not a timer — don't decrement here.

	onGround := s.Y >= GroundY-PlayerH-1

	// --- KO ---
	if s.State == StateKO {
		s.vy += Gravity
		if s.vy > MaxFallSpeed {
			s.vy = MaxFallSpeed
		}
		s.Y += s.vy
		s.vx *= 0.87 // ≈ 0.75^(1/2) — same per-second decay at 60fps
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
		s.vx *= 0.84 // ≈ 0.70^(1/2)
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
		s.vx *= 0.90
		s.X += s.vx
		clampX(s)

		if s.AttackActive && s.AttackBox != nil {
			updateAttackBoxPos(s)
		}

		// Edge-detect newly pressed attacks and enqueue each independently.
		// Using if/if/if (not else-if) so all three can queue in the same tick.
		if keys.Uppercut && !prevKeys.Uppercut && s.cooldowns["uppercut"] <= 0 {
			s.queueAttack(StateAttackUppercut)
		}
		if keys.Leg && !prevKeys.Leg && s.cooldowns["leg"] <= 0 {
			s.queueAttack(StateAttackLeg)
		}
		if keys.Fist && !prevKeys.Fist && s.cooldowns["fist"] <= 0 {
			s.queueAttack(StateAttackFist)
		}

		// Chain immediately if the hit already connected — no need to wait for timer.
		if !s.AttackActive {
			if next := s.dequeueAttack(); next != "" {
				startAttack(s, next)
				return
			}
		}

		if s.actionTimer <= 0 {
			s.State = StateIdle
			s.AttackActive = false
			s.AttackBox = nil
			// Fire next queued attack on the same tick the animation finishes.
			if next := s.dequeueAttack(); next != "" {
				startAttack(s, next)
			}
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

	// Dodge (event-driven: triggered by a keydown event, not held key state)
	if dodgeEvent && s.cooldowns["dodge"] <= 0 {
		opp := m.states[1-idx]
		dashDir := -float64(s.Facing) // dash away from opponent
		if opp.X+PlayerW/2 > s.X+PlayerW/2 {
			dashDir = -1
		} else {
			dashDir = 1
		}
		s.vx = dashDir * 6.4
		s.State = StateDodging
		s.dodgeInvincible = true
		s.actionTimer = 36  // doubled ticks = same 0.6s
		s.cooldowns["dodge"] = 96
		return
	}

	// Fire projectile
	if keys.Shoot && s.ShootBuff > 0 && s.cooldowns["shoot"] <= 0 {
		centerY := s.Y + PlayerH/2
		vx := ProjectileSpeed * float64(s.Facing)
		startX := s.X + PlayerW/2
		m.projectiles = append(m.projectiles, &Projectile{
			ID:      m.projSeq,
			X:       startX,
			Y:       centerY,
			VX:      vx,
			OwnerID: idx,
		})
		m.projSeq++
		s.ShootBuff--
		s.cooldowns["shoot"] = ShootCooldownTicks
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

	// Movement (speed buff applies here)
	speed := MoveSpeed
	if s.SpeedBuff > 0 {
		speed = MoveSpeed * PowerUpBuffMult
	}
	moving := false
	if keys.Left {
		s.vx = -speed
		moving = true
	} else if keys.Right {
		s.vx = speed
		moving = true
	} else {
		s.vx *= 0.81 // ≈ 0.65^(1/2)
		if math.Abs(s.vx) < 0.15 {
			s.vx = 0
		}
	}

	// Jump (event-driven: triggered by a keydown event, not held key state)
	if jumpEvent && onGround {
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

	// Durations and cooldowns doubled (ticks) — same real-world seconds at 60fps
	switch attackState {
	case StateAttackFist:
		duration, cooldown = 9, 56
		aw, ah, ayOffset = 36, 21, 12
	case StateAttackLeg:
		duration, cooldown = 11, 76
		aw, ah, ayOffset = 42, 27, 21
	case StateAttackUppercut:
		duration, cooldown = 14, 110
		aw, ah, ayOffset = 30, 36, -3
		s.vy = -4.0 // small hop
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
		ayOffset = 12
	case StateAttackLeg:
		ayOffset = 21
	case StateAttackUppercut:
		ayOffset = -3
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
		Phase:       m.phase,
		Countdown:   m.countdown,
		Players:     m.states,
		Winner:      m.winner,
		Tick:        m.tick,
		PowerUps:    m.powerUps,
		Projectiles: m.projectiles,
	}
	// Marshal once, send the same bytes to both players
	data, err := json.Marshal(map[string]interface{}{"type": "state", "state": snap})
	if err != nil {
		return
	}
	for _, p := range m.players {
		p.SendBytes(data)
	}
	// Fan the same bytes to every spectator watching on the menu page.
	m.hub.BroadcastSpectators(data)
}

func (m *Match) broadcast(msg interface{}) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	for _, p := range m.players {
		p.SendBytes(data)
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
