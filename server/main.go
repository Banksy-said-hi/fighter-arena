package main

import (
	"compress/gzip"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"fighter-game/game"
)

func main() {
	// Init SQLite
	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = "./fighter.db"
	}
	if err := game.InitDB(dbPath); err != nil {
		log.Printf("[db] warning: could not open DB (%v) — running without persistence", err)
	}

	// Init Google OAuth2 (no-op if env vars are absent — falls back to name-input)
	game.InitAuth(
		os.Getenv("GOOGLE_CLIENT_ID"),
		os.Getenv("GOOGLE_CLIENT_SECRET"),
		os.Getenv("JWT_SECRET"),
		os.Getenv("BASE_URL"),
	)

	hub := game.NewHub()
	go hub.Run()

	mux := http.NewServeMux()

	// Static files — with gzip + cache headers
	mux.Handle("/", staticHandler(http.Dir("../client")))

	// Game endpoints
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		game.ServeWS(hub, w, r)
	})
	mux.HandleFunc("/leaderboard", game.ServeLeaderboard)
	mux.HandleFunc("/queue", hub.ServeQueue)

	// Analytics
	mux.HandleFunc("/analytics", game.HandlerAnalytics)

	// Auth endpoints
	mux.HandleFunc("/auth/google", game.HandlerGoogleLogin)
	mux.HandleFunc("/auth/callback", game.HandlerGoogleCallback)
	mux.HandleFunc("/auth/me", game.HandlerMe)
	mux.HandleFunc("/auth/nickname", game.HandlerSetNickname)
	mux.HandleFunc("/auth/logout", game.HandlerLogout)

	log.Println("Fighter Arena running → http://localhost:8080")
	log.Fatal(http.ListenAndServe(":8080", securityHeaders(mux)))
}

// gzipPool reuses gzip writers to avoid per-request allocations.
var gzipPool = sync.Pool{
	New: func() interface{} { w, _ := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed); return w },
}

type gzipResponseWriter struct {
	http.ResponseWriter
	gz *gzip.Writer
}

func (g *gzipResponseWriter) Write(b []byte) (int, error) { return g.gz.Write(b) }

// staticHandler wraps the file server with gzip compression and cache headers.
func staticHandler(root http.FileSystem) http.Handler {
	fs := http.FileServer(root)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ext := strings.ToLower(filepath.Ext(r.URL.Path))

		// Cache-Control
		switch ext {
		case ".woff2", ".woff", ".ttf", ".svg", ".ico":
			w.Header().Set("Cache-Control", "public, max-age=3600")
		case ".js", ".css", ".png":
			w.Header().Set("Cache-Control", "no-cache")
		default:
			w.Header().Set("Cache-Control", "no-cache")
		}

		// Gzip for compressible types
		if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") &&
			(ext == ".js" || ext == ".css" || ext == ".html" || ext == ".json" || ext == ".svg") {
			gz := gzipPool.Get().(*gzip.Writer)
			gz.Reset(w)
			defer func() { gz.Close(); gzipPool.Put(gz) }()
			w.Header().Set("Content-Encoding", "gzip")
			w.Header().Del("Content-Length") // length changes after compression
			fs.ServeHTTP(&gzipResponseWriter{ResponseWriter: w, gz: gz}, r)
			return
		}

		fs.ServeHTTP(w, r)
	})
}

// securityHeaders adds defensive HTTP headers to every response.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		// CSP: allow self + Google Fonts + WebSocket connections
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; "+
				"script-src 'self' 'unsafe-inline'; "+ // inline scripts in index.html
				"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "+
				"font-src https://fonts.gstatic.com; "+
				"connect-src 'self' wss: ws:; "+
				"img-src 'self' data:; "+
				"frame-ancestors 'none'",
		)
		next.ServeHTTP(w, r)
	})
}
