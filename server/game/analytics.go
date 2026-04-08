package game

import (
	"encoding/json"
	"log"
	"net/http"
	"net/netip"
	"sync"
	"time"
)

// ── Analytics rate limiter ────────────────────────────────────────────────────
// Allow each IP at most analyticsMaxReqs requests per analyticsWindow.

const (
	analyticsMaxReqs = 5
	analyticsWindow  = time.Minute
	analyticsMaxBatch = 20 // events per request
)

type ipEntry struct {
	count    int
	windowAt time.Time
}

var (
	analyticsRateMu sync.Mutex
	analyticsRateMap = make(map[netip.Addr]*ipEntry)
)

func analyticsAllowed(r *http.Request) bool {
	addr, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil {
		return true // can't parse — allow through
	}
	ip := addr.Addr().Unmap()

	analyticsRateMu.Lock()
	defer analyticsRateMu.Unlock()

	now := time.Now()
	e, ok := analyticsRateMap[ip]
	if !ok || now.After(e.windowAt.Add(analyticsWindow)) {
		analyticsRateMap[ip] = &ipEntry{count: 1, windowAt: now}
		return true
	}
	e.count++
	return e.count <= analyticsMaxReqs
}

type AnalyticsEvent struct {
	SessionID string `json:"session_id"`
	Event     string `json:"event"`
	Meta      string `json:"meta,omitempty"` // free-form JSON string from client
}

// HandlerAnalytics accepts a batch of events from the client.
// POST /analytics  body: [{session_id, event, meta}, ...]
func HandlerAnalytics(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if !analyticsAllowed(r) {
		http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
		return
	}

	if DB == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 32*1024) // 32 KB max body
	var events []AnalyticsEvent
	if err := json.NewDecoder(r.Body).Decode(&events); err != nil || len(events) == 0 {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if len(events) > analyticsMaxBatch {
		events = events[:analyticsMaxBatch]
	}

	// Resolve user_id from session cookie if present (optional — anonymous events allowed)
	var userID *int64
	if authEnabled {
		if claims, err := getClaimsFromRequest(r); err == nil && claims.UserID > 0 {
			uid := claims.UserID
			userID = &uid
		}
	}

	for _, e := range events {
		if e.SessionID == "" || e.Event == "" {
			continue
		}
		// Limit field lengths to prevent abuse
		if len(e.SessionID) > 64 { e.SessionID = e.SessionID[:64] }
		if len(e.Event) > 64    { e.Event = e.Event[:64] }
		if len(e.Meta) > 512    { e.Meta = e.Meta[:512] }

		if _, err := DB.Exec(
			`INSERT INTO events (user_id, session_id, event, meta) VALUES (?, ?, ?, ?)`,
			userID, e.SessionID, e.Event, nullableString(e.Meta),
		); err != nil {
			log.Printf("[analytics] insert error: %v", err)
		}
	}

	w.WriteHeader(http.StatusNoContent)
}

func nullableString(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}
