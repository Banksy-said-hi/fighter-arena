// ── Domain types (mirror server structs in game/match.go) ─────────────────────

export interface AttackBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PlayerIndex = 0 | 1;
export type FacingDir  = -1 | 1;

export interface PlayerState {
  id: PlayerIndex;
  name: string;
  color: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  facing: FacingDir;
  state: PlayerStateName;
  attackActive: boolean;
  attackBox?: AttackBox;
  speedBuff?: number;
  damageBuff?: number;
  shootBuff?: number;
}

export interface PowerUp {
  id: number;
  x: number;
  y: number;
  kind: string;
}

export interface Projectile {
  id: number;
  x: number;
  y: number;
  vx: number;
  ownerId: number;
}

export interface GameSnapshot {
  phase: GamePhase;
  countdown: number;
  players: [PlayerState, PlayerState];
  winner: string;
  tick: number;
  powerUps?: PowerUp[];
  projectiles?: Projectile[];
}

export interface MatchInfo {
  you: string;
  opponent: string;
}

export interface Keys {
  left: boolean;
  right: boolean;
  jump: boolean;
  fist: boolean;
  leg: boolean;
  uppercut: boolean;
  block: boolean;
  dodge: boolean;
  shoot: boolean;
}

export interface QueueStatus {
  waiting_name: string;
  waiting_secs: number;
  online: number;
  active_matches: number;
}

export interface LeaderboardEntry {
  rank: number;
  name: string;
  wins: number;
}

// ── Discriminated unions ───────────────────────────────────────────────────────

export type GamePhase = 'countdown' | 'fighting' | 'gameover';

export type AppPhase = 'menu' | 'waiting' | 'game';

export type PlayerStateName =
  | 'idle'
  | 'walking'
  | 'jumping'
  | 'attack_fist'
  | 'attack_leg'
  | 'attack_uppercut'
  | 'blocking'
  | 'dodging'
  | 'hurt'
  | 'ko';

export type AttackStateName = 'attack_fist' | 'attack_leg' | 'attack_uppercut';
export type ActionEventName = AttackStateName | 'dodge' | 'jump';

/** Maps to the cooldown key stored in server/state cooldown maps */
export type AttackKey = 'fist' | 'leg' | 'uppercut';

export type SoundName =
  | 'fist'
  | 'leg'
  | 'uppercut'
  | 'hit'
  | 'block'
  | 'ko'
  | 'countdown'
  | 'fight'
  | 'jump';

/** All analytics event names — exhaustive union prevents silent typos */
export type TrackEventName =
  | 'page_view'
  | 'page_exit'
  | 'click_join'
  | 'click_share'
  | 'click_share_waiting'
  | 'click_cancel_queue'
  | 'match_start'
  | 'match_end'
  | 'login_returning';

// ── Hit effects ───────────────────────────────────────────────────────────────

export interface HitEffect {
  x: number;
  y: number;
  startMs: number;  // performance.now() when spawned
  kind: 'melee' | 'projectile';
}

// ── Internal state shapes ──────────────────────────────────────────────────────

export interface PredState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface OppSnap {
  x: number;
  y: number;
}

// ── Incoming WS messages (exhaustive discriminated union) ──────────────────────

export type ServerMessage =
  | { type: 'queued';         message: string }
  | { type: 'match_found';    player_id: PlayerIndex; you: string; opponent: string }
  | { type: 'fight_start' }
  | { type: 'state';          state: GameSnapshot }
  | { type: 'opponent_left';  message: string }
  | { type: 'queue_status';   status: QueueStatus }
  | { type: 'match_started';  p1: string; p2: string };

export interface SpectateMatchInfo {
  p1: string;
  p2: string;
}

// Outgoing client messages
export type ClientMessage =
  | { type: 'join_spectate'; name?: string }
  | { type: 'join_queue';    name: string }
  | { type: 'input';         keys: Keys; ab?: ActionEventName[] };

// ── Audio ──────────────────────────────────────────────────────────────────────

export interface BeepOptions {
  type?: OscillatorType;
  freq?: number;
  endFreq?: number;
  duration?: number;
  volume?: number;
  delay?: number;
}

// ── Sprite map ─────────────────────────────────────────────────────────────────

/** Sprite sheet name — not always 1:1 with PlayerStateName (e.g. 'walking' → 'walk') */
export type SpriteName =
  | 'idle'
  | 'walk'
  | 'jump'
  | 'attack_fist'
  | 'attack_leg'
  | 'attack_uppercut'
  | 'blocking'
  | 'dodging'
  | 'hurt'
  | 'ko';
