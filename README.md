# Fighter Arena

A real-time 2-player browser fighting game. WebSocket server written in Go, TypeScript client compiled with esbuild, deployed on Fly.io (Amsterdam region).

---

## Quick Start

```bash
# Terminal 1 — server
cd server && go run .

# Terminal 2 — client (watch mode)
cd client && npm run build

# Open http://localhost:8080
```

**Dependencies:** Go 1.22+, Node 18+, no external services required locally.

---

## Architecture

```
fighter-game/
├── server/
│   ├── main.go              # HTTP server, static files, gzip, security headers
│   └── game/
│       ├── match.go         # Core game loop — physics, combat, power-ups, projectiles
│       ├── hub.go           # WebSocket hub — matchmaking, spectator broadcast
│       ├── player.go        # Player connection, Keys struct, read/write pumps
│       ├── leaderboard.go   # Win tracking, top-5 query
│       ├── db.go            # SQLite init (fighter.db)
│       ├── auth.go          # Google OAuth2 + JWT (optional — falls back to name input)
│       └── analytics.go     # Event tracking endpoint
└── client/
    ├── index.html           # Single page, canvas elements, font imports
    ├── style.css            # Queue screen, HUD panels, leaderboard table
    ├── game.js              # Bundled output — DO NOT EDIT DIRECTLY
    ├── assets/              # background.gif, sprites (see Sprite Contract below)
    └── src/                 # TypeScript source — edit these, then npm run build
        ├── main.ts          # Render loops, game-over → menu return, boot
        ├── renderer.ts      # All canvas drawing (layered, image-ready — see below)
        ├── network.ts       # WebSocket client, key mapping, hit effect detection
        ├── state.ts         # Singleton mutable state — single source of truth
        ├── types.ts         # TypeScript interfaces mirroring server structs
        ├── constants.ts     # Physics + sizing constants — must mirror match.go
        ├── prediction.ts    # Client-side movement prediction + opponent interpolation
        ├── preview.ts       # Offline sandbox mode (no server needed)
        ├── sprites.ts       # PNG sprite sheet loader + frame animation
        ├── ui.ts            # Screen transitions, leaderboard, auth UI
        └── audio.ts         # Web Audio API beep/synth sounds
```

### Data flow (one game tick)

```
Server tick (60fps)
  └─ match.go update()
       ├─ read Keys from each player
       ├─ run physics, attacks, power-ups, projectiles
       ├─ broadcast GameSnapshot (JSON) to both players + all spectators
Client receives snapshot
  └─ network.ts handleMsg()
       ├─ reconcile client-side prediction
       ├─ detect HP drops → spawn hit effects (state.hitEffects)
       ├─ detect sound events → play audio
       └─ store as state.gameState
Client render loop (rAF, 60fps)
  └─ main.ts renderGame()
       ├─ drawBackground / drawGround
       ├─ drawPowerUps
       ├─ drawProjectiles     (extrapolated between ticks for smoothness)
       ├─ drawGamePlayer ×2   (layered — see Renderer section)
       ├─ drawHitEffects
       └─ drawHUD
```

---

## Server — Key Constants (match.go)

These must stay in sync with `client/src/constants.ts`.

```go
MapWidth  = 1280.0   MapHeight = 720.0   GroundY = 592.0
PlayerW   = 27.0     PlayerH   = 42.0

Gravity   = 0.52     JumpVel = -10.8   MoveSpeed = 4.0   MaxFallSpeed = 14.4

// Attacks
Fist:     duration=36t  cooldown=56t   box=36×21  damage=10
Kick:     duration=44t  cooldown=76t   box=42×27  damage=15
Uppercut: duration=56t  cooldown=110t  box=30×36  damage=25  hop=-4.0vy

// Power-ups
PowerUpSpawnTicks=480  PowerUpBuffTicks=480  PowerUpCollectR=40  PowerUpBuffMult=2.5
MaxPowerUps=3

// Projectiles
ProjectileSpeed=10  ProjectileDamage=20  ShootBuffShots=5  ShootCooldownTicks=30
```

---

## Client — Controls

| Key | Action |
|-----|--------|
| `← →` | Walk |
| `↑` / `Space` | Jump |
| `A` | Fist punch |
| `S` | Kick |
| `D` | Uppercut |
| `F` (hold) | Block |
| `G` | Dodge (invincible dash) |
| `H` | Fire bullet (requires 🔥 pickup) |

---

## Renderer — Layered Architecture

Every player is drawn in **5 ordered layers** inside `drawGamePlayer()` in `renderer.ts`. Each layer is independently replaceable with real art:

```
Layer 1 — Body hitbox outline     (27×42 rect, colour-coded per player)
Layer 2 — Character visual        ← REPLACE THIS with sprite sheet
Layer 3 — Attack hitbox rect      (server-authoritative, cyan/orange/magenta)
Layer 4 — Buff aura               (cyan = speed, orange = damage)
Layer 5 — Name tag + buff icons
```

**Placeholder swap point** — `drawPlayerPlaceholder()` in `renderer.ts`:
- Replace its body with `ctx.drawImage(spriteSheet, ...)` calls
- Coordinate contract: `(x, y)` = top-left of hitbox, `PLAYER_W × PLAYER_H` = hitbox size
- The hitbox never changes size regardless of art dimensions

**Projectile swap point** — inside `drawProjectiles()`:
- Currently draws a solid orange circle (radius 14px + glow halo)
- Replace the marked block with `ctx.drawImage()` for a real bullet sprite
- Position is already extrapolated for smooth sub-tick movement

**Hit effect swap point** — `drawHitEffects()`:
- Drop `assets/hit_effect.png` (horizontal strip of 8 equal square frames) and it auto-loads
- Canvas burst animation runs as fallback if no PNG exists

---

## Sprite Contract (for future art)

All sprites face **right only** — the engine mirrors them via `ctx.scale(-1, 1)` for left-facing.

Anchor: **bottom-center of sprite = bottom-center of hitbox** (27×42 px).
The sprite can be any size larger than the hitbox — physics box stays fixed.

| State name | Suggested frames | Loops |
|------------|-----------------|-------|
| `idle` | 4 | yes |
| `walk` | 5 | yes |
| `jump` | 3 (rise/peak/fall) | no |
| `attack_fist` | 4 | no |
| `attack_leg` | 5 | no |
| `attack_uppercut` | 6 | no |
| `blocking` | 2 | yes |
| `dodging` | 3 | no |
| `hurt` | 3 | no |
| `ko` | 4 | no |
| `hurt_back` *(future)* | 3 | no |
| `ko_back` *(future)* | 4 | no |

**File format:** `assets/char1/<state_name>_<frame>.png`  
Transparent PNG, consistent frame dimensions per state.

---

## Player States & Agency

```
idle ──→ walking ──→ jumping
  │                    │
  └──→ attack_fist     │ (can attack mid-air)
  └──→ attack_leg      │
  └──→ attack_uppercut ┘
  └──→ blocking   (held, ground only, no movement)
  └──→ dodging    (committed 0.6s, full invincibility, no input)
        │
        └── on hit ──→ hurt   (0.6s stun, zero agency)
                         │
                         └── HP=0 ──→ ko  (terminal)
```

| State | Player agency |
|-------|--------------|
| idle / walking / jumping | Full |
| attack_* | Locked for duration, position drifts |
| blocking | Locked in place, can release |
| dodging | Committed direction, invincible |
| hurt | Zero for 0.6s |
| ko | Zero — match over |

---

## Power-up System

Spawns every 8 seconds, max 3 on field. Collected by walking within 40px.

| Icon | Kind | Effect |
|------|------|--------|
| ⚡ | `speed` | Move speed ×2.5 for 8s |
| 💥 | `damage` | All damage ×2.5 for 8s (melee + projectile) |
| 🔥 | `shoot` | 5 fire bullet charges (stackable) |

---

## Deployment

Deployed on **Fly.io**, region `ams` (Amsterdam).

```bash
fly deploy          # build Docker image, push, deploy
fly ssh console     # inspect running container
fly volumes list    # SQLite volume: fighter_data mounted at /data
```

**Environment variables (set via `fly secrets set`):**

| Variable | Purpose |
|----------|---------|
| `GOOGLE_CLIENT_ID` | Google OAuth2 (optional) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth2 (optional) |
| `JWT_SECRET` | Signs auth tokens |
| `BASE_URL` | OAuth2 redirect base, e.g. `https://fighter-arena.fly.dev` |
| `DB_PATH` | SQLite path (default `./fighter.db`, prod `/data/fighter.db`) |

Auth is **fully optional** — if env vars are absent the game falls back to a free-text name input with no persistence.

---

## Roadmap

### Immediate (before going wider)

- [ ] **Sprite integration** — replace `drawPlayerPlaceholder()` with real PNG sprite sheets using the contract above. The loader in `sprites.ts` is ready.
- [ ] **Hit effect PNG** — drop `assets/hit_effect.png` (8-frame strip). Canvas fallback already exists.
- [ ] **Bullet sprite** — replace the orange circle in `drawProjectiles()` with a real image.
- [ ] **Sound polish** — `audio.ts` uses Web Audio synth beeps. Replace with real `.ogg`/`.mp3` samples.
- [ ] **Back-attack mechanic** — remove forced auto-face during attacks, add 1.5× damage multiplier when hitting from behind, add `hurt_back` / `ko_back` sprite states.

### Gameplay depth

- [ ] **Air attacks** — attacking while airborne currently uses ground hitboxes. Separate air attack boxes + distinct sprite frames.
- [ ] **Landing lag** — snap from `jumping` to `idle` is instant. Add a short `landing` state (no input, ~10 ticks).
- [ ] **Attack windup / telegraph** — split attack animation into windup + active + recovery frames. Currently entire duration is "active hitbox on".
- [ ] **Block break** — no visual/audio when block absorbs a hit. Add a shield-crack flash.
- [ ] **Hitstun direction** — `hurt` looks the same regardless of which side was hit. Use `hurt_back` sprite + flip logic.
- [ ] **Double jump** — one extra jump in air before landing.
- [ ] **Special moves** — input combos (e.g. ↓ + A) triggering unique attacks. Server cooldown map already supports arbitrary keys.

### Characters

- [ ] **Second character type** — all character data lives in `NewMatch()` (colors, start positions). Add a character selection screen pre-match and a character ID field in `PlayerState`.
- [ ] **Per-character stats** — HP, speed, damage multiplier as character properties rather than global constants.

### Infrastructure

- [ ] **Rooms / lobbies** — currently pure random matchmaking. Add a room code system in `hub.go`.
- [ ] **Spectator count** — server broadcasts to spectators already. Show viewer count on the HUD.
- [ ] **Replay system** — `GameSnapshot` is already a complete serialisable state. Recording and replaying is a matter of storing the tick stream.
- [ ] **Mobile controls** — on-screen touch buttons wired to the same `Keys` struct.

---

## Known Gotchas for Future Agents

1. **Never edit `client/game.js` directly** — it is the compiled bundle. All source is in `client/src/`. Run `npm run build` after every change.

2. **Constants must stay in sync** — `client/src/constants.ts` mirrors `server/game/match.go`. If you change `PlayerW`, `PlayerH`, `GROUND_Y`, physics values, or attack box sizes on either side, change the other side too or the client prediction will diverge.

3. **`drawSprite` is an alias** — `drawSprite` in `renderer.ts` is exported as an alias for `drawPlayerPlaceholder`. The waiting screen and preview mode call it. Don't remove the alias when swapping in real sprites — update `drawPlayerPlaceholder` instead.

4. **Spectator socket opens on menu load** — `connectSpectator()` fires at boot. The socket upgrades to a queue player socket when the user clicks PLAY. Don't open a second socket.

5. **Projectile positions are extrapolated** — `drawProjectiles()` adds `proj.vx × ticksSinceLastSnap` to the server position for smooth rendering. Don't move the draw call behind the HUD or effects will clip incorrectly.

6. **Hit effects live in `state.hitEffects`** — populated by `detectHitEffects()` in `network.ts`, drawn by `drawHitEffects()` in `renderer.ts`, pruned automatically after 500ms. Don't clear the array anywhere else.

7. **Auth is no-op locally** — `InitAuth` does nothing if env vars are absent. The game is fully playable without Google OAuth.

8. **SQLite is optional** — `InitDB` logs a warning and continues if the DB can't open. Leaderboard just won't persist.
