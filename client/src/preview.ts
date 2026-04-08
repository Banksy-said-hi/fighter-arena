import {
  GROUND_Y, PLAYER_W, PLAYER_H, W,
  PREVIEW_GRAVITY, PREVIEW_JUMP_VEL, PREVIEW_SPEED, PREVIEW_ATTACK_DURATION,
} from './constants';
import type { FacingDir, PlayerIndex, PlayerState } from './types';
import { state } from './state';
import { showQueueScreen, hideWaitingOverlay, gameScreen, queueScreen } from './ui';
import { hideBgCanvas } from './renderer';
import { initPred } from './prediction';

// ── Local preview player (not a proper PlayerState — extended inline) ──────────

interface PreviewPlayer extends PlayerState {
  vx: number;
  vy: number;
}

function makePreviewPlayer(
  id: PlayerIndex, x: number, color: string, facing: FacingDir, name: string,
): PreviewPlayer {
  return {
    id, name, color,
    x, y: GROUND_Y - PLAYER_H,
    vx: 0, vy: 0,
    hp: 100, maxHp: 100,
    facing,
    state: 'idle',
    attackActive: false,
  };
}

export function startPreview(): void {
  state.previewMode    = true;
  state.previewBotTick = 0;
  state.playerID       = 0;

  const p   = makePreviewPlayer(0 as const, 150, '#FF69B4',  1 as const, 'YOU');
  const bot = makePreviewPlayer(1 as const, 600, '#FF8C00', -1 as const, 'BOT');

  state.gameState = {
    phase: 'fighting',
    countdown: 0,
    tick: 0,
    winner: '',
    players: [p, bot],
  };
  state.pred = null;
  initPred(p.x, p.y);

  queueScreen.classList.add('hidden');
  hideBgCanvas();
  gameScreen.classList.remove('hidden');
  state.phase = 'game';
  (document.activeElement as HTMLElement | null)?.blur();
}

export function stopPreview(): void {
  state.previewMode = false;
  state.gameState   = null;
  state.playerID    = null;
  state.pred        = null;
  showQueueScreen();
}

export function stepPreview(): void {
  if (!state.previewMode || !state.gameState) return;
  state.gameState.tick++;
  state.previewBotTick++;

  const players = state.gameState.players;
  const p   = players[0] as PreviewPlayer;
  const bot = players[1] as PreviewPlayer;
  const { keys } = state;

  // ── Local player physics ──────────────────────────────────────────────────
  const onGround = p.y >= GROUND_Y - PLAYER_H - 1;

  if (keys.left)        p.vx = -PREVIEW_SPEED;
  else if (keys.right)  p.vx =  PREVIEW_SPEED;
  else { p.vx *= 0.8; if (Math.abs(p.vx) < 0.2) p.vx = 0; }

  if (keys.jump && onGround) p.vy = PREVIEW_JUMP_VEL;

  p.vy += PREVIEW_GRAVITY;
  if (p.vy > 15) p.vy = 15;
  p.x += p.vx;
  p.y += p.vy;
  if (p.y >= GROUND_Y - PLAYER_H) { p.y = GROUND_Y - PLAYER_H; p.vy = 0; }
  p.x = Math.max(0, Math.min(W - PLAYER_W, p.x));
  p.facing = bot.x > p.x ? 1 : -1;

  // Attack state (timer-based so it's visible for a few frames)
  if (state.previewAttackTimer > 0) {
    state.previewAttackTimer--;
    p.state = (state.previewAttackState ?? 'idle') as PlayerState['state'];
  } else if (!onGround || p.vy < -0.1) {
    p.state = 'jumping';
  } else if (Math.abs(p.vx) > 0.3) {
    p.state = 'walking';
  } else if (keys.fist) {
    p.state = 'attack_fist';
    state.previewAttackState = 'attack_fist';
    state.previewAttackTimer = PREVIEW_ATTACK_DURATION;
  } else if (keys.leg) {
    p.state = 'attack_leg';
    state.previewAttackState = 'attack_leg';
    state.previewAttackTimer = PREVIEW_ATTACK_DURATION;
  } else if (keys.uppercut) {
    p.state = 'attack_uppercut';
    state.previewAttackState = 'attack_uppercut';
    state.previewAttackTimer = PREVIEW_ATTACK_DURATION;
  } else if (keys.block) {
    p.state = 'blocking';
  } else if (keys.dodge) {
    p.state = 'dodging';
  } else {
    p.state = 'idle';
  }

  // ── Bot: simple patrol + face player ─────────────────────────────────────
  const botWalkRight = Math.sin(state.previewBotTick / 80) > 0;
  bot.vx = botWalkRight ? 2 : -2;
  bot.x += bot.vx;
  bot.x = Math.max(80, Math.min(W - PLAYER_W - 80, bot.x));
  bot.facing = p.x < bot.x ? -1 : 1;
  bot.state  = 'walking';

  // Keep local prediction in sync with preview player
  if (state.pred) {
    state.pred.x  = p.x;
    state.pred.y  = p.y;
    state.pred.vx = p.vx;
    state.pred.vy = p.vy;
  }
}

// ESC exits preview
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.previewMode) stopPreview();
});

// TEST MATCH is a dev-only feature — only visible on localhost
const previewBtn = document.getElementById('preview-btn');
if (previewBtn) {
  const isDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (isDev) previewBtn.classList.remove('hidden');
  previewBtn.addEventListener('click', startPreview);
}
