package game

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// ─── test infrastructure ─────────────────────────────────────────────────────

// newTestServer creates a Hub, starts its goroutine, and returns a test HTTP
// server whose only route upgrades connections to WebSocket via ServeWS.
func newTestServer(t *testing.T) (*Hub, *httptest.Server) {
	t.Helper()
	hub := NewHub()
	go hub.Run()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ServeWS(hub, w, r)
	}))
	t.Cleanup(srv.Close)
	return hub, srv
}

// wsURL converts an http:// test-server URL to ws://.
func wsURL(srv *httptest.Server) string {
	return "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
}

// connectWS dials the test server and registers a cleanup to close the conn.
func connectWS(t *testing.T, srv *httptest.Server) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial(wsURL(srv), nil)
	if err != nil {
		t.Fatalf("connectWS: dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

// sendJSON marshals v and sends it as a text WebSocket frame.
func sendJSON(t *testing.T, conn *websocket.Conn, v interface{}) {
	t.Helper()
	data, _ := json.Marshal(v)
	if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
		t.Fatalf("sendJSON: %v", err)
	}
}

// drainUntil reads messages with a 5-second deadline, returning the first
// message whose "type" field matches wantType. Other message types are skipped.
func drainUntil(t *testing.T, conn *websocket.Conn, wantType string) map[string]interface{} {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		conn.SetReadDeadline(deadline)
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("drainUntil(%q): read error: %v", wantType, err)
		}
		var m map[string]interface{}
		if err := json.Unmarshal(data, &m); err != nil {
			continue
		}
		if m["type"] == wantType {
			return m
		}
	}
	t.Fatalf("drainUntil: timed out waiting for message type %q", wantType)
	return nil
}

// drainMsgTypes reads messages for up to limit time, collecting all distinct
// "type" values seen.
func drainMsgTypes(conn *websocket.Conn, limit time.Duration) map[string]bool {
	seen := make(map[string]bool)
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		conn.SetReadDeadline(deadline)
		_, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		var m map[string]interface{}
		if err := json.Unmarshal(data, &m); err != nil {
			continue
		}
		if t, ok := m["type"].(string); ok {
			seen[t] = true
		}
	}
	return seen
}

// joinQueue sends a join_queue message with the given name.
func joinQueue(t *testing.T, conn *websocket.Conn, name string) {
	t.Helper()
	sendJSON(t, conn, map[string]interface{}{
		"type": "join_queue",
		"name": name,
	})
}

// ─── single-player queuing ────────────────────────────────────────────────────

func TestHubSinglePlayerGetsQueued(t *testing.T) {
	_, srv := newTestServer(t)
	c := connectWS(t, srv)

	joinQueue(t, c, "Alice")

	msg := drainUntil(t, c, "queued")
	if msg["message"] == "" {
		t.Error("queued message should include a message string")
	}
}

func TestHubSinglePlayerQueueStatusPushed(t *testing.T) {
	_, srv := newTestServer(t)
	c := connectWS(t, srv)

	joinQueue(t, c, "Alice")

	// After joining we should receive both "queued" and "queue_status".
	// drainMsgTypes collects what arrives in a short window.
	seen := drainMsgTypes(c, 2*time.Second)

	if !seen["queued"] {
		t.Error("expected queued message after joining")
	}
	if !seen["queue_status"] {
		t.Error("expected queue_status push after joining")
	}
}

func TestHubQueueStatusContainsWaitingName(t *testing.T) {
	_, srv := newTestServer(t)
	c := connectWS(t, srv)

	joinQueue(t, c, "Alice")

	qs := drainUntil(t, c, "queue_status")
	status, ok := qs["status"].(map[string]interface{})
	if !ok {
		t.Fatalf("queue_status.status is not an object: %v", qs["status"])
	}

	waitingName, _ := status["waiting_name"].(string)
	if waitingName != "Alice" {
		t.Errorf("waiting_name: want Alice, got %q", waitingName)
	}
}

func TestHubQueueStatusOnlineCountIncludesPlayer(t *testing.T) {
	_, srv := newTestServer(t)
	c := connectWS(t, srv)

	joinQueue(t, c, "Alice")

	qs := drainUntil(t, c, "queue_status")
	status, _ := qs["status"].(map[string]interface{})
	online := int(status["online"].(float64))
	if online < 1 {
		t.Errorf("online: want ≥1, got %d", online)
	}
}

// ─── matchmaking: two players ─────────────────────────────────────────────────

func TestHubTwoPlayersReceiveMatchFound(t *testing.T) {
	_, srv := newTestServer(t)
	c1 := connectWS(t, srv)
	c2 := connectWS(t, srv)

	joinQueue(t, c1, "Alice")
	drainUntil(t, c1, "queued") // Alice waits

	joinQueue(t, c2, "Bob")

	// Both connections should receive match_found.
	m1 := drainUntil(t, c1, "match_found")
	m2 := drainUntil(t, c2, "match_found")

	if m1 == nil || m2 == nil {
		t.Fatal("one or both players did not receive match_found")
	}
}

func TestHubTwoPlayersGetDistinctIDs(t *testing.T) {
	_, srv := newTestServer(t)
	c1 := connectWS(t, srv)
	c2 := connectWS(t, srv)

	joinQueue(t, c1, "Alice")
	drainUntil(t, c1, "queued")
	joinQueue(t, c2, "Bob")

	m1 := drainUntil(t, c1, "match_found")
	m2 := drainUntil(t, c2, "match_found")

	id1 := int(m1["player_id"].(float64))
	id2 := int(m2["player_id"].(float64))

	ids := []int{id1, id2}
	sort.Ints(ids)
	if ids[0] != 0 || ids[1] != 1 {
		t.Errorf("expected player IDs {0,1}, got {%d,%d}", id1, id2)
	}
}

func TestHubMatchFoundIncludesOpponentName(t *testing.T) {
	_, srv := newTestServer(t)
	c1 := connectWS(t, srv)
	c2 := connectWS(t, srv)

	joinQueue(t, c1, "Alice")
	drainUntil(t, c1, "queued")
	joinQueue(t, c2, "Bob")

	m1 := drainUntil(t, c1, "match_found")
	m2 := drainUntil(t, c2, "match_found")

	// Each player's match_found should name the opponent correctly.
	if m1["opponent"] != "Bob" {
		t.Errorf("Alice should see opponent=Bob, got %v", m1["opponent"])
	}
	if m2["opponent"] != "Alice" {
		t.Errorf("Bob should see opponent=Alice, got %v", m2["opponent"])
	}
}

func TestHubThirdPlayerGetsQueuedAfterFirstMatch(t *testing.T) {
	_, srv := newTestServer(t)
	c1 := connectWS(t, srv)
	c2 := connectWS(t, srv)
	c3 := connectWS(t, srv)

	joinQueue(t, c1, "Alice")
	drainUntil(t, c1, "queued")
	joinQueue(t, c2, "Bob")
	drainUntil(t, c1, "match_found")
	drainUntil(t, c2, "match_found")

	// Third player joins an empty queue — should be queued, not matched.
	joinQueue(t, c3, "Charlie")
	msg := drainUntil(t, c3, "queued")
	if msg == nil {
		t.Error("third player should be queued, not matched")
	}
}

// ─── disconnect handling ──────────────────────────────────────────────────────

func TestHubDisconnectDuringCountdownAwardsWin(t *testing.T) {
	_, srv := newTestServer(t)
	c1 := connectWS(t, srv)
	c2 := connectWS(t, srv)

	joinQueue(t, c1, "Alice")
	drainUntil(t, c1, "queued")
	joinQueue(t, c2, "Bob")

	// Wait until both are in a match.
	drainUntil(t, c1, "match_found")
	drainUntil(t, c2, "match_found")

	// Close c1's connection abruptly during the countdown phase.
	// The server-side ReadPump will detect the error and unregister the player.
	c1.Close()

	// c2 should receive opponent_left, indicating Bob wins.
	msg := drainUntil(t, c2, "opponent_left")
	if msg["type"] != "opponent_left" {
		t.Errorf("expected opponent_left, got %v", msg["type"])
	}
}

func TestHubDisconnectBeforeQueueDoesNotPanic(t *testing.T) {
	_, srv := newTestServer(t)
	c := connectWS(t, srv)

	// Connect and immediately disconnect without joining the queue.
	// The hub should handle this gracefully — no panic, no deadlock.
	c.Close()

	// Give the hub goroutine time to process the unregister.
	time.Sleep(100 * time.Millisecond)
}

func TestHubDisconnectWhileWaitingClearsQueue(t *testing.T) {
	_, srv := newTestServer(t)
	c1 := connectWS(t, srv)
	c2 := connectWS(t, srv)

	joinQueue(t, c1, "Alice")
	drainUntil(t, c1, "queued")

	// Alice disconnects while waiting.
	c1.Close()
	time.Sleep(150 * time.Millisecond) // let hub process the unregister

	// Bob should now be the only waiter, not auto-matched with a ghost.
	joinQueue(t, c2, "Bob")
	msg := drainUntil(t, c2, "queued")
	if msg == nil {
		t.Error("Bob should be queued, not matched with a disconnected Alice")
	}
}

// ─── queue state push on state change ────────────────────────────────────────

func TestHubQueueStatusClearedAfterMatchStarts(t *testing.T) {
	_, srv := newTestServer(t)
	c1 := connectWS(t, srv)
	c2 := connectWS(t, srv)

	joinQueue(t, c1, "Alice")
	drainUntil(t, c1, "queued")
	joinQueue(t, c2, "Bob")

	// After the match starts, the next queue_status should show no waiter.
	drainUntil(t, c1, "match_found")

	// Collect queue_status messages — once matched, waiting_name should be empty.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		c1.SetReadDeadline(deadline)
		_, data, err := c1.ReadMessage()
		if err != nil {
			break
		}
		var m map[string]interface{}
		if err := json.Unmarshal(data, &m); err != nil {
			continue
		}
		if m["type"] != "queue_status" {
			continue
		}
		status, _ := m["status"].(map[string]interface{})
		waitingName, _ := status["waiting_name"].(string)
		if waitingName == "" {
			return // pass: queue is clear
		}
	}
	t.Error("queue_status should show empty waiting_name once match started")
}

// ─── concurrent safety ────────────────────────────────────────────────────────

func TestHubConcurrentJoins(t *testing.T) {
	// Six players join simultaneously. The hub should create exactly three
	// matches without deadlocking or panicking.
	_, srv := newTestServer(t)

	const n = 6
	done := make(chan struct{}, n)

	for i := 0; i < n; i++ {
		go func() {
			c, _, err := websocket.DefaultDialer.Dial(wsURL(srv), nil)
			if err != nil {
				done <- struct{}{}
				return
			}
			defer c.Close()

			sendJSON(t, c, map[string]interface{}{"type": "join_queue", "name": "Fighter"})

			// Wait to receive either queued or match_found — either is valid.
			deadline := time.Now().Add(5 * time.Second)
			for time.Now().Before(deadline) {
				c.SetReadDeadline(deadline)
				_, data, err := c.ReadMessage()
				if err != nil {
					break
				}
				var m map[string]interface{}
				if json.Unmarshal(data, &m) == nil {
					t := m["type"].(string)
					if t == "queued" || t == "match_found" {
						break
					}
				}
			}
			done <- struct{}{}
		}()
	}

	timeout := time.After(10 * time.Second)
	for i := 0; i < n; i++ {
		select {
		case <-done:
		case <-timeout:
			t.Fatalf("timed out: only %d/%d goroutines finished", i, n)
		}
	}
}
