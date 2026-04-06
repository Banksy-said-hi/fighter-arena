package main

import (
	"log"
	"net/http"

	"fighter-game/game"
)

func main() {
	hub := game.NewHub()
	go hub.Run()

	http.Handle("/", http.FileServer(http.Dir("../client")))
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		game.ServeWS(hub, w, r)
	})
	http.HandleFunc("/leaderboard", game.ServeLeaderboard)

	log.Println("Fighter Game server running → http://localhost:8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}
