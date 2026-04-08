import type { QueueStatus, LeaderboardEntry } from './types';
import { state } from './state';
import { showBgCanvas, hideBgCanvas } from './renderer';
import { connectSpectator, joinQueueFromSpectate } from './network';
import { track } from './analytics';

// ── DOM refs ───────────────────────────────────────────────────────────────────

export const loginScreen    = document.getElementById('login-screen')!;
export const nicknameScreen = document.getElementById('nickname-screen')!;
export const queueScreen    = document.getElementById('queue-screen')!;
export const gameScreen     = document.getElementById('game-screen')!;
export const nameInput      = document.getElementById('name-input')    as HTMLInputElement;
export const joinBtn        = document.getElementById('join-btn')!;
export const privateBtn     = document.getElementById('private-btn')!;
export const cancelBtn      = document.getElementById('cancel-btn')!;
export const nameForm       = document.getElementById('name-form')!;
export const queueStatus    = document.getElementById('queue-status')!;
export const queueMsg       = document.getElementById('queue-msg')!;
export const toastEl        = document.getElementById('toast')!;
export const nickInput      = document.getElementById('nick-input')    as HTMLInputElement;
export const nickBtn        = document.getElementById('nick-btn')!;
export const nickError      = document.getElementById('nick-error')!;
export const welcomeBar     = document.getElementById('welcome-bar')!;
export const welcomeMsg     = document.getElementById('welcome-msg')!;
export const waitingOverlay = document.getElementById('waiting-overlay')!;
export const woShareBtn     = document.getElementById('wo-share-btn')!;
export const woCancelBtn    = document.getElementById('wo-cancel-btn')!;
export const spectateNameplates = document.getElementById('spectate-nameplates')!;
export const npP1Name           = document.getElementById('np-p1-name')!;
export const npP2Name           = document.getElementById('np-p2-name')!;

// ── Toast ──────────────────────────────────────────────────────────────────────

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

// ── Screen transitions ─────────────────────────────────────────────────────────

export function showQueueScreen(): void {
  [loginScreen, nicknameScreen, gameScreen].forEach(s => s.classList.add('hidden'));
  hideWaitingOverlay();
  queueScreen.classList.remove('hidden');
  showBgCanvas();
  queueStatus.classList.add('hidden');
  state.phase = 'menu';

  const joinLabel = joinBtn.querySelector('.btn-label');
  if (state.authedNickname) {
    nameInput.classList.add('hidden');
    nameInput.value = state.authedNickname;
    if (joinLabel) joinLabel.textContent = `FIGHT AS ${state.authedNickname.toUpperCase()}`;
  } else {
    nameInput.classList.remove('hidden');
    if (joinLabel) joinLabel.textContent = 'PLAY NEXT';
  }
  nameForm.classList.remove('hidden');

  fetchLeaderboard();
  fetchQueue();
}

let onWaitingStart: (() => void) | null = null;
let onGameStart: (() => void) | null = null;

/** Call from main.ts to hook into screen transitions without circular imports. */
export function setScreenCallbacks(cb: { onWaitingStart?: () => void; onGameStart?: () => void }): void {
  if (cb.onWaitingStart) onWaitingStart = cb.onWaitingStart;
  if (cb.onGameStart)    onGameStart    = cb.onGameStart;
}

export function showWaitingScreen(): void {
  hideBgCanvas();
  queueScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  waitingOverlay.classList.remove('hidden');
  state.phase = 'waiting';
  (document.activeElement as HTMLElement | null)?.blur();
  onWaitingStart?.();
}

export function hideWaitingOverlay(): void {
  waitingOverlay.classList.add('hidden');
}

export function showGameScreen(): void {
  hideWaitingOverlay();
  gameScreen.classList.remove('hidden');
  state.phase = 'game';
  (document.activeElement as HTMLElement | null)?.blur();
  onGameStart?.();
}

function showLoginScreen(): void {
  [queueScreen, nicknameScreen, gameScreen].forEach(s => s.classList.add('hidden'));
  loginScreen.classList.remove('hidden');
}

function showNicknameScreen(): void {
  [queueScreen, loginScreen, gameScreen].forEach(s => s.classList.add('hidden'));
  nicknameScreen.classList.remove('hidden');
}

function showWelcomeBar(nickname: string): void {
  welcomeMsg.innerHTML = `Welcome back, <strong>${nickname}</strong>`;
  welcomeBar.classList.remove('hidden');
}

// ── Queue join / cancel ────────────────────────────────────────────────────────

function joinQueue(): void {
  const name = state.authedNickname ?? (nameInput.value.trim() || 'Fighter');
  state.queuedAs = name;
  track('click_join', { name });
  // Upgrade the existing spectate socket (or open fresh) to join the queue.
  joinQueueFromSpectate(name);
  showWaitingScreen();
}

joinBtn.addEventListener('click', joinQueue);
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinQueue(); });
cancelBtn.addEventListener('click', () => {
  track('click_cancel_queue');
  if (state.ws) { state.ws.close(); state.ws = null; }
  nameForm.classList.remove('hidden');
  queueStatus.classList.add('hidden');
});

// ── Right panel tab switching ──────────────────────────────────────────────────

document.querySelectorAll<HTMLButtonElement>('.panel-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset['tab']!;
    document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel-pane').forEach(p => p.classList.add('hidden'));
    tab.classList.add('active');
    document.getElementById(`tab-${target}`)!.classList.remove('hidden');
    if (target === 'leaderboard') fetchLeaderboard();
  });
});

// ── Private room button ────────────────────────────────────────────────────────

privateBtn.addEventListener('click', () => {
  track('click_share');
  const name = state.authedNickname ?? (nameInput.value.trim() || 'Fighter');
  state.queuedAs = name;
  joinQueueFromSpectate(name);
  showWaitingScreen();
  const url = window.location.href.split('?')[0];
  navigator.clipboard.writeText(url).then(
    () => showToast('INVITE LINK COPIED!'),
    () => prompt('Share this link:', url),
  );
});

woShareBtn.addEventListener('click', () => {
  track('click_share_waiting');
  const url = window.location.href.split('?')[0];
  navigator.clipboard.writeText(url).then(
    () => {
      woShareBtn.textContent = 'COPIED!';
      setTimeout(() => { woShareBtn.textContent = 'COPY INVITE LINK'; }, 1800);
    },
    () => prompt('Share this link:', url),
  );
});

woCancelBtn.addEventListener('click', () => {
  track('click_cancel_queue');
  if (state.ws) { state.ws.close(); state.ws = null; }
  hideWaitingOverlay();
  showQueueScreen();
});

// ── Queue / leaderboard data ───────────────────────────────────────────────────

const RANK_MEDALS = ['🥇', '🥈', '🥉', '4', '5'];

export async function fetchLeaderboard(): Promise<void> {
  try {
    const res  = await fetch('/leaderboard');
    const data = await res.json() as LeaderboardEntry[];
    renderLeaderboard(data);
  } catch (_) { /* silent */ }
}

function renderLeaderboard(entries: LeaderboardEntry[]): void {
  const tbody = document.getElementById('leaderboard-body')!;
  if (!entries || entries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="lb-empty">No matches played yet</td></tr>';
    return;
  }
  tbody.innerHTML = entries.map(e => `
    <tr>
      <td class="lb-rank-${e.rank}">${RANK_MEDALS[e.rank - 1]}</td>
      <td class="lb-rank-${e.rank}">${e.name}</td>
      <td class="lb-wins">${e.wins} W</td>
    </tr>
  `).join('');
}

export async function fetchQueue(): Promise<void> {
  try {
    const res  = await fetch('/queue');
    const data = await res.json() as QueueStatus;
    renderQueue(data);
  } catch (_) { /* silent */ }
}

export function renderQueue(q: QueueStatus): void {
  const tbody = document.getElementById('queue-body');
  const stats = document.getElementById('server-stats');
  if (!q || !tbody || !stats) return;

  let rows = '';

  if (q.active_matches > 0) {
    rows += `<tr class="queue-fighting queue-row-clickable" data-action="watch">
      <td><span class="queue-dot dot-fighting"></span>Fighting</td>
      <td>${q.active_matches} match${q.active_matches !== 1 ? 'es' : ''}</td>
      <td class="queue-action-hint">▶ WATCH</td>
    </tr>`;
  }

  if (q.waiting_name) {
    const s = q.waiting_secs;
    const timeStr = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
    rows += `<tr class="queue-waiting queue-row-clickable" data-action="join">
      <td><span class="queue-dot dot-waiting"></span>Waiting</td>
      <td>${q.waiting_name}</td>
      <td class="queue-action-hint">⚔ CHALLENGE</td>
    </tr>`;
  }

  if (!rows) {
    rows = '<tr><td colspan="3" class="lb-empty">Queue is empty</td></tr>';
  }

  tbody.innerHTML = rows;
  stats.textContent = `${q.online} player${q.online !== 1 ? 's' : ''} online`;

  // Wire row clicks
  tbody.querySelectorAll<HTMLTableRowElement>('tr[data-action]').forEach(row => {
    row.addEventListener('click', () => {
      if (row.dataset['action'] === 'join') {
        joinQueue();
      } else if (row.dataset['action'] === 'watch') {
        // Switch right panel to Live Match tab
        const liveTab = document.querySelector<HTMLButtonElement>('.panel-tab[data-tab="spectate"]');
        liveTab?.click();
      }
    });
  });
}

// ── Auth flow ──────────────────────────────────────────────────────────────────

interface AuthMeResponse {
  authEnabled: boolean;
  authed: boolean;
  needsNick: boolean;
  nickname?: string;
}

export async function checkAuth(): Promise<void> {
  try {
    const res  = await fetch('/auth/me');
    const data = await res.json() as AuthMeResponse;

    if (!data.authEnabled) { showQueueScreen(); return; }
    if (!data.authed)      { showLoginScreen(); return; }
    if (data.needsNick)    { showNicknameScreen(); return; }

    state.authedNickname = data.nickname ?? null;
    if (data.nickname) showWelcomeBar(data.nickname);
    track('login_returning', { nickname: data.nickname });
    showQueueScreen();
  } catch (_) {
    showQueueScreen();
  }
}

/** Called from main.ts after auth resolves — opens spectate socket on menu. */
export function startSpectating(): void {
  connectSpectator();
}

/** Show or hide the spectate canvas nameplates based on current spectateMatchInfo. */
export function updateNameplates(): void {
  const info = state.spectateMatchInfo;
  if (info) {
    npP1Name.textContent = info.p1;
    npP2Name.textContent = info.p2;
    spectateNameplates.classList.remove('hidden');
  } else {
    spectateNameplates.classList.add('hidden');
  }
}

// ── Periodic data refresh ──────────────────────────────────────────────────────

fetchLeaderboard();
setInterval(() => { if (state.phase === 'menu') fetchLeaderboard(); }, 10_000);
fetchQueue();
