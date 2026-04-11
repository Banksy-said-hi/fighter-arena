import type { ClientMessage, ServerMessage, QueueStatus, Keys, PlayerState, ActionEventName } from './types';
import { state } from './state';
import { PLAYER_W, PLAYER_H } from './constants';
import { playSound } from './audio';
import { reconcilePred, tryPredictAttack } from './prediction';
import { track } from './analytics';

// ── Callbacks wired by main.ts to avoid circular imports ──────────────────────
export interface NetworkCallbacks {
  onQueued(message: string): void;
  onMatchFound(playerID: number, you: string, opponent: string): void;
  onQueueStatus(status: QueueStatus): void;
  onSpectateUpdate(): void;   // menu canvas should re-render
  onDisconnect(): void;
  onError(): void;
}

let callbacks: NetworkCallbacks | null = null;

export function initNetwork(cb: NetworkCallbacks): void {
  callbacks = cb;
}

function wsSend(msg: ClientMessage): void {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

// ── Spectate connection (opened automatically on menu load) ───────────────────

export function connectSpectator(): void {
  // Don't open a second socket if one is already live.
  if (state.ws && state.ws.readyState !== WebSocket.CLOSED) return;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    wsSend({ type: 'join_spectate', name: state.authedNickname ?? undefined });
  };

  ws.onmessage = e => handleMsg(JSON.parse(e.data) as ServerMessage);

  ws.onclose = () => {
    state.spectateState = null;
    if (state.phase !== 'menu') callbacks?.onDisconnect();
  };

  ws.onerror = () => {
    if (state.phase !== 'menu') callbacks?.onError();
  };
}

// ── Upgrade spectator → queue player (reuses existing socket) ─────────────────

export function joinQueueFromSpectate(playerName: string): void {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    wsSend({ type: 'join_queue', name: playerName });
  } else {
    // Socket dropped; open a fresh one that goes straight to queue.
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    state.ws = ws;
    ws.onopen  = () => wsSend({ type: 'join_queue', name: playerName });
    ws.onmessage = e => handleMsg(JSON.parse(e.data) as ServerMessage);
    ws.onclose = () => { if (state.phase !== 'menu') callbacks?.onDisconnect(); };
    ws.onerror = () => { if (state.phase !== 'menu') callbacks?.onError(); };
  }
}

export function sendInput(): void {
  const { ws, phase, keys } = state;
  if (ws && ws.readyState === WebSocket.OPEN && phase === 'game') {
    if (state.attackBuf.length > 0) { const ab = state.attackBuf.splice(0); wsSend({ type: "input", keys, ab }); } else { wsSend({ type: "input", keys }); }
  }
}

// ── Spectate idle-clear: after gameover the server stops sending for ~5s,
//    then we clear spectateState so the placeholder renders again. ─────────────

let spectateIdleTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSpectateClear(): void {
  if (spectateIdleTimer !== null) return;
  spectateIdleTimer = setTimeout(() => {
    state.spectateState    = null;
    state.spectateMatchInfo = null;
    spectateIdleTimer = null;
    callbacks?.onSpectateUpdate();
  }, 6500); // match closes after 5s gameover; give 1.5s extra margin
}

function cancelSpectateClear(): void {
  if (spectateIdleTimer !== null) {
    clearTimeout(spectateIdleTimer);
    spectateIdleTimer = null;
  }
}

// ── Message handler ───────────────────────────────────────────────────────────

function handleMsg(msg: ServerMessage): void {
  switch (msg.type) {
    case 'queued':
      callbacks?.onQueued(msg.message);
      break;

    case 'match_started':
      // Broadcast from server when a new match is created — update spectate UI.
      state.spectateMatchInfo = { p1: msg.p1, p2: msg.p2 };
      cancelSpectateClear();
      callbacks?.onSpectateUpdate();
      break;

    case 'match_found':
      state.playerID  = msg.player_id;
      state.matchInfo = { you: msg.you, opponent: msg.opponent };
      state.spectateState    = null;
      state.spectateMatchInfo = null;
      cancelSpectateClear();
      state.prevCountdown = 4;
      track('match_start', { you: msg.you, opponent: msg.opponent });
      callbacks?.onMatchFound(msg.player_id, msg.you, msg.opponent);
      break;

    case 'fight_start':
      playSound('fight');
      state.fightFlash = 70;
      break;

    case 'state': {
      // Route: in-match → gameState (with prediction). On menu/waiting → spectateState.
      if (state.phase === 'game') {
        const prev = state.gameState;
        state.gameState = msg.state;

        if (state.playerID !== null && state.gameState.players?.[state.playerID]) {
          const sp = state.gameState.players[state.playerID];
          reconcilePred({ x: sp.x, y: sp.y, vx: 0, vy: 0 });
        }

        if (state.playerID !== null && state.gameState.players) {
          const opp = state.gameState.players[1 - state.playerID];
          if (opp) {
            state.oppSnaps[0] = state.oppSnaps[1];
            state.oppSnaps[1] = { x: opp.x, y: opp.y };
            state.lastSnapAt = performance.now();
          }
        }

        if (prev) {
          detectSoundEvents(prev.players, msg.state.players);
          detectHitEffects(prev.players, msg.state.players);
        }

        if (msg.state.phase === 'countdown' && msg.state.countdown !== state.prevCountdown) {
          if (msg.state.countdown > 0) playSound('countdown');
          state.prevCountdown = msg.state.countdown;
        }

        if (prev && prev.phase !== 'gameover' && msg.state.phase === 'gameover' && msg.state.winner) {
          const isWin = state.matchInfo && msg.state.winner === state.matchInfo.you;
          track('match_end', { result: isWin ? 'win' : 'loss', winner: msg.state.winner });
        }
      } else {
        // Spectating on menu or waiting screen — just update spectateState.
        state.spectateState = msg.state;
        // If gameover, schedule clearing the canvas after the match closes.
        if (msg.state.phase === 'gameover') {
          scheduleSpectateClear();
        } else {
          cancelSpectateClear();
        }
        callbacks?.onSpectateUpdate();
      }
      break;
    }

    case 'opponent_left':
      if (state.gameState) {
        state.gameState = {
          ...state.gameState,
          phase: 'gameover',
          winner: state.matchInfo?.you ?? 'You',
        };
      }
      track('match_end', { result: 'opponent_disconnected' });
      break;

    case 'queue_status':
      if (state.phase === 'menu' || state.phase === 'waiting') {
        callbacks?.onQueueStatus(msg.status);
      }
      break;
  }
}

// ── Sound event detection ─────────────────────────────────────────────────────

type MaybePlayers = readonly [
  { state: string } | undefined | null,
  { state: string } | undefined | null,
] | undefined | null;

function detectSoundEvents(prevPlayers: MaybePlayers, currPlayers: MaybePlayers): void {
  for (let i = 0; i < 2; i++) {
    const ps = prevPlayers?.[i];
    const cs = currPlayers?.[i];
    if (!ps || !cs) continue;
    if (ps.state !== cs.state) {
      if (cs.state === 'attack_fist')     playSound('fist');
      if (cs.state === 'attack_leg')      playSound('leg');
      if (cs.state === 'attack_uppercut') playSound('uppercut');
      if (cs.state === 'hurt')            { playSound('hit'); state.hitFlash[i] = 8; }
      if (cs.state === 'ko')              playSound('ko');
      if (cs.state === 'blocking' && ps.state !== 'blocking') playSound('block');
      if (cs.state === 'jumping')         playSound('jump');
    }
  }
}

// ── Hit effect detection ──────────────────────────────────────────────────────

function detectHitEffects(
  prevPlayers: readonly (PlayerState | undefined | null)[] | undefined | null,
  currPlayers: readonly (PlayerState | undefined | null)[] | undefined | null,
): void {
  for (let i = 0; i < 2; i++) {
    const prev = prevPlayers?.[i];
    const curr = currPlayers?.[i];
    if (!prev || !curr) continue;
    if (curr.hp < prev.hp) {
      // HP dropped this tick — spawn a hit effect at the defender's chest centre
      const cx = curr.x + PLAYER_W / 2;
      const cy = curr.y + PLAYER_H * 0.35;
      // Guess kind: projectiles knock back hard, melee has attackBox
      const kind = (Math.abs((curr as PlayerState & { vx?: number }).vx ?? 0) > 3.5)
        ? 'projectile' as const
        : 'melee' as const;
      state.hitEffects.push({ x: cx, y: cy, startMs: performance.now(), kind });
    }
  }
  // Prune finished effects (older than 500ms)
  const cutoff = performance.now() - 500;
  state.hitEffects = state.hitEffects.filter(fx => fx.startMs > cutoff);
}

// ── Input loop ────────────────────────────────────────────────────────────────

export function startInputLoop(): void {
  stopInputLoop();
  state.inputInterval = setInterval(() => sendInput(), 1000 / 60);
}

export function stopInputLoop(): void {
  if (state.inputInterval !== null) {
    clearInterval(state.inputInterval);
    state.inputInterval = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (state.phase !== 'game') return;
  if (document.visibilityState === 'hidden') stopInputLoop();
  else startInputLoop();
});

// ── Key → action mapping ──────────────────────────────────────────────────────

const KEY_MAP: Record<string, keyof Keys> = {
  ArrowLeft:  'left',
  ArrowRight: 'right',
  ArrowUp:    'jump',
  ' ':        'jump',
  a: 'fist',  A: 'fist',
  s: 'leg',   S: 'leg',
  d: 'uppercut', D: 'uppercut',
  f: 'block', F: 'block',
  g: 'dodge', G: 'dodge',
  h: 'shoot', H: 'shoot',
};

function isInputFocused(): boolean {
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

document.addEventListener('keydown', e => {
  if (isInputFocused()) return;
  const action = KEY_MAP[e.key];
  if (!action) return;
  e.preventDefault();
  if (!state.keys[action]) {
    state.keys[action] = true;
    if (action === 'fist')     { state.attackBuf.push('attack_fist');     tryPredictAttack('attack_fist');     playSound('fist'); }
    if (action === 'leg')      { state.attackBuf.push('attack_leg');      tryPredictAttack('attack_leg');      playSound('leg'); }
    if (action === 'uppercut') { state.attackBuf.push('attack_uppercut'); tryPredictAttack('attack_uppercut'); playSound('uppercut'); }
    if (action === 'dodge')    { (state.attackBuf as ActionEventName[]).push('dodge'); }
    if (action === 'jump')     { (state.attackBuf as ActionEventName[]).push('jump'); }
    sendInput();
  }
});

document.addEventListener('keyup', e => {
  if (isInputFocused()) return;
  const action = KEY_MAP[e.key];
  if (action) { state.keys[action] = false; sendInput(); }
});
