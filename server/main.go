package main

import (
	"log"
	"net/http"
	"os"

	"fighter-game/game"
)

func main() {
	// Init SQLite — use /data/fighter.db on Fly.io (volume mounted there),
	// fallback to local file for development.
	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = "./fighter.db"
	}
	if err := game.InitDB(dbPath); err != nil {
		log.Printf("[db] warning: could not open DB (%v) — running without persistence", err)
	}

	hub := game.NewHub()
	go hub.Run()

	http.Handle("/", http.FileServer(http.Dir("../client")))
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		game.ServeWS(hub, w, r)
	})
	http.HandleFunc("/leaderboard", game.ServeLeaderboard)
	http.HandleFunc("/queue", hub.ServeQueue)

	log.Println("Fighter Arena running → http://localhost:8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}
