package game

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

// ── Auth config ───────────────────────────────────────────────────────────────

var (
	oauthConf     *oauth2.Config
	jwtSecret     []byte
	authEnabled   bool
	baseURL       string
)

const (
	cookieSession = "fighter_session"
	cookieState   = "fighter_oauth_state"
	jwtExpiry     = 30 * 24 * time.Hour // 30 days
	stateExpiry   = 10 * time.Minute
)

// InitAuth must be called once with credentials from environment variables.
// If clientID or clientSecret are empty, auth is disabled and the game falls
// back to the old name-input flow.
func InitAuth(clientID, clientSecret, secret, base string) {
	if clientID == "" || clientSecret == "" || secret == "" {
		log.Println("[auth] Google credentials not set — running without OAuth")
		return
	}
	baseURL = strings.TrimRight(base, "/")
	jwtSecret = []byte(secret)
	oauthConf = &oauth2.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		RedirectURL:  baseURL + "/auth/callback",
		Scopes:       []string{"openid", "email", "profile"},
		Endpoint:     google.Endpoint,
	}
	authEnabled = true
	log.Println("[auth] Google OAuth2 enabled")
}

// AuthEnabled returns whether OAuth is active.
func AuthEnabled() bool { return authEnabled }

// ── JWT claims ────────────────────────────────────────────────────────────────

type Claims struct {
	UserID   int64  `json:"uid"`
	GoogleID string `json:"gid"`
	Nickname string `json:"nick"`
	jwt.RegisteredClaims
}

// ── Handlers ──────────────────────────────────────────────────────────────────

// HandlerGoogleLogin redirects the browser to Google's consent screen.
func HandlerGoogleLogin(w http.ResponseWriter, r *http.Request) {
	if !authEnabled {
		http.Error(w, "auth not configured", http.StatusServiceUnavailable)
		return
	}

	state, err := randomState()
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	// Store state in a short-lived httpOnly cookie to validate on callback
	http.SetCookie(w, &http.Cookie{
		Name:     cookieState,
		Value:    state,
		Path:     "/",
		MaxAge:   int(stateExpiry.Seconds()),
		HttpOnly: true,
		Secure:   isHTTPS(r),
		SameSite: http.SameSiteLaxMode,
	})

	url := oauthConf.AuthCodeURL(state, oauth2.AccessTypeOnline)
	http.Redirect(w, r, url, http.StatusTemporaryRedirect)
}

// HandlerGoogleCallback handles the OAuth2 redirect from Google.
func HandlerGoogleCallback(w http.ResponseWriter, r *http.Request) {
	if !authEnabled {
		http.Error(w, "auth not configured", http.StatusServiceUnavailable)
		return
	}

	// ── CSRF: validate state ──────────────────────────────────
	stateCookie, err := r.Cookie(cookieState)
	if err != nil || stateCookie.Value != r.FormValue("state") {
		http.Error(w, "invalid state — possible CSRF", http.StatusBadRequest)
		return
	}
	// Invalidate the state cookie immediately
	http.SetCookie(w, &http.Cookie{
		Name:     cookieState,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   isHTTPS(r),
		SameSite: http.SameSiteLaxMode,
	})

	// ── Exchange code for token ───────────────────────────────
	code := r.FormValue("code")
	if code == "" {
		http.Error(w, "missing code", http.StatusBadRequest)
		return
	}

	token, err := oauthConf.Exchange(context.Background(), code)
	if err != nil {
		log.Printf("[auth] token exchange error: %v", err)
		http.Error(w, "token exchange failed", http.StatusInternalServerError)
		return
	}

	// ── Fetch user info from Google ───────────────────────────
	info, err := fetchGoogleUserInfo(token)
	if err != nil {
		log.Printf("[auth] userinfo error: %v", err)
		http.Error(w, "failed to fetch user info", http.StatusInternalServerError)
		return
	}

	// ── Upsert user in DB ─────────────────────────────────────
	user, err := upsertUser(info.Sub, info.Email)
	if err != nil {
		log.Printf("[auth] db upsert error: %v", err)
		http.Error(w, "database error", http.StatusInternalServerError)
		return
	}

	// ── Issue session JWT ─────────────────────────────────────
	if err := issueSessionCookie(w, r, user.ID, user.GoogleID, user.Nickname); err != nil {
		log.Printf("[auth] jwt issue error: %v", err)
		http.Error(w, "session error", http.StatusInternalServerError)
		return
	}

	// Redirect: if no nickname yet → nickname picker, else → home
	if user.Nickname == "" {
		http.Redirect(w, r, "/?screen=nickname", http.StatusSeeOther)
	} else {
		http.Redirect(w, r, "/", http.StatusSeeOther)
	}
}

// HandlerMe returns the current user's profile as JSON (used by the frontend
// on page load to decide whether to show login, nickname, or game screen).
func HandlerMe(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if !authEnabled {
		// Auth is not configured — tell the frontend to skip directly to name-input
		json.NewEncoder(w).Encode(map[string]interface{}{
			"authed":      false,
			"authEnabled": false,
		})
		return
	}

	claims, err := getClaimsFromRequest(r)
	if err != nil {
		// Auth is on but this visitor has no valid session → send to login
		json.NewEncoder(w).Encode(map[string]interface{}{
			"authed":      false,
			"authEnabled": true,
		})
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"authed":      true,
		"authEnabled": true,
		"nickname":    claims.Nickname,
		"needsNick":   claims.Nickname == "",
	})
}

// HandlerSetNickname lets the user choose or change their display name.
func HandlerSetNickname(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	claims, err := getClaimsFromRequest(r)
	if err != nil {
		http.Error(w, "not authenticated", http.StatusUnauthorized)
		return
	}

	var body struct {
		Nickname string `json:"nickname"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	nick := sanitizeNickname(body.Nickname)
	if nick == "" {
		http.Error(w, "nickname must be 2-20 alphanumeric characters, _ or -", http.StatusBadRequest)
		return
	}

	// Save to DB
	if _, err := DB.Exec(
		`UPDATE users SET nickname = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?`,
		nick, claims.UserID,
	); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			http.Error(w, "nickname already taken", http.StatusConflict)
			return
		}
		log.Printf("[auth] nickname update error: %v", err)
		http.Error(w, "database error", http.StatusInternalServerError)
		return
	}

	// Re-issue JWT with the new nickname
	if err := issueSessionCookie(w, r, claims.UserID, claims.GoogleID, nick); err != nil {
		http.Error(w, "session error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "nickname": nick})
}

// HandlerLogout clears the session cookie.
func HandlerLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     cookieSession,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   isHTTPS(r),
		SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

// ── GetNicknameFromRequest is called by ServeWS to authenticate the WebSocket.
// Returns ("", false) when auth is disabled (fall-through to name-input flow).
func GetNicknameFromRequest(r *http.Request) (string, bool) {
	if !authEnabled {
		return "", false
	}
	claims, err := getClaimsFromRequest(r)
	if err != nil {
		return "", false
	}
	if claims.Nickname == "" {
		return "", false
	}
	return claims.Nickname, true
}

// ── Internal helpers ──────────────────────────────────────────────────────────

type googleUserInfo struct {
	Sub   string `json:"sub"`
	Email string `json:"email"`
}

func fetchGoogleUserInfo(token *oauth2.Token) (*googleUserInfo, error) {
	client := oauthConf.Client(context.Background(), token)
	resp, err := client.Get("https://openidconnect.googleapis.com/v1/userinfo")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var info googleUserInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return nil, err
	}
	return &info, nil
}

type dbUser struct {
	ID       int64
	GoogleID string
	Nickname string
}

func upsertUser(googleID, email string) (*dbUser, error) {
	// Insert if new, update last_seen if returning
	_, err := DB.Exec(`
		INSERT INTO users (google_id, email, created_at, last_seen)
		VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		ON CONFLICT(google_id) DO UPDATE SET
			email     = excluded.email,
			last_seen = CURRENT_TIMESTAMP
	`, googleID, email)
	if err != nil {
		return nil, err
	}

	row := DB.QueryRow(`SELECT id, google_id, COALESCE(nickname,'') FROM users WHERE google_id = ?`, googleID)
	var u dbUser
	if err := row.Scan(&u.ID, &u.GoogleID, &u.Nickname); err != nil {
		return nil, err
	}
	return &u, nil
}

func issueSessionCookie(w http.ResponseWriter, r *http.Request, userID int64, googleID, nickname string) error {
	now := time.Now()
	claims := Claims{
		UserID:   userID,
		GoogleID: googleID,
		Nickname: nickname,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(jwtExpiry)),
			Issuer:    "fighter-arena",
		},
	}
	tokenStr, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(jwtSecret)
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     cookieSession,
		Value:    tokenStr,
		Path:     "/",
		MaxAge:   int(jwtExpiry.Seconds()),
		HttpOnly: true,
		Secure:   isHTTPS(r),
		SameSite: http.SameSiteLaxMode,
	})
	return nil
}

func getClaimsFromRequest(r *http.Request) (*Claims, error) {
	cookie, err := r.Cookie(cookieSession)
	if err != nil {
		return nil, err
	}
	token, err := jwt.ParseWithClaims(cookie.Value, &Claims{}, func(t *jwt.Token) (interface{}, error) {
		// Prevent algorithm confusion: only accept HS256
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, jwt.ErrSignatureInvalid
		}
		return jwtSecret, nil
	})
	if err != nil || !token.Valid {
		return nil, jwt.ErrSignatureInvalid
	}
	claims, ok := token.Claims.(*Claims)
	if !ok {
		return nil, jwt.ErrTokenInvalidClaims
	}
	return claims, nil
}

var nickRe = regexp.MustCompile(`^[a-zA-Z0-9_\-]{2,20}$`)

func sanitizeNickname(s string) string {
	s = strings.TrimSpace(s)
	if !nickRe.MatchString(s) {
		return ""
	}
	return s
}

func randomState() (string, error) {
	b := make([]byte, 18)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func isHTTPS(r *http.Request) bool {
	return r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
}
