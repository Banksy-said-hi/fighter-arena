package game

import (
	"database/sql"
	"log"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

var DB *sql.DB

func InitDB(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}

	db, err := sql.Open("sqlite", path+"?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return err
	}

	if _, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS wins (
			name        TEXT PRIMARY KEY,
			count       INTEGER NOT NULL DEFAULT 0,
			last_win_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE TABLE IF NOT EXISTS queue_log (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			name        TEXT    NOT NULL,
			joined_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
			matched_at  DATETIME,
			left_at     DATETIME
		);

		CREATE TABLE IF NOT EXISTS users (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			google_id  TEXT    NOT NULL UNIQUE,
			email      TEXT    NOT NULL,
			nickname   TEXT    UNIQUE,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			last_seen  DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE TABLE IF NOT EXISTS events (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id    INTEGER,
			session_id TEXT    NOT NULL,
			event      TEXT    NOT NULL,
			meta       TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
		CREATE INDEX IF NOT EXISTS idx_events_user    ON events(user_id);
		CREATE INDEX IF NOT EXISTS idx_events_event   ON events(event);
		CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
	`); err != nil {
		return err
	}

	DB = db
	log.Printf("[db] ready: %s", path)
	return nil
}
