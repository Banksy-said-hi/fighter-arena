package game

import (
	"encoding/json"
	"net/http"
	"sort"
	"sync"
)

type LeaderboardEntry struct {
	Rank int    `json:"rank"`
	Name string `json:"name"`
	Wins int    `json:"wins"`
}

type Leaderboard struct {
	mu   sync.RWMutex
	wins map[string]int
}

var GlobalLeaderboard = &Leaderboard{
	wins: make(map[string]int),
}

func (lb *Leaderboard) RecordWin(name string) {
	lb.mu.Lock()
	defer lb.mu.Unlock()
	lb.wins[name]++
}

func (lb *Leaderboard) Top5() []LeaderboardEntry {
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
