package game

import (
	"math"
	"testing"
)

// ── Test helpers ──────────────────────────────────────────────────────────────

// newTestPlayer creates a minimal Player with no WebSocket or Hub.
// The send channel is buffered so Send/SendBytes never block during tests.
func newTestPlayer(name string) *Player {
	return &Player{
		Name: name,
		send: make(chan []byte, 256),
	}
}

// newTestHub returns a Hub whose goroutine is NOT started. Safe to pass to
// NewMatch in tests — BroadcastSpectators is non-blocking and drops silently.
func newTestHub() *Hub {
	return NewHub()
}

// newFightingMatch creates a Match already in the fighting phase so tests can
// call m.update() / m.updatePlayer() directly without running the goroutine.
func newFightingMatch() (*Match, *PlayerState, *PlayerState) {
	p1 := newTestPlayer("Alice")
	p2 := newTestPlayer("Bob")
	m := NewMatch(p1, p2, newTestHub())
	m.phase = PhaseFighting
	return m, m.states[0], m.states[1]
}

// noKeys returns an empty key state (all buttons released).
func noKeys() Keys { return Keys{} }

// ── Physics ───────────────────────────────────────────────────────────────────

func TestGravityAccumulates(t *testing.T) {
	s := &PlayerState{
		Y:         100,
		vy:        0,
		cooldowns: make(map[string]int),
		State:     StateIdle,
	}
	before := s.vy
	applyGravity(s)
	if s.vy <= before {
		t.Errorf("gravity should increase vy: got %f, was %f", s.vy, before)
	}
	if s.Y <= 100 {
		t.Errorf("gravity should move player down: got Y=%f", s.Y)
	}
}

func TestGravityCapAtMaxFallSpeed(t *testing.T) {
	s := &PlayerState{
		Y:  100,
		vy: MaxFallSpeed + 10, // already above cap
		cooldowns: make(map[string]int),
	}
	applyGravity(s)
	if s.vy > MaxFallSpeed {
		t.Errorf("vy should be capped at MaxFallSpeed, got %f", s.vy)
	}
}

func TestGroundClamp(t *testing.T) {
	s := &PlayerState{
		Y:         GroundY, // at or below ground
		vy:        5,
		cooldowns: make(map[string]int),
	}
	applyGravity(s)
	if s.Y > GroundY-PlayerH {
		t.Errorf("player should be clamped to ground, got Y=%f", s.Y)
	}
	if s.vy != 0 {
		t.Errorf("vy should be zeroed on ground, got %f", s.vy)
	}
}

func TestClampXLeftWall(t *testing.T) {
	s := &PlayerState{X: -10, vx: -3, cooldowns: make(map[string]int)}
	clampX(s)
	if s.X != 0 {
		t.Errorf("X should be clamped to 0, got %f", s.X)
	}
	if s.vx != 0 {
		t.Errorf("vx should be zeroed at left wall, got %f", s.vx)
	}
}

func TestClampXRightWall(t *testing.T) {
	s := &PlayerState{X: MapWidth, vx: 3, cooldowns: make(map[string]int)}
	clampX(s)
	if s.X != MapWidth-PlayerW {
		t.Errorf("X should be clamped to right boundary, got %f", s.X)
	}
	if s.vx != 0 {
		t.Errorf("vx should be zeroed at right wall, got %f", s.vx)
	}
}

func TestJumpOnlyFromGround(t *testing.T) {
	m, s0, _ := newFightingMatch()
	s0.Y = GroundY - PlayerH // on ground
	s0.vy = 0

	m.updatePlayer(0, Keys{Jump: true})

	if s0.vy >= 0 {
		t.Errorf("jump should give negative vy (upward), got %f", s0.vy)
	}
}

func TestNoJumpInAir(t *testing.T) {
	m, s0, _ := newFightingMatch()
	s0.Y = 100 // airborne
	s0.vy = 0

	m.updatePlayer(0, Keys{Jump: true})

	// vy should only change from gravity, not jump
	if s0.vy == JumpVel {
		t.Errorf("player should not be able to jump while airborne")
	}
}

// ── Movement ──────────────────────────────────────────────────────────────────

func TestMovementSetsVX(t *testing.T) {
	m, s0, _ := newFightingMatch()
	s0.Y = GroundY - PlayerH

	m.updatePlayer(0, Keys{Right: true})
	if s0.vx != MoveSpeed {
		t.Errorf("right key: expected vx=%f, got %f", MoveSpeed, s0.vx)
	}

	m.updatePlayer(0, Keys{Left: true})
	if s0.vx != -MoveSpeed {
		t.Errorf("left key: expected vx=%f, got %f", -MoveSpeed, s0.vx)
	}
}

func TestIdleDecelerates(t *testing.T) {
	m, s0, _ := newFightingMatch()
	s0.Y = GroundY - PlayerH
	s0.vx = 10

	m.updatePlayer(0, noKeys())

	if math.Abs(s0.vx) >= 10 {
		t.Errorf("vx should decelerate when no key pressed, got %f", s0.vx)
	}
}

func TestStateWalkingWhenMoving(t *testing.T) {
	m, s0, _ := newFightingMatch()
	s0.Y = GroundY - PlayerH

	m.updatePlayer(0, Keys{Right: true})
	if s0.State != StateWalking {
		t.Errorf("expected walking state, got %s", s0.State)
	}
}

func TestStateJumpingWhenAirborne(t *testing.T) {
	m, s0, _ := newFightingMatch()
	s0.Y = 100 // airborne

	m.updatePlayer(0, noKeys())
	if s0.State != StateJumping {
		t.Errorf("expected jumping state when airborne, got %s", s0.State)
	}
}

// ── Attack damage ─────────────────────────────────────────────────────────────

func TestAttackDamageFist(t *testing.T) {
	if d := attackDamage(StateAttackFist); d != 10 {
		t.Errorf("fist damage: want 10, got %d", d)
	}
}

func TestAttackDamageLeg(t *testing.T) {
	if d := attackDamage(StateAttackLeg); d != 15 {
		t.Errorf("leg damage: want 15, got %d", d)
	}
}

func TestAttackDamageUppercut(t *testing.T) {
	if d := attackDamage(StateAttackUppercut); d != 25 {
		t.Errorf("uppercut damage: want 25, got %d", d)
	}
}

// ── Combat resolution ─────────────────────────────────────────────────────────

// placeAdjacent sets up s0 (attacker) directly to the left of s1 (defender)
// with a live attack box that already overlaps the defender.
func placeAdjacent(s0, s1 *PlayerState) {
	s0.X = 200
	s0.Y = GroundY - PlayerH
	s0.Facing = 1
	s1.X = s0.X + PlayerW + 5 // just to the right, within fist range
	s1.Y = GroundY - PlayerH
}

func TestFistHitsAndDealsDamage(t *testing.T) {
	m, s0, s1 := newFightingMatch()
	placeAdjacent(s0, s1)
	startAttack(s0, StateAttackFist)
	beforeHP := s1.HP

	m.update()

	if s1.HP >= beforeHP {
		t.Errorf("defender should have lost HP: before=%d, after=%d", beforeHP, s1.HP)
	}
	if s1.HP != beforeHP-10 {
		t.Errorf("fist should deal 10 damage: before=%d, after=%d", beforeHP, s1.HP)
	}
}

func TestBlockReducesDamageBy75Percent(t *testing.T) {
	m, s0, s1 := newFightingMatch()
	placeAdjacent(s0, s1)
	startAttack(s0, StateAttackFist) // 10 damage → 10/4 = 2 blocked
	s1.State = StateBlocking
	m.players[1].Keys.Block = true // keep s1 in block during updatePlayer
	beforeHP := s1.HP

	m.update()

	expectedDamage := 10 / 4 // = 2
	if s1.HP != beforeHP-expectedDamage {
		t.Errorf("blocked fist: want %d damage, got %d", expectedDamage, beforeHP-s1.HP)
	}
}

func TestBlockedHitNoHurtState(t *testing.T) {
	m, s0, s1 := newFightingMatch()
	placeAdjacent(s0, s1)
	startAttack(s0, StateAttackFist)
	s1.State = StateBlocking
	m.players[1].Keys.Block = true // keep s1 in block during updatePlayer

	m.update()

	if s1.State == StateHurt {
		t.Error("blocking player should not enter hurt state")
	}
}

func TestAttackHitsOnlyOnce(t *testing.T) {
	m, s0, s1 := newFightingMatch()
	placeAdjacent(s0, s1)
	startAttack(s0, StateAttackFist)
	hpBefore := s1.HP

	m.update() // first tick — hit registered
	hpAfterFirst := s1.HP

	m.update() // second tick — attack box should be nil, no second hit
	hpAfterSecond := s1.HP

	if hpAfterFirst >= hpBefore {
		t.Error("attack should have landed on first tick")
	}
	if hpAfterSecond != hpAfterFirst {
		t.Errorf("attack should not hit again: HP went from %d to %d", hpAfterFirst, hpAfterSecond)
	}
}

func TestKOWhenHPReachesZero(t *testing.T) {
	m, s0, s1 := newFightingMatch()
	placeAdjacent(s0, s1)
	s1.HP = 1 // one hit will KO
	startAttack(s0, StateAttackFist)

	m.update()

	if s1.State != StateKO {
		t.Errorf("defender should be KO, got state=%s HP=%d", s1.State, s1.HP)
	}
	if m.winner != s0.Name {
		t.Errorf("winner should be %s, got %s", s0.Name, m.winner)
	}
}

func TestHPCannotGoBelowZero(t *testing.T) {
	m, s0, s1 := newFightingMatch()
	placeAdjacent(s0, s1)
	s1.HP = 1
	startAttack(s0, StateAttackUppercut) // 25 damage, way more than 1 HP

	m.update()

	if s1.HP < 0 {
		t.Errorf("HP should be clamped to 0, got %d", s1.HP)
	}
}

func TestKnockbackAppliedOnHit(t *testing.T) {
	m, s0, s1 := newFightingMatch()
	placeAdjacent(s0, s1)
	s0.Facing = 1
	startAttack(s0, StateAttackFist)
	s1.vx = 0
	s1.vy = 0

	m.update()

	if s1.vx == 0 && s1.vy == 0 {
		t.Error("hit should apply knockback velocity")
	}
	if s1.vx < 0 {
		t.Errorf("knockback should be in attacker's facing direction (+x), got vx=%f", s1.vx)
	}
}

func TestHurtStunDuration(t *testing.T) {
	m, s0, s1 := newFightingMatch()
	placeAdjacent(s0, s1)
	startAttack(s0, StateAttackFist)

	m.update() // hit lands → s1 enters hurt with actionTimer=36

	if s1.State != StateHurt {
		t.Fatalf("expected hurt state, got %s", s1.State)
	}
	timerAfterHit := s1.actionTimer

	// Run 35 more ticks — should still be hurt
	for i := 0; i < timerAfterHit-1; i++ {
		m.updatePlayer(1, noKeys())
	}
	if s1.State != StateHurt {
		t.Errorf("should still be in hurt state after %d ticks, got %s", timerAfterHit-1, s1.State)
	}

	// One more tick — timer hits 0, transitions to idle
	m.updatePlayer(1, noKeys())
	if s1.State != StateIdle {
		t.Errorf("should transition to idle after hurt expires, got %s", s1.State)
	}
}

func TestDodgeInvincibilityPreventsHit(t *testing.T) {
	m, s0, s1 := newFightingMatch()
	placeAdjacent(s0, s1)
	startAttack(s0, StateAttackFist)
	s1.State = StateDodging
	s1.dodgeInvincible = true
	s1.actionTimer = 36 // keep dodge active for this tick
	hpBefore := s1.HP

	m.update()

	if s1.HP != hpBefore {
		t.Errorf("dodging player should be invincible: HP changed from %d to %d", hpBefore, s1.HP)
	}
}

func TestKOPlayerIgnoresInput(t *testing.T) {
	m, s0, _ := newFightingMatch()
	s0.State = StateKO
	s0.Y = GroundY - PlayerH

	// KO player should not be able to attack
	m.updatePlayer(0, Keys{Fist: true, Left: true, Jump: true})

	if s0.State != StateKO {
		t.Errorf("KO player should stay KO, got %s", s0.State)
	}
}

// ── Attack boxes ──────────────────────────────────────────────────────────────

func TestAttackBoxFacingRight(t *testing.T) {
	s := &PlayerState{
		X: 100, Y: 200, Facing: 1,
		cooldowns: make(map[string]int),
	}
	startAttack(s, StateAttackFist)

	expectedX := s.X + PlayerW
	if s.AttackBox.X != expectedX {
		t.Errorf("fist box facing right: want X=%f, got %f", expectedX, s.AttackBox.X)
	}
}

func TestAttackBoxFacingLeft(t *testing.T) {
	s := &PlayerState{
		X: 300, Y: 200, Facing: -1,
		cooldowns: make(map[string]int),
	}
	startAttack(s, StateAttackFist) // aw=36 (see match.go startAttack constants)
	expectedX := s.X - 36
	if s.AttackBox.X != expectedX {
		t.Errorf("fist box facing left: want X=%f, got %f", expectedX, s.AttackBox.X)
	}
}

func TestAttackBoxYOffsets(t *testing.T) {
	cases := []struct {
		state    string
		wantYOff float64
	}{
		{StateAttackFist, 12},      // ayOffset from match.go startAttack
		{StateAttackLeg, 21},
		{StateAttackUppercut, -3},
	}
	for _, c := range cases {
		s := &PlayerState{X: 200, Y: 100, Facing: 1, cooldowns: make(map[string]int)}
		startAttack(s, c.state)
		wantY := s.Y + c.wantYOff
		if s.AttackBox.Y != wantY {
			t.Errorf("%s box Y: want %f, got %f", c.state, wantY, s.AttackBox.Y)
		}
	}
}

func TestUppercutGivesHop(t *testing.T) {
	s := &PlayerState{X: 200, Y: GroundY - PlayerH, Facing: 1, cooldowns: make(map[string]int)}
	startAttack(s, StateAttackUppercut)
	if s.vy >= 0 {
		t.Errorf("uppercut should give upward vy, got %f", s.vy)
	}
}

// ── Cooldowns ─────────────────────────────────────────────────────────────────

func TestCooldownPreventsAttack(t *testing.T) {
	m, s0, _ := newFightingMatch()
	s0.Y = GroundY - PlayerH
	s0.cooldowns["fist"] = 50 // on cooldown

	m.updatePlayer(0, Keys{Fist: true})

	if s0.State == StateAttackFist {
		t.Error("should not be able to attack while on cooldown")
	}
}

func TestCooldownExpiresAndAllowsAttack(t *testing.T) {
	m, s0, _ := newFightingMatch()
	s0.Y = GroundY - PlayerH
	s0.cooldowns["fist"] = 1 // expires after this tick

	m.updatePlayer(0, noKeys()) // tick cooldown down to 0

	m.updatePlayer(0, Keys{Fist: true})
	if s0.State != StateAttackFist {
		t.Errorf("should be able to attack after cooldown expires, got %s", s0.State)
	}
}

func TestAttackPriorityUppercutOverLeg(t *testing.T) {
	m, s0, _ := newFightingMatch()
	s0.Y = GroundY - PlayerH

	// Press both uppercut and leg simultaneously
	m.updatePlayer(0, Keys{Uppercut: true, Leg: true})

	if s0.State != StateAttackUppercut {
		t.Errorf("uppercut should take priority over leg, got %s", s0.State)
	}
}

func TestAttackPriorityLegOverFist(t *testing.T) {
	m, s0, _ := newFightingMatch()
	s0.Y = GroundY - PlayerH

	m.updatePlayer(0, Keys{Leg: true, Fist: true})

	if s0.State != StateAttackLeg {
		t.Errorf("leg should take priority over fist, got %s", s0.State)
	}
}

// ── Dodge ─────────────────────────────────────────────────────────────────────

func TestDodgeSetsInvincible(t *testing.T) {
	m, s0, _ := newFightingMatch()
	s0.Y = GroundY - PlayerH

	m.updatePlayer(0, Keys{Dodge: true})

	if !s0.dodgeInvincible {
		t.Error("dodge should set dodgeInvincible")
	}
	if s0.State != StateDodging {
		t.Errorf("expected dodging state, got %s", s0.State)
	}
}

func TestDodgeCooldownPreventsRepeat(t *testing.T) {
	m, s0, _ := newFightingMatch()
	s0.Y = GroundY - PlayerH
	s0.cooldowns["dodge"] = 50

	m.updatePlayer(0, Keys{Dodge: true})

	if s0.State == StateDodging {
		t.Error("should not dodge while on cooldown")
	}
}

func TestDodgeInvincibilityClears(t *testing.T) {
	m, s0, _ := newFightingMatch()
	s0.State = StateDodging
	s0.dodgeInvincible = true
	s0.actionTimer = 1 // expires next tick

	m.updatePlayer(0, noKeys())

	if s0.dodgeInvincible {
		t.Error("dodgeInvincible should clear when dodge ends")
	}
	if s0.State != StateIdle {
		t.Errorf("should return to idle after dodge, got %s", s0.State)
	}
}

// ── Blocking ──────────────────────────────────────────────────────────────────

func TestBlockOnGroundOnly(t *testing.T) {
	m, s0, _ := newFightingMatch()
	s0.Y = 100 // airborne

	m.updatePlayer(0, Keys{Block: true})

	if s0.State == StateBlocking {
		t.Error("should not be able to block while airborne")
	}
}

func TestBlockReleasedExitsState(t *testing.T) {
	m, s0, _ := newFightingMatch()
	s0.State = StateBlocking

	m.updatePlayer(0, noKeys()) // Block key not held

	if s0.State == StateBlocking {
		t.Error("blocking should end when block key released")
	}
}

// ── Auto-facing ───────────────────────────────────────────────────────────────

func TestAutoFacingTowardOpponent(t *testing.T) {
	m, s0, s1 := newFightingMatch()
	// s0 on left, s1 on right — s0 should face right (+1), s1 face left (-1)
	s0.X = 100
	s1.X = 500

	m.update()

	if s0.Facing != 1 {
		t.Errorf("s0 should face right (+1), got %d", s0.Facing)
	}
	if s1.Facing != -1 {
		t.Errorf("s1 should face left (-1), got %d", s1.Facing)
	}
}

func TestKOPlayerDoesNotAutoFace(t *testing.T) {
	m, s0, _ := newFightingMatch()
	s0.State = StateKO
	s0.Facing = -1 // facing left
	s0.X = 100
	m.states[1].X = 500 // opponent is to the right

	m.update()

	if s0.Facing != -1 {
		t.Errorf("KO player should not auto-face, got %d", s0.Facing)
	}
}

// ── Overlap resolution ────────────────────────────────────────────────────────

func TestOverlapResolutionPushesApart(t *testing.T) {
	m, s0, s1 := newFightingMatch()
	// Place players overlapping
	s0.X = 200
	s1.X = 200 + PlayerW/2 // heavily overlapping

	m.resolveOverlap()

	if math.Abs(s0.X-s1.X) < PlayerW {
		t.Errorf("players still overlapping after resolution: s0.X=%f s1.X=%f", s0.X, s1.X)
	}
}

func TestNoOverlapNoChange(t *testing.T) {
	m, s0, s1 := newFightingMatch()
	s0.X = 100
	s1.X = 300 // far apart
	origX0, origX1 := s0.X, s1.X

	m.resolveOverlap()

	if s0.X != origX0 || s1.X != origX1 {
		t.Errorf("positions should not change when not overlapping")
	}
}

// ── Rect overlap ─────────────────────────────────────────────────────────────

func TestRectsOverlapTrue(t *testing.T) {
	ab := &AttackBox{X: 10, Y: 10, W: 50, H: 50}
	if !rectsOverlap(ab, 30, 30, 50, 50) {
		t.Error("overlapping rects should return true")
	}
}

func TestRectsOverlapFalseHorizontal(t *testing.T) {
	ab := &AttackBox{X: 0, Y: 0, W: 10, H: 10}
	if rectsOverlap(ab, 20, 0, 10, 10) {
		t.Error("non-overlapping (horizontal gap) should return false")
	}
}

func TestRectsOverlapFalseVertical(t *testing.T) {
	ab := &AttackBox{X: 0, Y: 0, W: 10, H: 10}
	if rectsOverlap(ab, 0, 20, 10, 10) {
		t.Error("non-overlapping (vertical gap) should return false")
	}
}

func TestRectsOverlapEdgeTouching(t *testing.T) {
	// Edges touching exactly — should NOT overlap (strict <)
	ab := &AttackBox{X: 0, Y: 0, W: 10, H: 10}
	if rectsOverlap(ab, 10, 0, 10, 10) {
		t.Error("edge-touching rects should not overlap")
	}
}

// ── PlayerLeft ────────────────────────────────────────────────────────────────

func TestPlayerLeftDuringFightingAwardsWin(t *testing.T) {
	GlobalLeaderboard.mu.Lock()
	GlobalLeaderboard.wins = make(map[string]int)
	GlobalLeaderboard.cachedTop5 = nil
	GlobalLeaderboard.mu.Unlock()

	p1 := newTestPlayer("Alice")
	p2 := newTestPlayer("Bob")
	m := NewMatch(p1, p2, newTestHub())
	m.phase = PhaseFighting

	m.PlayerLeft(p1) // Alice disconnects

	if m.winner != p2.Name {
		t.Errorf("Bob should win on Alice disconnect, got winner=%s", m.winner)
	}
	if m.phase != PhaseGameOver {
		t.Errorf("match should be gameover, got %s", m.phase)
	}
}

func TestPlayerLeftDuringCountdownAwardsWin(t *testing.T) {
	p1 := newTestPlayer("Alice")
	p2 := newTestPlayer("Bob")
	m := NewMatch(p1, p2, newTestHub())
	m.phase = PhaseCountdown

	m.PlayerLeft(p1)

	if m.winner != p2.Name {
		t.Errorf("Bob should win on disconnect during countdown, got %s", m.winner)
	}
}

func TestPlayerLeftAfterGameoverNoWinChange(t *testing.T) {
	p1 := newTestPlayer("Alice")
	p2 := newTestPlayer("Bob")
	m := NewMatch(p1, p2, newTestHub())
	m.phase = PhaseGameOver
	m.winner = "Bob" // already decided

	m.PlayerLeft(p1)

	if m.winner != "Bob" {
		t.Errorf("winner should not change after gameover, got %s", m.winner)
	}
}

// ── NewMatch initialisation ───────────────────────────────────────────────────

func TestNewMatchStartsInCountdown(t *testing.T) {
	p1 := newTestPlayer("Alice")
	p2 := newTestPlayer("Bob")
	m := NewMatch(p1, p2, newTestHub())

	if m.phase != PhaseCountdown {
		t.Errorf("match should start in countdown, got %s", m.phase)
	}
	if m.countdown != 3 {
		t.Errorf("countdown should start at 3, got %d", m.countdown)
	}
}

func TestNewMatchAssignsPlayerIDs(t *testing.T) {
	p1 := newTestPlayer("Alice")
	p2 := newTestPlayer("Bob")
	NewMatch(p1, p2, newTestHub())

	if p1.ID != 0 {
		t.Errorf("p1 should have ID 0, got %d", p1.ID)
	}
	if p2.ID != 1 {
		t.Errorf("p2 should have ID 1, got %d", p2.ID)
	}
}

func TestNewMatchStartPositions(t *testing.T) {
	p1 := newTestPlayer("Alice")
	p2 := newTestPlayer("Bob")
	m := NewMatch(p1, p2, newTestHub())

	s0, s1 := m.states[0], m.states[1]

	if s0.X >= s1.X {
		t.Errorf("p1 should start to the left of p2: s0.X=%f s1.X=%f", s0.X, s1.X)
	}
	if s0.HP != 100 || s1.HP != 100 {
		t.Errorf("both players should start at 100 HP: %d %d", s0.HP, s1.HP)
	}
	if s0.Facing != 1 || s1.Facing != -1 {
		t.Errorf("facings wrong: s0=%d s1=%d", s0.Facing, s1.Facing)
	}
}
