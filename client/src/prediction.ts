import {
  GRAVITY, JUMP_VEL, MOVE_SPEED, MAX_FALL_SPEED,
  GROUND_Y, PLAYER_H, PLAYER_W, W,
  TICK_MS, SERVER_ONLY_STATES,
  ATTACK_DURATIONS, ATTACK_COOLDOWNS, ATTACK_CD_KEY,
} from './constants';
import type { AttackStateName, PredState } from './types';
import { state } from './state';

// ── Opponent interpolation ─────────────────────────────────────────────────────

export function interpOppPos(serverX: number, serverY: number): { x: number; y: number } {
  const [snap0, snap1] = state.oppSnaps;
  if (!snap0 || !snap1) return { x: serverX, y: serverY };
  const elapsed = performance.now() - state.lastSnapAt;
  const t = Math.min(1, elapsed / TICK_MS);
  return {
    x: snap0.x + (snap1.x - snap0.x) * t,
    y: snap0.y + (snap1.y - snap0.y) * t,
  };
}

// ── Local attack prediction ────────────────────────────────────────────────────

export function tryPredictAttack(attackState: AttackStateName): void {
  if (state.phase !== 'game') return;
  const cdKey = ATTACK_CD_KEY[attackState] as keyof typeof state.localCooldowns;
  if (state.localCooldowns[cdKey] > 0) return; // still on cooldown
  state.predictedAttack = attackState;
  state.predictedAttackTick = ATTACK_DURATIONS[attackState];
  state.localCooldowns[cdKey] = ATTACK_COOLDOWNS[attackState];
}

function tickLocalCooldowns(): void {
  for (const k of Object.keys(state.localCooldowns) as (keyof typeof state.localCooldowns)[]) {
    if (state.localCooldowns[k] > 0) state.localCooldowns[k]--;
  }
  if (state.predictedAttackTick > 0) {
    state.predictedAttackTick--;
    if (state.predictedAttackTick <= 0) state.predictedAttack = null;
  }
}

// ── Position prediction ────────────────────────────────────────────────────────

export function initPred(x: number, y: number): void {
  state.pred = { x, y, vx: 0, vy: 0 };
}

/** Advance one animation frame of local prediction (called every rAF ~60 fps). */
export function stepPred(): void {
  tickLocalCooldowns();

  const { pred, playerID, gameState, keys } = state;
  if (!pred || playerID === null || !gameState || gameState.phase !== 'fighting') return;

  const sp = gameState.players?.[playerID];
  if (!sp || SERVER_ONLY_STATES.has(sp.state)) return; // let server drive

  const onGround = pred.y >= GROUND_Y - PLAYER_H - 1;

  if (keys.left)        pred.vx = -MOVE_SPEED;
  else if (keys.right)  pred.vx =  MOVE_SPEED;
  else {
    pred.vx *= 0.81;
    if (Math.abs(pred.vx) < 0.15) pred.vx = 0;
  }

  if (keys.jump && onGround) pred.vy = JUMP_VEL;

  pred.vy += GRAVITY;
  if (pred.vy > MAX_FALL_SPEED) pred.vy = MAX_FALL_SPEED;

  pred.x += pred.vx;
  pred.y += pred.vy;

  if (pred.y >= GROUND_Y - PLAYER_H) { pred.y = GROUND_Y - PLAYER_H; pred.vy = 0; }
  if (pred.x < 0)                    { pred.x = 0;                   pred.vx = 0; }
  if (pred.x > W - PLAYER_W)         { pred.x = W - PLAYER_W;        pred.vx = 0; }
}

/**
 * Reconcile local prediction against authoritative server position.
 * Small drift → gentle lerp.  Large drift → snap.
 */
export function reconcilePred(sp: PredState): void {
  if (!state.pred) { initPred(sp.x, sp.y); return; }
  const dx = sp.x - state.pred.x;
  const dy = sp.y - state.pred.y;
  if (Math.abs(dx) < 80 && Math.abs(dy) < 80) {
    state.pred.x += dx * 0.12;
    state.pred.y += dy * 0.12;
  } else {
    state.pred.x = sp.x;
    state.pred.y = sp.y;
    state.pred.vx = 0;
    state.pred.vy = 0;
  }
}
