import type {
  AppPhase, AttackKey, AttackStateName,
  GameSnapshot, HitEffect, Keys, MatchInfo,
  OppSnap, PlayerIndex, PlayerStateName, PredState, SpectateMatchInfo,
} from './types';

// ── Mutable singleton — the single source of truth for all client runtime state.
// Modules import and mutate this directly; TypeScript enforces the shape.

export interface State {
  // ── Network ────────────────────────────────────────────────────────────────
  ws: WebSocket | null;

  // ── Identity ───────────────────────────────────────────────────────────────
  playerID: PlayerIndex | null;
  matchInfo: MatchInfo | null;
  authedNickname: string | null;
  queuedAs: string | null;

  // ── Authoritative server snapshot (in-match) ──────────────────────────────
  gameState: GameSnapshot | null;

  // ── Live snapshot received while spectating on the menu ───────────────────
  spectateState: GameSnapshot | null;
  spectateMatchInfo: SpectateMatchInfo | null;

  // ── App-level screen phase ─────────────────────────────────────────────────
  phase: AppPhase;

  // ── Visual effects ─────────────────────────────────────────────────────────
  fightFlash: number;
  hitFlash: [number, number];
  prevCountdown: number;
  hitEffects: HitEffect[];

  // ── Client-side movement prediction ───────────────────────────────────────
  pred: PredState | null;

  // ── Opponent position interpolation ───────────────────────────────────────
  oppSnaps: [OppSnap | null, OppSnap | null];
  lastSnapAt: number;

  // ── Local attack prediction (instant feedback before server confirms) ──────
  predictedAttack: AttackStateName | null;
  predictedAttackTick: number;
  localCooldowns: Record<AttackKey, number>;

  // ── Keyboard input ─────────────────────────────────────────────────────────
  keys: Keys;

  // ── Preview / offline sandbox mode ────────────────────────────────────────
  previewMode: boolean;
  previewBotTick: number;
  previewAttackTimer: number;
  previewAttackState: PlayerStateName | null; // tighter than string

  // ── Background GIF ─────────────────────────────────────────────────────────
  bgAnimating: boolean;

  // ── Loop handles ───────────────────────────────────────────────────────────
  inputInterval: ReturnType<typeof setInterval> | null;
  menuRaf: number | null;
}

export const state: State = {
  ws: null,
  playerID: null,
  matchInfo: null,
  authedNickname: null,
  queuedAs: null,
  gameState: null,
  spectateState: null,
  spectateMatchInfo: null,
  phase: 'menu',
  fightFlash: 0,
  hitFlash: [0, 0],
  prevCountdown: 4,
  hitEffects: [],
  pred: null,
  oppSnaps: [null, null],
  lastSnapAt: 0,
  predictedAttack: null,
  predictedAttackTick: 0,
  localCooldowns: { fist: 0, leg: 0, uppercut: 0 },
  keys: {
    left: false, right: false, jump: false,
    fist: false, leg: false, uppercut: false,
    block: false, dodge: false, shoot: false,
  },
  previewMode: false,
  previewBotTick: 0,
  previewAttackTimer: 0,
  previewAttackState: null,
  bgAnimating: false,
  inputInterval: null,
  menuRaf: null,
};
