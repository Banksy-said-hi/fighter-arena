'use strict';

// ── Constants (game canvas) ───────────────────────────────────────────────────
const W        = 800, H = 450;
const GROUND_Y = 370;
const PLAYER_W = 50;
const PLAYER_H = 80;

// ── Game canvas ───────────────────────────────────────────────────────────────
const canvas = document.getElementById('game-canvas');
const ctx    = canvas.getContext('2d');

// ── Global state ──────────────────────────────────────────────────────────────
let ws        = null;
let playerID  = null;
let matchInfo = null;
let gameState = null;
let phase     = 'menu'; // 'menu' | 'game'

let fightFlash = 0;
let hitFlash   = [0, 0];

// ── Input ─────────────────────────────────────────────────────────────────────
const keys = {
  left: false, right: false, jump: false,
  fist: false, leg: false, uppercut: false,
  block: false, dodge: false,
};

const keyMap = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'jump', ' ': 'jump',
  a: 'fist',   A: 'fist',
  s: 'leg',    S: 'leg',
  d: 'uppercut', D: 'uppercut',
  f: 'block',  F: 'block',
  g: 'dodge',  G: 'dodge',
};

function sendInputNow() {
  if (ws && ws.readyState === WebSocket.OPEN && phase === 'game') {
    ws.send(JSON.stringify({ type: 'input', keys }));
  }
}

document.addEventListener('keydown', e => {
  const a = keyMap[e.key];
  if (a) { e.preventDefault(); if (!keys[a]) { keys[a] = true; sendInputNow(); } }
});
document.addEventListener('keyup', e => {
  const a = keyMap[e.key];
  if (a) { keys[a] = false; sendInputNow(); }
});

// ── Audio ─────────────────────────────────────────────────────────────────────
let audioCtx = null;
function ac() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function beep({ type = 'square', freq = 300, endFreq, duration = 0.1, volume = 0.25, delay = 0 } = {}) {
  try {
    const a    = ac();
    const osc  = a.createOscillator();
    const gain = a.createGain();
    osc.connect(gain); gain.connect(a.destination);
    osc.type = type;
    const t = a.currentTime + delay;
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t + duration);
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.start(t); osc.stop(t + duration + 0.01);
  } catch (_) {}
}

function playSound(name) {
  switch (name) {
    case 'fist':      beep({ type: 'square',   freq: 220, endFreq: 80,  duration: 0.10 }); break;
    case 'leg':       beep({ type: 'sawtooth', freq: 160, endFreq: 55,  duration: 0.14 }); break;
    case 'uppercut':
      beep({ type: 'square', freq: 110, endFreq: 380, duration: 0.06 });
      beep({ type: 'square', freq: 380, endFreq: 50,  duration: 0.18, delay: 0.06 });
      break;
    case 'hit':       beep({ type: 'square',   freq: 350, endFreq: 90,  duration: 0.08, volume: 0.45 }); break;
    case 'block':     beep({ type: 'triangle', freq: 600, endFreq: 400, duration: 0.07, volume: 0.2  }); break;
    case 'ko':        beep({ type: 'sawtooth', freq: 440, endFreq: 55,  duration: 0.55, volume: 0.6  }); break;
    case 'countdown': beep({ type: 'sine',     freq: 440,                duration: 0.18, volume: 0.3  }); break;
    case 'fight':
      [440, 550, 660].forEach((f, i) =>
        beep({ type: 'sine', freq: f, duration: 0.2, volume: 0.3, delay: i * 0.11 })
      );
      break;
    case 'jump':      beep({ type: 'sine', freq: 300, endFreq: 500, duration: 0.12, volume: 0.15 }); break;
  }
}

// ── Client-side prediction ────────────────────────────────────────────────────
// Mirrors server physics so local player movement feels instant regardless of ping.
// Server remains authoritative for combat, damage and opponent position.

const PRED = {
  gravity:   0.65,
  jumpVel:  -13.5,
  moveSpeed: 5.0,
  maxFall:   18.0,
};

let pred = null; // { x, y, vx, vy }

// States where we trust the server completely (combat / reactions)
const SERVER_ONLY_STATES = new Set([
  'attack_fist', 'attack_leg', 'attack_uppercut',
  'blocking', 'dodging', 'hurt', 'ko',
]);

function initPred(sp) {
  pred = { x: sp.x, y: sp.y, vx: 0, vy: 0 };
}

function stepPred() {
  if (!pred || playerID === null || !gameState || gameState.phase !== 'fighting') return;
  const sp = gameState.players && gameState.players[playerID];
  if (!sp || SERVER_ONLY_STATES.has(sp.state)) return; // let server drive

  const onGround = pred.y >= GROUND_Y - PLAYER_H - 1;

  if (keys.left)       pred.vx = -PRED.moveSpeed;
  else if (keys.right) pred.vx =  PRED.moveSpeed;
  else { pred.vx *= 0.65; if (Math.abs(pred.vx) < 0.3) pred.vx = 0; }

  if (keys.jump && onGround) pred.vy = PRED.jumpVel;

  pred.vy += PRED.gravity;
  if (pred.vy > PRED.maxFall) pred.vy = PRED.maxFall;

  pred.x += pred.vx;
  pred.y += pred.vy;

  if (pred.y >= GROUND_Y - PLAYER_H) { pred.y = GROUND_Y - PLAYER_H; pred.vy = 0; }
  if (pred.x < 0)           { pred.x = 0;           pred.vx = 0; }
  if (pred.x > W - PLAYER_W){ pred.x = W - PLAYER_W; pred.vx = 0; }
}

function reconcilePred(sp) {
  if (!pred) { initPred(sp); return; }
  const dx = sp.x - pred.x;
  const dy = sp.y - pred.y;
  // Small drift → gentle lerp.  Large drift → snap.
  if (Math.abs(dx) < 80 && Math.abs(dy) < 80) {
    pred.x += dx * 0.12;
    pred.y += dy * 0.12;
  } else {
    pred.x = sp.x;
    pred.y = sp.y;
    pred.vx = 0;
    pred.vy = 0;
  }
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const queueScreen = document.getElementById('queue-screen');
const gameScreen  = document.getElementById('game-screen');
const nameInput   = document.getElementById('name-input');
const joinBtn     = document.getElementById('join-btn');
const shareBtn    = document.getElementById('share-btn');
const cancelBtn   = document.getElementById('cancel-btn');
const nameForm    = document.getElementById('name-form');
const queueStatus = document.getElementById('queue-status');
const queueMsg    = document.getElementById('queue-msg');
const toastEl     = document.getElementById('toast');

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

// ── Share link ────────────────────────────────────────────────────────────────
shareBtn.addEventListener('click', () => {
  const url = window.location.href.split('?')[0]; // clean URL
  navigator.clipboard.writeText(url).then(
    () => showToast('LINK COPIED!'),
    () => {
      // Fallback for browsers that block clipboard
      prompt('Share this link:', url);
    }
  );
});

// ── Join / cancel ─────────────────────────────────────────────────────────────
joinBtn.addEventListener('click', joinQueue);
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinQueue(); });
cancelBtn.addEventListener('click', () => {
  if (ws) { ws.close(); ws = null; }
  nameForm.classList.remove('hidden');
  queueStatus.classList.add('hidden');
});

function joinQueue() {
  const name = nameInput.value.trim() || 'Fighter';
  connect(name);
}

function showQueueScreen() {
  gameScreen.classList.add('hidden');
  queueScreen.classList.remove('hidden');
  nameForm.classList.remove('hidden');
  queueStatus.classList.add('hidden');
  phase = 'menu';
  startMenuAnimation();
}

function showGameScreen() {
  stopMenuAnimation();
  queueScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  phase = 'game';
  startInputLoop();
  requestAnimationFrame(gameRenderLoop);
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connect(playerName) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join_queue', name: playerName }));
    nameForm.classList.add('hidden');
    queueStatus.classList.remove('hidden');
    queueMsg.textContent = 'Connecting…';
  };

  ws.onmessage = e => handleMsg(JSON.parse(e.data));

  ws.onclose = () => {
    if (phase !== 'menu') {
      showQueueScreen();
      queueMsg.textContent = 'Disconnected. Refresh to try again.';
    }
  };

  ws.onerror = () => {
    queueMsg.textContent = 'Cannot reach server. Is it running on :8080?';
  };
}

let prevCountdown = 4;

function handleMsg(msg) {
  switch (msg.type) {
    case 'queued':
      queueMsg.textContent = msg.message;
      break;

    case 'match_found':
      playerID  = msg.player_id;
      matchInfo = { you: msg.you, opponent: msg.opponent };
      prevCountdown = 4;
      showGameScreen();
      break;

    case 'fight_start':
      playSound('fight');
      fightFlash = 70;
      break;

    case 'state': {
      const prev = gameState;
      gameState  = msg.state;
      // Reconcile local prediction with authoritative server position
      if (playerID !== null && gameState.players && gameState.players[playerID]) {
        reconcilePred(gameState.players[playerID]);
      }
      if (prev) detectSoundEvents(prev, gameState);
      if (gameState.phase === 'countdown' && gameState.countdown !== prevCountdown) {
        if (gameState.countdown > 0) playSound('countdown');
        prevCountdown = gameState.countdown;
      }
      break;
    }

    case 'opponent_left':
      if (gameState) {
        gameState.phase  = 'gameover';
        gameState.winner = matchInfo ? matchInfo.you : 'You';
      }
      break;
  }
}

function detectSoundEvents(prev, curr) {
  for (let i = 0; i < 2; i++) {
    const ps = prev.players && prev.players[i];
    const cs = curr.players && curr.players[i];
    if (!ps || !cs) continue;
    if (ps.state !== cs.state) {
      if (cs.state === 'attack_fist')     playSound('fist');
      if (cs.state === 'attack_leg')      playSound('leg');
      if (cs.state === 'attack_uppercut') playSound('uppercut');
      if (cs.state === 'hurt')            { playSound('hit'); hitFlash[i] = 8; }
      if (cs.state === 'ko')              playSound('ko');
      if (cs.state === 'blocking' && ps.state !== 'blocking') playSound('block');
      if (cs.state === 'jumping')         playSound('jump');
    }
  }
}

// ── Input loop ────────────────────────────────────────────────────────────────
let inputInterval = null;
function startInputLoop() {
  clearInterval(inputInterval);
  inputInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN && phase === 'game') {
      ws.send(JSON.stringify({ type: 'input', keys }));
    }
  }, 1000 / 30);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── MENU ANIMATION ────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

let menuRaf    = null;
let previewTick = 0;

// Preview canvas dimensions
const PW = 420, PH = 190;
// Preview scale (characters are ~0.75x game size)
const SC   = 0.75;
const PW_P = Math.round(PLAYER_W * SC); // 37
const PH_P = Math.round(PLAYER_H * SC); // 60
const PGY  = 155; // ground Y in preview

// Character card canvas dimensions
const CW = 130, CH = 180;

function startMenuAnimation() {
  stopMenuAnimation();
  previewTick = 0;

  const aliceCanvas   = document.getElementById('alice-canvas');
  const bobCanvas     = document.getElementById('bob-canvas');
  const previewCanvas = document.getElementById('preview-canvas');

  const actx = aliceCanvas.getContext('2d');
  const bctx = bobCanvas.getContext('2d');
  const pctx = previewCanvas.getContext('2d');

  function menuLoop() {
    if (phase !== 'menu') return;
    previewTick++;

    drawCharCard(actx, CW, CH, '#FF69B4', 1,  previewTick, 'ALICE');
    drawCharCard(bctx, CW, CH, '#FF8C00', -1, previewTick, 'BOB');
    drawPreview(pctx, PW, PH, previewTick);

    menuRaf = requestAnimationFrame(menuLoop);
  }

  menuRaf = requestAnimationFrame(menuLoop);
}

function stopMenuAnimation() {
  if (menuRaf !== null) { cancelAnimationFrame(menuRaf); menuRaf = null; }
}

// ── Character card drawing ────────────────────────────────────────────────────
function drawCharCard(cx, cw, ch, color, facing, tick, name) {
  cx.clearRect(0, 0, cw, ch);

  // Subtle background glow
  const grd = cx.createRadialGradient(cw/2, ch*0.5, 5, cw/2, ch*0.5, 70);
  grd.addColorStop(0, hexAlpha(color, 0.18));
  grd.addColorStop(1, 'transparent');
  cx.fillStyle = grd;
  cx.fillRect(0, 0, cw, ch);

  // Character sprite (centered, with idle breathing)
  const breath = Math.sin(tick / 40) * 2;
  const spW = 52, spH = 78;
  const sx = (cw - spW) / 2;
  const sy = ch - spH - 14 + breath;

  drawSprite(cx, sx, sy, spW, spH, color, facing, tick, 'idle');

  // Ground line
  cx.fillStyle = 'rgba(255,255,255,0.08)';
  cx.fillRect(8, ch - 16, cw - 16, 2);

  // Shadow under character
  cx.fillStyle = 'rgba(0,0,0,0.3)';
  cx.beginPath();
  cx.ellipse(cw/2, ch - 14, 22, 5, 0, 0, Math.PI * 2);
  cx.fill();
}

// ── Battle preview scripted animation ────────────────────────────────────────
const LOOP_LEN = 380; // frames per full loop

// Returns the preview scene for a given tick
function getPreviewScene(t) {
  const f = t % LOOP_LEN;

  // Default
  let ax = 55, ay = PGY - PH_P;
  let bx = PW - 55 - PW_P, by = PGY - PH_P;
  let aState = 'idle', bState = 'idle';
  let aHP = 100, bHP = 100;
  let aFace = 1, bFace = -1;

  // ── Phase 1: 0-50 idle taunt ──────────────────────────────
  if (f < 50) {
    // idle, slight hop on bob
    if (f > 20 && f < 35) bState = 'jumping';
  }
  // ── Phase 2: 50-100 Alice walks in ───────────────────────
  else if (f < 100) {
    const pct = (f - 50) / 50;
    ax = 55 + pct * 55;
    aState = 'walking';
    bHP = 100; aHP = 100;
  }
  // ── Phase 3: 100-120 Alice throws fist ───────────────────
  else if (f < 120) {
    ax = 110;
    aState = 'attack_fist';
    bHP = 100; aHP = 100;
  }
  // ── Phase 4: 120-155 Bob hurt, knocked back ───────────────
  else if (f < 155) {
    ax = 110;
    bx = PW - 55 - PW_P + (f - 120) * 1.2;
    aState = 'idle';
    bState = f < 138 ? 'hurt' : 'idle';
    bHP = 90; aHP = 100;
    bFace = -1;
  }
  // ── Phase 5: 155-210 Bob walks toward Alice ───────────────
  else if (f < 210) {
    const pct = (f - 155) / 55;
    ax = 110;
    bx = Math.max((PW - 55 - PW_P + 42) - pct * 100, ax + PW_P + 20);
    bState = 'walking';
    bHP = 90; aHP = 100;
  }
  // ── Phase 6: 210-230 Bob leg kick ────────────────────────
  else if (f < 230) {
    ax = 110; bx = ax + PW_P + 22;
    bState = 'attack_leg';
    bHP = 90; aHP = 100;
    aFace = 1; bFace = -1;
  }
  // ── Phase 7: 230-260 Alice blocking / hurt ────────────────
  else if (f < 260) {
    ax = 110; bx = ax + PW_P + 22;
    aState = f < 248 ? 'blocking' : 'idle';
    bState = 'idle';
    bHP = 90; aHP = 93;
  }
  // ── Phase 8: 260-290 Alice uppercut ──────────────────────
  else if (f < 290) {
    ax = 110; bx = ax + PW_P + 22;
    aState = 'attack_uppercut';
    bState = f < 275 ? 'idle' : 'hurt';
    bHP = f < 278 ? 90 : 65;
    aHP = 93;
    // small hop for uppercut
    if (f < 275) ay = PGY - PH_P - Math.sin((f-260)/15 * Math.PI) * 18;
  }
  // ── Phase 9: 290-320 Bob KO flash ────────────────────────
  else if (f < 320) {
    ax = 110; bx = ax + PW_P + 30 + (f - 290) * 1.5;
    aState = 'idle'; bState = 'hurt';
    bHP = 65; aHP = 93;
  }
  // ── Phase 10: 320-380 Reset walk back ────────────────────
  else {
    const pct = (f - 320) / 60;
    ax = 110 - pct * 60;
    bx = Math.min(PW - 55 - PW_P, (ax + PW_P + 50) + pct * 70);
    aState = pct > 0.1 ? 'walking' : 'idle';
    bState = pct > 0.1 ? 'walking' : 'idle';
    aFace = pct < 0.5 ? -1 : 1;
    bFace = pct < 0.5 ? 1 : -1;
    bHP = 65 + Math.round(pct * 35); // "health restore" effect while walking back
    aHP = 93 + Math.round(pct * 7);
  }

  // Clamp positions
  ax = Math.max(2, Math.min(PW - PW_P - 2, ax));
  bx = Math.max(2, Math.min(PW - PW_P - 2, bx));

  return { ax, ay, bx, by, aState, bState, aHP, bHP, aFace, bFace };
}

function drawPreview(cx, pw, ph, tick) {
  cx.clearRect(0, 0, pw, ph);

  // Background
  const bg = cx.createLinearGradient(0, 0, 0, PGY);
  bg.addColorStop(0, '#080014');
  bg.addColorStop(1, '#110025');
  cx.fillStyle = bg;
  cx.fillRect(0, 0, pw, ph);

  // Grid
  cx.strokeStyle = 'rgba(70, 0, 160, 0.25)';
  cx.lineWidth = 1;
  for (let x = 0; x <= pw; x += 30) {
    cx.beginPath(); cx.moveTo(x, 0); cx.lineTo(x, PGY); cx.stroke();
  }
  for (let y = 0; y <= PGY; y += 30) {
    cx.beginPath(); cx.moveTo(0, y); cx.lineTo(pw, y); cx.stroke();
  }

  // Ground
  cx.fillStyle = '#3a0060';
  cx.fillRect(0, PGY, pw, ph - PGY);
  const topEdge = cx.createLinearGradient(0, PGY - 2, 0, PGY + 5);
  topEdge.addColorStop(0, '#cc44ff');
  topEdge.addColorStop(1, '#660099');
  cx.fillStyle = topEdge;
  cx.fillRect(0, PGY, pw, 4);
  // Checkerboard on ground
  for (let x = 0; x < pw; x += 60) {
    cx.fillStyle = (x / 60) % 2 === 0 ? '#4a1080' : '#3a0060';
    cx.fillRect(x, PGY + 4, 60, ph - PGY - 4);
  }

  const sc = getPreviewScene(tick);

  // Health bars
  drawPreviewHPBar(cx, 6, 6, 120, 14, sc.aHP, 100, '#FF69B4', 'ALICE', false);
  drawPreviewHPBar(cx, pw - 126, 6, 120, 14, sc.bHP, 100, '#FF8C00', 'BOB', true);

  // Sprites
  drawSprite(cx, sc.ax, sc.ay, PW_P, PH_P, '#FF69B4', sc.aFace, tick, sc.aState);
  drawSprite(cx, sc.bx, sc.by, PW_P, PH_P, '#FF8C00', sc.bFace, tick, sc.bState);

  // LIVE badge
  cx.save();
  cx.fillStyle = '#ff2222';
  cx.beginPath(); cx.roundRect(pw - 44, ph - 20, 40, 14, 3); cx.fill();
  cx.fillStyle = '#fff';
  cx.font = 'bold 8px Courier New';
  cx.textAlign = 'center';
  cx.fillText('● LIVE', pw - 24, ph - 9);
  cx.restore();
}

function drawPreviewHPBar(cx, x, y, w, h, hp, maxHp, color, name, right) {
  const pct = Math.max(0, hp / maxHp);
  const bw  = Math.round(pct * (w - 2));
  const hpCol = pct > 0.5 ? '#44ff44' : pct > 0.25 ? '#ffcc00' : '#ff2222';

  cx.fillStyle = 'rgba(0,0,0,0.55)';
  cx.fillRect(x, y, w, h);

  cx.fillStyle = hpCol;
  if (right) cx.fillRect(x + 1 + (w - 2 - bw), y + 1, bw, h - 2);
  else        cx.fillRect(x + 1, y + 1, bw, h - 2);

  cx.strokeStyle = color;
  cx.lineWidth = 1.5;
  cx.strokeRect(x, y, w, h);

  cx.fillStyle = '#fff';
  cx.font = 'bold 7px Courier New';
  cx.textAlign = 'center';
  cx.fillText(`${name} ${hp}`, x + w / 2, y + h - 2);
}

// ── Shared sprite renderer (used for card + preview) ─────────────────────────
function drawSprite(cx, x, y, w, h, color, facing, tick, state) {
  const isWalking   = state === 'walking';
  const isAttacking = state.startsWith('attack_');
  const isHurt      = state === 'hurt';
  const isBlocking  = state === 'blocking';
  const isDodging   = state === 'dodging';
  const isJumping   = state === 'jumping';
  const isKO        = state === 'ko';

  cx.save();

  // Hurt flash
  if (isHurt) cx.globalAlpha = tick % 4 < 2 ? 0.35 : 1.0;

  // Dodge glow
  if (isDodging) { cx.shadowColor = '#00eeff'; cx.shadowBlur = 12; }

  if (isKO) {
    cx.globalAlpha = 0.5;
    cx.fillStyle = color;
    cx.fillRect(x - 8, y + h - 14, w + 18, 14);
  } else {
    // Body
    cx.fillStyle = color;
    cx.fillRect(x, y + Math.round(h * 0.32), w, Math.round(h * 0.68));

    // Head
    cx.fillStyle = lighten(color, 28);
    cx.fillRect(x + 3, y, w - 6, Math.round(h * 0.36));

    // Eye
    const eyeX = facing === 1 ? x + w - 12 : x + 4;
    const eyeY = y + Math.round(h * 0.08);
    const es = Math.max(3, Math.round(w * 0.14));
    cx.fillStyle = '#fff';
    cx.fillRect(eyeX, eyeY, es, es);
    cx.fillStyle = '#111';
    cx.fillRect(eyeX + (facing === 1 ? 2 : 1), eyeY + 1, Math.max(2, es - 2), Math.max(2, es - 2));

    // Legs
    const legY = y + Math.round(h * 0.68);
    const legH = h - Math.round(h * 0.68);
    cx.fillStyle = darken(color, 25);
    const bob = isWalking ? Math.sin(tick / 7) * 3 : 0;
    cx.fillRect(x + 3,         legY + bob,  Math.round(w * 0.27), legH - bob);
    cx.fillRect(x + w - 3 - Math.round(w * 0.27), legY - bob,  Math.round(w * 0.27), legH + bob);

    // Arms
    cx.fillStyle = lighten(color, 12);
    const armY = y + Math.round(h * 0.36);
    const armW = Math.round(w * 0.18);
    if (isAttacking) {
      const aExtX = facing === 1 ? x + w : x - Math.round(w * 0.4);
      const aOffY = state === 'attack_leg' ? Math.round(h * 0.4)
                  : state === 'attack_uppercut' ? -Math.round(h * 0.1)
                  : Math.round(h * 0.12);
      cx.fillRect(aExtX, armY + aOffY, Math.round(w * 0.38), Math.round(h * 0.13));
    } else {
      cx.fillRect(x - 2,     armY, armW, Math.round(h * 0.28));
      cx.fillRect(x + w - armW + 2, armY, armW, Math.round(h * 0.28));
    }

    // Block shield
    if (isBlocking) {
      cx.save();
      cx.strokeStyle = 'rgba(140,140,255,0.9)';
      cx.lineWidth = 2;
      cx.shadowColor = '#8888ff';
      cx.shadowBlur = 10;
      cx.strokeRect(x - 4, y - 4, w + 8, h + 8);
      cx.restore();
    }
  }

  cx.restore();
}

// ══════════════════════════════════════════════════════════════════════════════
// ── GAME RENDER LOOP ──────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

function gameRenderLoop() {
  if (phase !== 'game') return;
  renderGame();
  requestAnimationFrame(gameRenderLoop);
}

function renderGame() {
  stepPred(); // advance local prediction every animation frame (~60fps)
  ctx.clearRect(0, 0, W, H);

  if (!gameState) { drawLoading(); return; }

  drawBackground();
  drawGround();

  if (gameState.players) {
    for (const p of gameState.players) {
      if (p) drawGamePlayer(p);
    }
  }

  drawHUD();

  if (gameState.phase === 'countdown') drawCountdown(gameState.countdown);
  if (fightFlash > 0) { drawFightText(); fightFlash--; }
  if (gameState.phase === 'gameover') drawGameOver();

  for (let i = 0; i < 2; i++) { if (hitFlash[i] > 0) hitFlash[i]--; }
}

// ── Background & ground ───────────────────────────────────────────────────────
function drawBackground() {
  const g = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  g.addColorStop(0, '#07001a');
  g.addColorStop(1, '#140030');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(80,0,180,0.22)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 40) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, GROUND_Y); ctx.stroke();
  }
  for (let y = 0; y <= GROUND_Y; y += 40) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  [[50,30],[200,60],[380,20],[560,45],[720,70],[130,100],[310,80],[480,110],[650,35],[760,95]]
    .forEach(([sx, sy]) => ctx.fillRect(sx, sy, 2, 2));
}

function drawGround() {
  ctx.fillStyle = '#3a0060';
  ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
  for (let x = 0; x < W; x += 80) {
    ctx.fillStyle = (x / 80) % 2 === 0 ? '#4a1080' : '#3a0060';
    ctx.fillRect(x, GROUND_Y + 4, 80, H - GROUND_Y - 4);
  }
  const edge = ctx.createLinearGradient(0, GROUND_Y - 2, 0, GROUND_Y + 6);
  edge.addColorStop(0, '#cc44ff');
  edge.addColorStop(1, '#6600cc');
  ctx.fillStyle = edge;
  ctx.fillRect(0, GROUND_Y, W, 5);
}

// ── Full-size game player (delegates to drawSprite) ───────────────────────────
function drawGamePlayer(p) {
  // Use predicted position for local player during free movement
  let x, y;
  if (p.id === playerID && pred && !SERVER_ONLY_STATES.has(p.state)) {
    x = Math.round(pred.x);
    y = Math.round(pred.y);
  } else {
    x = Math.round(p.x);
    y = Math.round(p.y);
  }

  ctx.save();
  if (hitFlash[p.id] > 0) ctx.globalAlpha = hitFlash[p.id] % 2 === 0 ? 0.3 : 1.0;
  drawSprite(ctx, x, y, PLAYER_W, PLAYER_H, p.color, p.facing, Date.now() / 16, p.state);
  ctx.restore();

  // Name tag
  if (p.state !== 'ko') {
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px Courier New';
    ctx.textAlign = 'center';
    ctx.shadowColor = '#000'; ctx.shadowBlur = 5;
    ctx.fillText(p.name, x + PLAYER_W / 2, y - 7);
    ctx.restore();
  }

  // Attack hitbox (debug)
  if (p.attackActive && p.attackBox) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,60,60,0.6)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(p.attackBox.x, p.attackBox.y, p.attackBox.w, p.attackBox.h);
    ctx.restore();
  }
}

// ── HUD ───────────────────────────────────────────────────────────────────────
function drawHUD() {
  if (!gameState || !gameState.players) return;
  const [p1, p2] = gameState.players;
  if (!p1 || !p2) return;

  drawHealthBar(10,       10, 240, 28, p1, false);
  drawHealthBar(W - 250,  10, 240, 28, p2, true);

  ctx.save();
  ctx.font = 'bold 20px Courier New';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#FFD700';
  ctx.shadowColor = '#FF6600'; ctx.shadowBlur = 10;
  ctx.fillText('VS', W / 2, 30);
  ctx.restore();

  if (playerID !== null) {
    const isLeft = playerID === 0;
    ctx.save();
    ctx.font = 'bold 10px Courier New';
    ctx.fillStyle = '#00ff99';
    ctx.textAlign = isLeft ? 'left' : 'right';
    ctx.fillText(isLeft ? '▲ YOU' : 'YOU ▲', isLeft ? 12 : W - 12, 52);
    ctx.restore();
  }
}

function drawHealthBar(x, y, w, h, p, rightAlign) {
  const pct  = Math.max(0, p.hp / p.maxHp);
  const barW = Math.round(pct * (w - 4));
  const hpCol = pct > 0.5 ? '#44ff44' : pct > 0.25 ? '#ffcc00' : '#ff2222';

  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(x, y, w, h);

  ctx.fillStyle = hpCol;
  if (rightAlign) ctx.fillRect(x + 2 + (w - 4 - barW), y + 2, barW, h - 4);
  else             ctx.fillRect(x + 2, y + 2, barW, h - 4);

  ctx.strokeStyle = p.color;
  ctx.lineWidth = 2;
  ctx.shadowColor = p.color; ctx.shadowBlur = 6;
  ctx.strokeRect(x, y, w, h);
  ctx.shadowBlur = 0;

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px Courier New';
  ctx.textAlign = 'center';
  ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
  ctx.fillText(`${p.name}  ${p.hp}/${p.maxHp}`, x + w / 2, y + h - 6);
  ctx.shadowBlur = 0;
}

// ── Countdown & overlays ──────────────────────────────────────────────────────
function drawCountdown(count) {
  if (count <= 0) return;
  ctx.save();
  ctx.font = 'bold 130px Courier New';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFD700';
  ctx.shadowColor = '#FF6600'; ctx.shadowBlur = 40;
  ctx.fillText(String(count), W / 2, H / 2);
  ctx.restore();
}

function drawFightText() {
  const alpha = Math.min(1, fightFlash / 25);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = 'bold 110px Courier New';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FF6600';
  ctx.shadowColor = '#FF0000'; ctx.shadowBlur = 50;
  ctx.fillText('FIGHT!', W / 2, H / 2);
  ctx.restore();
}

function drawGameOver() {
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  ctx.fillRect(0, 0, W, H);

  const winner = gameState.winner || '???';
  const isMe   = matchInfo && winner === matchInfo.you;

  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

  ctx.font = 'bold 88px Courier New';
  ctx.fillStyle = '#FF2222';
  ctx.shadowColor = '#FF0000'; ctx.shadowBlur = 40;
  ctx.fillText('K.O.!', W / 2, H / 2 - 65);

  ctx.font = 'bold 42px Courier New';
  ctx.fillStyle = '#FFD700';
  ctx.shadowColor = '#FF8800'; ctx.shadowBlur = 20;
  ctx.fillText(`${winner} WINS!`, W / 2, H / 2 + 18);

  ctx.font = 'bold 22px Courier New';
  ctx.fillStyle = isMe ? '#00ff88' : '#ff4466';
  ctx.shadowBlur = 10;
  ctx.fillText(isMe ? 'VICTORY!' : 'DEFEATED', W / 2, H / 2 + 72);
  ctx.restore();
}

function drawLoading() {
  ctx.fillStyle = '#0d001a';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#FFD700';
  ctx.font = '22px Courier New';
  ctx.textAlign = 'center';
  ctx.fillText('Loading…', W / 2, H / 2);
}

// ── Colour helpers ────────────────────────────────────────────────────────────
function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function lighten(hex, amt) {
  const [r, g, b] = hexToRgb(hex);
  return `rgb(${Math.min(255,r+amt)},${Math.min(255,g+amt)},${Math.min(255,b+amt)})`;
}
function darken(hex, amt) {
  const [r, g, b] = hexToRgb(hex);
  return `rgb(${Math.max(0,r-amt)},${Math.max(0,g-amt)},${Math.max(0,b-amt)})`;
}
function hexAlpha(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
startMenuAnimation();
