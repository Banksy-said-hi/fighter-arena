package game

import (
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"sync"
)

type LeaderboardEntry struct {
	Rank int    `json:"rank"`
	Name string `json:"name"`
	Wins int    `json:"wins"`
}

// Leaderboard keeps an in-memory fallback and writes through to SQLite when available.
type Leaderboard struct {
	mu   sync.RWMutex
	wins map[string]int
}

var GlobalLeaderboard = &Leaderboard{
	wins: make(map[string]int),
}

func (lb *Leaderboard) RecordWin(name string) {
	// Always update in-memory
	lb.mu.Lock()
	lb.wins[name]++
	lb.mu.Unlock()

	// Persist to SQLite
	if DB != nil {
		if _, err := DB.Exec(`
			INSERT INTO wins (name, count) VALUES (?, 1)
			ON CONFLICT(name) DO UPDATE SET
				count = count + 1,
				last_win_at = CURRENT_TIMESTAMP
		`, name); err != nil {
			log.Printf("[db] record win: %v", err)
		}
	}
}

func (lb *Leaderboard) Top5() []LeaderboardEntry {
	// Read from SQLite when available
	if DB != nil {
		rows, err := DB.Query(`
			SELECT name, count FROM wins
			ORDER BY count DESC, name ASC
			LIMIT 5
		`)
		if err != nil {
			log.Printf("[db] top5 query: %v", err)
		} else {
			defer rows.Close()
			var entries []LeaderboardEntry
			rank := 1
			for rows.Next() {
				var e LeaderboardEntry
				if err := rows.Scan(&e.Name, &e.Wins); err == nil {
					e.Rank = rank
					entries = append(entries, e)
					rank++
				}
			}
			return entries
		}
	}

	// Fallback: in-memory
	lb.mu.RLock()
	defer lb.mu.RUnlock()
	entries := make([]LeaderboardEntry, 0, len(lb.wins))
	for name, wins := range lb.wins {
		entries = append(entries, LeaderboardEntry{Name: name, Wins: wins})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Wins != entries[j].Wins {
			return entries[i].Wins > entries[j].Wins
		}
		return entries[i].Name < entries[j].Name
	})
	if len(entries) > 5 {
		entries = entries[:5]
	}
	for i := range entries {
		entries[i].Rank = i + 1
	}
	return entries
}

func ServeLeaderboard(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(GlobalLeaderboard.Top5())
}
