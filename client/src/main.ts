import { state } from './state';
import { stepPred } from './prediction';
import { startInputLoop, initNetwork } from './network';
import {
  ctx,
  initBgGif,
  drawBackground, drawGround,
  drawGamePlayer, drawPowerUps, drawProjectiles, drawHitEffects, drawHUD,
  drawCountdown, drawFightText, drawGameOver, drawLoading,
  renderWaiting, renderSpectate,
} from './renderer';
import { stepPreview } from './preview';
import {
  showQueueScreen, showGameScreen,
  setScreenCallbacks, queueMsg, renderQueue, checkAuth,
  startSpectating, updateNameplates,
} from './ui';
import { W, H } from './constants';

// ── Render loops ───────────────────────────────────────────────────────────────

function waitingRenderLoop(): void {
  if (state.phase !== 'waiting') return;
  renderWaiting(state.queuedAs);
  requestAnimationFrame(waitingRenderLoop);
}

function gameRenderLoop(): void {
  if (state.phase !== 'game') return;
  renderGame();
  requestAnimationFrame(gameRenderLoop);
}

function renderGame(): void {
  checkGameOverTransition();

  if (state.previewMode) stepPreview();
  else stepPred();

  ctx.clearRect(0, 0, W, H);

  if (!state.gameState) { drawLoading(); return; }

  drawBackground();
  drawGround();

  if (state.gameState.powerUps?.length) {
    drawPowerUps(state.gameState.powerUps);
  }

  if (state.gameState.projectiles?.length) {
    drawProjectiles(state.gameState.projectiles);
  }

  for (const p of state.gameState.players) {
    if (p) drawGamePlayer(p);
  }

  if (state.hitEffects.length) {
    drawHitEffects(state.hitEffects);
  }

  drawHUD(state.gameState);

  if (state.gameState.phase === 'countdown') {
    drawCountdown(state.gameState.countdown);
  }

  if (state.fightFlash > 0) {
    drawFightText(state.fightFlash);
    state.fightFlash--;
  }

  if (state.gameState.phase === 'gameover') {
    const winner = state.gameState.winner || '???';
    const isMe   = !!(state.matchInfo && winner === state.matchInfo.you);
    const secsLeft = Math.ceil(Math.max(0, (gameOverReturnAt - performance.now()) / 1000));
    drawGameOver(winner, isMe, secsLeft);
    if (performance.now() >= gameOverReturnAt) returnToMenu();
  }

  for (let i = 0; i < 2; i++) {
    if (state.hitFlash[i] > 0) state.hitFlash[i]--;
  }
}

// ── Game-over → menu return ────────────────────────────────────────────────────

const RETURN_DELAY_MS = 5000;
let gameOverReturnAt  = Infinity; // performance.now() timestamp to return

function returnToMenu(): void {
  gameOverReturnAt = Infinity;
  state.gameState  = null;
  state.matchInfo  = null;
  state.playerID   = null;
  state.pred       = null;
  state.hitEffects = [];
  showQueueScreen();
  startSpectating();       // reconnect spectator socket
  startSpectateLoop();
}

// Trigger the countdown the first time we see gameover phase
let sawGameOver = false;
function checkGameOverTransition(): void {
  if (state.phase !== 'game') { sawGameOver = false; return; }
  if (state.gameState?.phase === 'gameover' && !sawGameOver) {
    sawGameOver      = true;
    gameOverReturnAt = performance.now() + RETURN_DELAY_MS;
  }
}

// Any key press on the game-over screen skips the countdown
document.addEventListener('keydown', () => {
  if (state.phase === 'game' && state.gameState?.phase === 'gameover') {
    returnToMenu();
  }
});

// ── Spectate render loop (menu page) ──────────────────────────────────────────
// Runs at ~30 fps while on menu — the server pushes at 60 fps so we can halve it.

let spectateRafId: number | null = null;
let lastSpectateDraw = 0;

function spectateRenderLoop(now: number): void {
  if (state.phase !== 'menu' && state.phase !== 'waiting') {
    spectateRafId = null;
    return;
  }
  if (now - lastSpectateDraw >= 33) { // ~30 fps
    renderSpectate(state.spectateState);
    lastSpectateDraw = now;
  }
  spectateRafId = requestAnimationFrame(spectateRenderLoop);
}

export function startSpectateLoop(): void {
  if (spectateRafId !== null) return;
  spectateRafId = requestAnimationFrame(spectateRenderLoop);
}

// ── Hook render loops into screen transitions ──────────────────────────────────

setScreenCallbacks({
  onWaitingStart: () => requestAnimationFrame(waitingRenderLoop),
  onGameStart:    () => requestAnimationFrame(gameRenderLoop),
});

// ── Wire network callbacks ─────────────────────────────────────────────────────

initNetwork({
  onQueued(message) {
    queueMsg.textContent = message;
  },

  onMatchFound(_playerID, _you, _opponent) {
    showGameScreen();
    startInputLoop();
  },

  onQueueStatus(status) {
    renderQueue(status);
  },

  onSpectateUpdate() {
    updateNameplates();
  },

  onDisconnect() {
    showQueueScreen();
    queueMsg.textContent = 'Disconnected. Refresh to try again.';
  },

  onError() {
    queueMsg.textContent = 'Cannot reach server. Is it running on :8080?';
  },
});

// ── Boot ───────────────────────────────────────────────────────────────────────

(async () => {
  initBgGif();          // fire-and-forget — does not block UI
  await checkAuth();
  // Open spectate socket and start rendering the live match on the menu canvas.
  startSpectating();
  startSpectateLoop();
})();
