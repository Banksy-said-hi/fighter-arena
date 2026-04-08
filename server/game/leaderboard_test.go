package game

import (
	"sync"
	"testing"
)

// resetLeaderboard wipes state between tests to prevent cross-contamination.
// DB is not reset here — it is never initialised in tests (InitDB is not called),
// so it is already nil and writing DB = nil would race with hub goroutines still
// running in parallel from earlier hub integration tests.
func resetLeaderboard() {
	GlobalLeaderboard.mu.Lock()
	GlobalLeaderboard.wins = make(map[string]int)
	GlobalLeaderboard.cachedTop5 = nil
	GlobalLeaderboard.mu.Unlock()
}

// ── RecordWin ─────────────────────────────────────────────────────────────────

func TestRecordWinIncrementsCount(t *testing.T) {
	resetLeaderboard()
	GlobalLeaderboard.RecordWin("Alice")
	GlobalLeaderboard.RecordWin("Alice")

	GlobalLeaderboard.mu.RLock()
	count := GlobalLeaderboard.wins["Alice"]
	GlobalLeaderboard.mu.RUnlock()

	if count != 2 {
		t.Errorf("expected 2 wins, got %d", count)
	}
}

func TestRecordWinNewPlayer(t *testing.T) {
	resetLeaderboard()
	GlobalLeaderboard.RecordWin("Bob")

	GlobalLeaderboard.mu.RLock()
	count := GlobalLeaderboard.wins["Bob"]
	GlobalLeaderboard.mu.RUnlock()

	if count != 1 {
		t.Errorf("new player should have 1 win, got %d", count)
	}
}

func TestRecordWinInvalidatesCache(t *testing.T) {
	resetLeaderboard()
	// Warm the cache
	GlobalLeaderboard.Top5()

	GlobalLeaderboard.mu.RLock()
	cached := GlobalLeaderboard.cachedTop5
	GlobalLeaderboard.mu.RUnlock()
	if cached == nil {
		t.Fatal("cache should be populated after Top5()")
	}

	// RecordWin should clear it
	GlobalLeaderboard.RecordWin("Alice")

	GlobalLeaderboard.mu.RLock()
	cached = GlobalLeaderboard.cachedTop5
	GlobalLeaderboard.mu.RUnlock()
	if cached != nil {
		t.Error("cache should be nil after RecordWin")
	}
}

// ── Top5 ordering ─────────────────────────────────────────────────────────────

func TestTop5OrderedByWinsDescending(t *testing.T) {
	resetLeaderboard()
	GlobalLeaderboard.RecordWin("Charlie") // 1 win
	GlobalLeaderboard.RecordWin("Alice")   // 3 wins
	GlobalLeaderboard.RecordWin("Alice")
	GlobalLeaderboard.RecordWin("Alice")
	GlobalLeaderboard.RecordWin("Bob")     // 2 wins
	GlobalLeaderboard.RecordWin("Bob")

	entries := GlobalLeaderboard.Top5()

	if len(entries) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(entries))
	}
	if entries[0].Name != "Alice" {
		t.Errorf("rank 1 should be Alice (3 wins), got %s", entries[0].Name)
	}
	if entries[1].Name != "Bob" {
		t.Errorf("rank 2 should be Bob (2 wins), got %s", entries[1].Name)
	}
	if entries[2].Name != "Charlie" {
		t.Errorf("rank 3 should be Charlie (1 win), got %s", entries[2].Name)
	}
}

func TestTop5AlphabeticalTiebreak(t *testing.T) {
	resetLeaderboard()
	// Both have 1 win — should be sorted alphabetically
	GlobalLeaderboard.RecordWin("Zara")
	GlobalLeaderboard.RecordWin("Alice")

	entries := GlobalLeaderboard.Top5()

	if entries[0].Name != "Alice" {
		t.Errorf("tiebreak should be alphabetical: expected Alice first, got %s", entries[0].Name)
	}
}

func TestTop5NeverExceedsFive(t *testing.T) {
	resetLeaderboard()
	players := []string{"A", "B", "C", "D", "E", "F", "G"}
	for _, p := range players {
		GlobalLeaderboard.RecordWin(p)
	}

	entries := GlobalLeaderboard.Top5()

	if len(entries) > 5 {
		t.Errorf("Top5 returned %d entries, max should be 5", len(entries))
	}
}

func TestTop5AssignsCorrectRanks(t *testing.T) {
	resetLeaderboard()
	GlobalLeaderboard.RecordWin("Alice")
	GlobalLeaderboard.RecordWin("Bob")
	GlobalLeaderboard.RecordWin("Alice")

	entries := GlobalLeaderboard.Top5()

	for i, e := range entries {
		if e.Rank != i+1 {
			t.Errorf("entry %d has wrong rank: want %d, got %d", i, i+1, e.Rank)
		}
	}
}

func TestTop5EmptyReturnsEmptySlice(t *testing.T) {
	resetLeaderboard()
	entries := GlobalLeaderboard.Top5()
	if entries == nil {
		// nil is acceptable, but shouldn't panic on len/range
		entries = []LeaderboardEntry{}
	}
	if len(entries) != 0 {
		t.Errorf("empty leaderboard should return 0 entries, got %d", len(entries))
	}
}

// ── Cache behaviour ───────────────────────────────────────────────────────────

func TestTop5ServedFromCacheOnSecondCall(t *testing.T) {
	resetLeaderboard()
	GlobalLeaderboard.RecordWin("Alice")

	first := GlobalLeaderboard.Top5()

	// Cache should now be populated — second call should return same pointer
	GlobalLeaderboard.mu.RLock()
	cached := GlobalLeaderboard.cachedTop5
	GlobalLeaderboard.mu.RUnlock()

	if cached == nil {
		t.Fatal("cache should be populated after first Top5() call")
	}

	second := GlobalLeaderboard.Top5()

	if len(first) != len(second) {
		t.Errorf("cached result should match: first=%d second=%d", len(first), len(second))
	}
}

func TestCacheUpdatesAfterNewWin(t *testing.T) {
	resetLeaderboard()
	GlobalLeaderboard.RecordWin("Alice")
	first := GlobalLeaderboard.Top5() // warms cache

	GlobalLeaderboard.RecordWin("Bob") // invalidates cache

	second := GlobalLeaderboard.Top5() // rebuilds with Bob

	if len(second) <= len(first) {
		t.Errorf("leaderboard should grow after new player wins: before=%d after=%d", len(first), len(second))
	}
	found := false
	for _, e := range second {
		if e.Name == "Bob" {
			found = true
			break
		}
	}
	if !found {
		t.Error("Bob should appear in leaderboard after winning")
	}
}

// ── Concurrency ───────────────────────────────────────────────────────────────

func TestRecordWinConcurrentSafe(t *testing.T) {
	resetLeaderboard()
	// Run with -race flag: this will catch data races
	const goroutines = 50
	var wg sync.WaitGroup
	wg.Add(goroutines)

	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			GlobalLeaderboard.RecordWin("Alice")
		}()
	}
	wg.Wait()

	GlobalLeaderboard.mu.RLock()
	count := GlobalLeaderboard.wins["Alice"]
	GlobalLeaderboard.mu.RUnlock()

	if count != goroutines {
		t.Errorf("concurrent wins: expected %d, got %d", goroutines, count)
	}
}

func TestTop5ConcurrentSafe(t *testing.T) {
	resetLeaderboard()
	GlobalLeaderboard.RecordWin("Alice")

	var wg sync.WaitGroup
	const goroutines = 20
	wg.Add(goroutines * 2)

	// Concurrent reads and writes
	for i := 0; i < goroutines; i++ {
		go func() { defer wg.Done(); GlobalLeaderboard.Top5() }()
		go func() { defer wg.Done(); GlobalLeaderboard.RecordWin("Bob") }()
	}
	wg.Wait()
}
