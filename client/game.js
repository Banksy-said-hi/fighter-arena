"use strict";
(() => {
  // src/state.ts
  var state = {
    ws: null,
    playerID: null,
    matchInfo: null,
    authedNickname: null,
    queuedAs: null,
    gameState: null,
    spectateState: null,
    spectateMatchInfo: null,
    phase: "menu",
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
      left: false,
      right: false,
      jump: false,
      fist: false,
      leg: false,
      uppercut: false,
      block: false,
      dodge: false,
      shoot: false
    },
    previewMode: false,
    previewBotTick: 0,
    previewAttackTimer: 0,
    previewAttackState: null,
    bgAnimating: false,
    inputInterval: null,
    menuRaf: null
  };

  // src/constants.ts
  var W = 1280;
  var H = 720;
  var GROUND_Y = 592;
  var PLAYER_W = 27;
  var PLAYER_H = 42;
  var GRAVITY = 0.52;
  var JUMP_VEL = -10.8;
  var MOVE_SPEED = 4;
  var MAX_FALL_SPEED = 14.4;
  var TICK_MS = 1e3 / 60;
  var MS_PER_FRAME = 150;
  var SPRITE_DISPLAY_H = 117;
  var STATE_TO_SPRITE = {
    idle: "idle",
    walking: "walk",
    jumping: "jump",
    attack_fist: "attack_fist",
    attack_leg: "attack_leg",
    attack_uppercut: "attack_uppercut",
    blocking: "blocking",
    dodging: "dodging",
    hurt: "hurt",
    ko: "ko"
  };
  var ATTACK_DURATIONS = {
    attack_fist: 36,
    attack_leg: 44,
    attack_uppercut: 56
  };
  var ATTACK_COOLDOWNS = {
    attack_fist: 56,
    attack_leg: 76,
    attack_uppercut: 110
  };
  var ATTACK_CD_KEY = {
    attack_fist: "fist",
    attack_leg: "leg",
    attack_uppercut: "uppercut"
  };
  var SERVER_ONLY_STATES = /* @__PURE__ */ new Set([
    "blocking",
    "dodging",
    "hurt",
    "ko"
  ]);
  var SC = 0.75;
  var PW_P = Math.round(PLAYER_W * SC);
  var PH_P = Math.round(PLAYER_H * SC);
  var PREVIEW_GRAVITY = 0.52;
  var PREVIEW_JUMP_VEL = -10.8;
  var PREVIEW_SPEED = 4;
  var PREVIEW_ATTACK_DURATION = 20;

  // src/prediction.ts
  function interpOppPos(serverX, serverY) {
    const [snap0, snap1] = state.oppSnaps;
    if (!snap0 || !snap1) return { x: serverX, y: serverY };
    const elapsed = performance.now() - state.lastSnapAt;
    const t = Math.min(1, elapsed / TICK_MS);
    return {
      x: snap0.x + (snap1.x - snap0.x) * t,
      y: snap0.y + (snap1.y - snap0.y) * t
    };
  }
  function tryPredictAttack(attackState) {
    if (state.phase !== "game") return;
    const cdKey = ATTACK_CD_KEY[attackState];
    if (state.localCooldowns[cdKey] > 0) return;
    state.predictedAttack = attackState;
    state.predictedAttackTick = ATTACK_DURATIONS[attackState];
    state.localCooldowns[cdKey] = ATTACK_COOLDOWNS[attackState];
  }
  function tickLocalCooldowns() {
    for (const k of Object.keys(state.localCooldowns)) {
      if (state.localCooldowns[k] > 0) state.localCooldowns[k]--;
    }
    if (state.predictedAttackTick > 0) {
      state.predictedAttackTick--;
      if (state.predictedAttackTick <= 0) state.predictedAttack = null;
    }
  }
  function initPred(x, y) {
    state.pred = { x, y, vx: 0, vy: 0 };
  }
  function stepPred() {
    tickLocalCooldowns();
    const { pred, playerID, gameState, keys } = state;
    if (!pred || playerID === null || !gameState || gameState.phase !== "fighting") return;
    const sp = gameState.players?.[playerID];
    if (!sp || SERVER_ONLY_STATES.has(sp.state)) return;
    const onGround = pred.y >= GROUND_Y - PLAYER_H - 1;
    if (keys.left) pred.vx = -MOVE_SPEED;
    else if (keys.right) pred.vx = MOVE_SPEED;
    else {
      pred.vx *= 0.81;
      if (Math.abs(pred.vx) < 0.15) pred.vx = 0;
    }
    if (keys.jump && onGround) pred.vy = JUMP_VEL;
    pred.vy += GRAVITY;
    if (pred.vy > MAX_FALL_SPEED) pred.vy = MAX_FALL_SPEED;
    pred.x += pred.vx;
    pred.y += pred.vy;
    if (pred.y >= GROUND_Y - PLAYER_H) {
      pred.y = GROUND_Y - PLAYER_H;
      pred.vy = 0;
    }
    if (pred.x < 0) {
      pred.x = 0;
      pred.vx = 0;
    }
    if (pred.x > W - PLAYER_W) {
      pred.x = W - PLAYER_W;
      pred.vx = 0;
    }
  }
  function reconcilePred(sp) {
    if (!state.pred) {
      initPred(sp.x, sp.y);
      return;
    }
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

  // src/audio.ts
  var audioCtx = null;
  function ac() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtx;
  }
  function beep({
    type = "square",
    freq = 300,
    endFreq,
    duration = 0.1,
    volume = 0.25,
    delay = 0
  } = {}) {
    try {
      const a = ac();
      const osc = a.createOscillator();
      const gain = a.createGain();
      osc.connect(gain);
      gain.connect(a.destination);
      osc.type = type;
      const t = a.currentTime + delay;
      osc.frequency.setValueAtTime(freq, t);
      if (endFreq !== void 0) {
        osc.frequency.exponentialRampToValueAtTime(endFreq, t + duration);
      }
      gain.gain.setValueAtTime(volume, t);
      gain.gain.exponentialRampToValueAtTime(1e-3, t + duration);
      osc.start(t);
      osc.stop(t + duration + 0.01);
    } catch (_) {
    }
  }
  function playSound(name) {
    switch (name) {
      case "fist":
        beep({ type: "square", freq: 220, endFreq: 80, duration: 0.1 });
        break;
      case "leg":
        beep({ type: "sawtooth", freq: 160, endFreq: 55, duration: 0.14 });
        break;
      case "uppercut":
        beep({ type: "square", freq: 110, endFreq: 380, duration: 0.06 });
        beep({ type: "square", freq: 380, endFreq: 50, duration: 0.18, delay: 0.06 });
        break;
      case "hit":
        beep({ type: "square", freq: 350, endFreq: 90, duration: 0.08, volume: 0.45 });
        break;
      case "block":
        beep({ type: "triangle", freq: 600, endFreq: 400, duration: 0.07, volume: 0.2 });
        break;
      case "ko":
        beep({ type: "sawtooth", freq: 440, endFreq: 55, duration: 0.55, volume: 0.6 });
        break;
      case "countdown":
        beep({ type: "sine", freq: 440, duration: 0.18, volume: 0.3 });
        break;
      case "fight":
        [440, 550, 660].forEach(
          (f, i) => beep({ type: "sine", freq: f, duration: 0.2, volume: 0.3, delay: i * 0.11 })
        );
        break;
      case "jump":
        beep({ type: "sine", freq: 300, endFreq: 500, duration: 0.12, volume: 0.15 });
        break;
    }
  }

  // src/analytics.ts
  var SESSION_ID = (() => {
    let id = sessionStorage.getItem("fa_sid");
    if (!id) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      sessionStorage.setItem("fa_sid", id);
    }
    return id;
  })();
  var eventQueue = [];
  var flushTimer = null;
  var PAGE_START = Date.now();
  function track(event, meta) {
    eventQueue.push({
      session_id: SESSION_ID,
      event,
      meta: meta ? JSON.stringify(meta) : ""
    });
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushEvents, 2e3);
  }
  function flushEvents() {
    if (!eventQueue.length) return;
    const batch = eventQueue.splice(0);
    const body = JSON.stringify(batch);
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/analytics", body);
    } else {
      fetch("/analytics", { method: "POST", body, keepalive: true }).catch(() => {
      });
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      track("page_exit", { duration_sec: Math.round((Date.now() - PAGE_START) / 1e3) });
      flushEvents();
    }
  });
  track("page_view");

  // src/network.ts
  var callbacks = null;
  function initNetwork(cb) {
    callbacks = cb;
  }
  function wsSend(msg) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(msg));
    }
  }
  function connectSpectator() {
    if (state.ws && state.ws.readyState !== WebSocket.CLOSED) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    state.ws = ws;
    ws.onopen = () => {
      wsSend({ type: "join_spectate", name: state.authedNickname ?? void 0 });
    };
    ws.onmessage = (e) => handleMsg(JSON.parse(e.data));
    ws.onclose = () => {
      state.spectateState = null;
      if (state.phase !== "menu") callbacks?.onDisconnect();
    };
    ws.onerror = () => {
      if (state.phase !== "menu") callbacks?.onError();
    };
  }
  function joinQueueFromSpectate(playerName) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      wsSend({ type: "join_queue", name: playerName });
    } else {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/ws`);
      state.ws = ws;
      ws.onopen = () => wsSend({ type: "join_queue", name: playerName });
      ws.onmessage = (e) => handleMsg(JSON.parse(e.data));
      ws.onclose = () => {
        if (state.phase !== "menu") callbacks?.onDisconnect();
      };
      ws.onerror = () => {
        if (state.phase !== "menu") callbacks?.onError();
      };
    }
  }
  function sendInput() {
    const { ws, phase, keys } = state;
    if (ws && ws.readyState === WebSocket.OPEN && phase === "game") {
      wsSend({ type: "input", keys });
    }
  }
  var spectateIdleTimer = null;
  function scheduleSpectateClear() {
    if (spectateIdleTimer !== null) return;
    spectateIdleTimer = setTimeout(() => {
      state.spectateState = null;
      state.spectateMatchInfo = null;
      spectateIdleTimer = null;
      callbacks?.onSpectateUpdate();
    }, 6500);
  }
  function cancelSpectateClear() {
    if (spectateIdleTimer !== null) {
      clearTimeout(spectateIdleTimer);
      spectateIdleTimer = null;
    }
  }
  function handleMsg(msg) {
    switch (msg.type) {
      case "queued":
        callbacks?.onQueued(msg.message);
        break;
      case "match_started":
        state.spectateMatchInfo = { p1: msg.p1, p2: msg.p2 };
        cancelSpectateClear();
        callbacks?.onSpectateUpdate();
        break;
      case "match_found":
        state.playerID = msg.player_id;
        state.matchInfo = { you: msg.you, opponent: msg.opponent };
        state.spectateState = null;
        state.spectateMatchInfo = null;
        cancelSpectateClear();
        state.prevCountdown = 4;
        track("match_start", { you: msg.you, opponent: msg.opponent });
        callbacks?.onMatchFound(msg.player_id, msg.you, msg.opponent);
        break;
      case "fight_start":
        playSound("fight");
        state.fightFlash = 70;
        break;
      case "state": {
        if (state.phase === "game") {
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
          if (msg.state.phase === "countdown" && msg.state.countdown !== state.prevCountdown) {
            if (msg.state.countdown > 0) playSound("countdown");
            state.prevCountdown = msg.state.countdown;
          }
          if (prev && prev.phase !== "gameover" && msg.state.phase === "gameover" && msg.state.winner) {
            const isWin = state.matchInfo && msg.state.winner === state.matchInfo.you;
            track("match_end", { result: isWin ? "win" : "loss", winner: msg.state.winner });
          }
        } else {
          state.spectateState = msg.state;
          if (msg.state.phase === "gameover") {
            scheduleSpectateClear();
          } else {
            cancelSpectateClear();
          }
          callbacks?.onSpectateUpdate();
        }
        break;
      }
      case "opponent_left":
        if (state.gameState) {
          state.gameState = {
            ...state.gameState,
            phase: "gameover",
            winner: state.matchInfo?.you ?? "You"
          };
        }
        track("match_end", { result: "opponent_disconnected" });
        break;
      case "queue_status":
        if (state.phase === "menu" || state.phase === "waiting") {
          callbacks?.onQueueStatus(msg.status);
        }
        break;
    }
  }
  function detectSoundEvents(prevPlayers, currPlayers) {
    for (let i = 0; i < 2; i++) {
      const ps = prevPlayers?.[i];
      const cs = currPlayers?.[i];
      if (!ps || !cs) continue;
      if (ps.state !== cs.state) {
        if (cs.state === "attack_fist") playSound("fist");
        if (cs.state === "attack_leg") playSound("leg");
        if (cs.state === "attack_uppercut") playSound("uppercut");
        if (cs.state === "hurt") {
          playSound("hit");
          state.hitFlash[i] = 8;
        }
        if (cs.state === "ko") playSound("ko");
        if (cs.state === "blocking" && ps.state !== "blocking") playSound("block");
        if (cs.state === "jumping") playSound("jump");
      }
    }
  }
  function detectHitEffects(prevPlayers, currPlayers) {
    for (let i = 0; i < 2; i++) {
      const prev = prevPlayers?.[i];
      const curr = currPlayers?.[i];
      if (!prev || !curr) continue;
      if (curr.hp < prev.hp) {
        const cx = curr.x + PLAYER_W / 2;
        const cy = curr.y + PLAYER_H * 0.35;
        const kind = Math.abs(curr.vx ?? 0) > 3.5 ? "projectile" : "melee";
        state.hitEffects.push({ x: cx, y: cy, startMs: performance.now(), kind });
      }
    }
    const cutoff = performance.now() - 500;
    state.hitEffects = state.hitEffects.filter((fx) => fx.startMs > cutoff);
  }
  function startInputLoop() {
    stopInputLoop();
    state.inputInterval = setInterval(() => sendInput(), 1e3 / 30);
  }
  function stopInputLoop() {
    if (state.inputInterval !== null) {
      clearInterval(state.inputInterval);
      state.inputInterval = null;
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (state.phase !== "game") return;
    if (document.visibilityState === "hidden") stopInputLoop();
    else startInputLoop();
  });
  var KEY_MAP = {
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "jump",
    " ": "jump",
    a: "fist",
    A: "fist",
    s: "leg",
    S: "leg",
    d: "uppercut",
    D: "uppercut",
    f: "block",
    F: "block",
    g: "dodge",
    G: "dodge",
    h: "shoot",
    H: "shoot"
  };
  function isInputFocused() {
    const tag = document.activeElement?.tagName;
    return tag === "INPUT" || tag === "TEXTAREA";
  }
  document.addEventListener("keydown", (e) => {
    if (isInputFocused()) return;
    const action = KEY_MAP[e.key];
    if (!action) return;
    e.preventDefault();
    if (!state.keys[action]) {
      state.keys[action] = true;
      sendInput();
      if (action === "fist") {
        tryPredictAttack("attack_fist");
        playSound("fist");
      }
      if (action === "leg") {
        tryPredictAttack("attack_leg");
        playSound("leg");
      }
      if (action === "uppercut") {
        tryPredictAttack("attack_uppercut");
        playSound("uppercut");
      }
    }
  });
  document.addEventListener("keyup", (e) => {
    if (isInputFocused()) return;
    const action = KEY_MAP[e.key];
    if (action) {
      state.keys[action] = false;
      sendInput();
    }
  });

  // src/sprites.ts
  var sprites = {
    0: {},
    1: {}
  };
  function loadFrames(charIdx, basePath, stateName, count) {
    const frames = [];
    for (let i = 0; i < count; i++) {
      const img = new Image();
      img.src = `${basePath}/${stateName}_${i}.png`;
      img.onerror = () => console.error(`[sprite] failed to load: ${img.src}`);
      frames.push(img);
    }
    sprites[charIdx][stateName] = frames;
  }
  loadFrames(0, "/assets/char1", "idle", 4);
  loadFrames(1, "/assets/char1", "idle", 4);
  loadFrames(0, "/assets/char1", "walk", 5);
  loadFrames(1, "/assets/char1", "walk", 5);
  function getSpriteFrame(charIdx, playerState) {
    const charSprites = sprites[charIdx] ?? {};
    function tryFrames(name) {
      const frames = charSprites[name];
      if (!frames || frames.length === 0) return null;
      const frame = frames[Math.floor(Date.now() / MS_PER_FRAME) % frames.length];
      return frame && frame.complete && frame.naturalWidth > 0 ? frame : null;
    }
    const spriteName = playerState in STATE_TO_SPRITE ? STATE_TO_SPRITE[playerState] : "idle";
    return tryFrames(spriteName) ?? tryFrames("idle");
  }

  // src/colors.ts
  function hexToRgb(hex) {
    const n = parseInt(hex.replace("#", ""), 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  }
  function lighten(hex, amt) {
    const [r, g, b] = hexToRgb(hex);
    return `rgb(${Math.min(255, r + amt)},${Math.min(255, g + amt)},${Math.min(255, b + amt)})`;
  }
  function darken(hex, amt) {
    const [r, g, b] = hexToRgb(hex);
    return `rgb(${Math.max(0, r - amt)},${Math.max(0, g - amt)},${Math.max(0, b - amt)})`;
  }

  // src/renderer.ts
  var canvas = document.getElementById("game-canvas");
  var ctx = canvas.getContext("2d");
  var bgCanvas = document.getElementById("bg-canvas");
  var bgCtx = bgCanvas.getContext("2d");
  var spectateCanvas = document.getElementById("spectate-canvas");
  var spectateCtx = spectateCanvas.getContext("2d");
  function showBgCanvas() {
    bgCanvas.style.display = "block";
  }
  function hideBgCanvas() {
    bgCanvas.style.display = "none";
  }
  async function initBgGif() {
    bgCanvas.width = window.innerWidth;
    bgCanvas.height = window.innerHeight;
    window.addEventListener("resize", () => {
      bgCanvas.width = window.innerWidth;
      bgCanvas.height = window.innerHeight;
    });
    const bgImg = new Image();
    bgImg.src = "assets/background.gif";
    await new Promise((resolve) => {
      bgImg.onload = () => resolve();
      bgImg.onerror = () => resolve();
    });
    let durationMs = 0;
    try {
      const buf = await fetch("assets/background.gif").then((r) => r.arrayBuffer());
      const data = new Uint8Array(buf);
      for (let i = 0; i < data.length - 5; i++) {
        if (data[i] === 33 && data[i + 1] === 249 && data[i + 2] === 4) {
          durationMs += (data[i + 4] | data[i + 5] << 8 || 10) * 10;
          i += 7;
        }
      }
    } catch (_) {
    }
    state.bgAnimating = true;
    showBgCanvas();
    (function drawFrame() {
      if (!state.bgAnimating) return;
      bgCtx.drawImage(bgImg, 0, 0, bgCanvas.width, bgCanvas.height);
      bgCtx.fillStyle = "rgba(13,0,26,0.55)";
      bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
      requestAnimationFrame(drawFrame);
    })();
    if (durationMs > 0) setTimeout(() => {
      state.bgAnimating = false;
    }, durationMs);
  }
  function drawBackground() {
    const g = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    g.addColorStop(0, "#07001a");
    g.addColorStop(1, "#140030");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(80,0,180,0.22)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += 64) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, GROUND_Y);
      ctx.stroke();
    }
    for (let y = 0; y <= GROUND_Y; y += 64) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    [
      [80, 48],
      [320, 96],
      [608, 32],
      [896, 72],
      [1152, 112],
      [208, 160],
      [496, 128],
      [768, 176],
      [1040, 56],
      [1216, 152]
    ].forEach(([sx, sy]) => ctx.fillRect(sx, sy, 2, 2));
  }
  function drawGround() {
    ctx.fillStyle = "#3a0060";
    ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
    for (let x = 0; x < W; x += 128) {
      ctx.fillStyle = x / 128 % 2 === 0 ? "#4a1080" : "#3a0060";
      ctx.fillRect(x, GROUND_Y + 4, 128, H - GROUND_Y - 4);
    }
    const edge = ctx.createLinearGradient(0, GROUND_Y - 2, 0, GROUND_Y + 6);
    edge.addColorStop(0, "#cc44ff");
    edge.addColorStop(1, "#6600cc");
    ctx.fillStyle = edge;
    ctx.fillRect(0, GROUND_Y, W, 5);
  }
  function drawPlayerPlaceholder(cx, x, y, w, h, color, facing, tick, stateName) {
    const isWalking = stateName === "walking";
    const isAttacking = stateName.startsWith("attack_");
    const isHurt = stateName === "hurt";
    const isBlocking = stateName === "blocking";
    const isDodging = stateName === "dodging";
    const isKO = stateName === "ko";
    cx.save();
    if (isHurt) cx.globalAlpha = tick % 4 < 2 ? 0.35 : 1;
    if (isDodging) {
      cx.shadowColor = "#00eeff";
      cx.shadowBlur = 14;
    }
    if (isKO) {
      cx.globalAlpha = 0.5;
      cx.fillStyle = color;
      cx.fillRect(x - Math.round(w * 0.3), y + h - Math.round(h * 0.18), w + Math.round(w * 0.6), Math.round(h * 0.18));
    } else {
      cx.fillStyle = color;
      cx.fillRect(x, y + Math.round(h * 0.3), w, Math.round(h * 0.42));
      const headH = Math.round(h * 0.3);
      const headW = w - Math.round(w * 0.18);
      const headX = x + Math.round(w * 0.09);
      cx.fillStyle = lighten(color, 28);
      cx.fillRect(headX, y, headW, headH);
      const eyeOffX = Math.round(headW * (facing === 1 ? 0.65 : 0.15));
      const eyeX = headX + eyeOffX;
      const eyeY = y + Math.round(headH * 0.25);
      const es = Math.max(3, Math.round(headW * 0.18));
      cx.fillStyle = "#fff";
      cx.fillRect(eyeX, eyeY, es, es);
      cx.fillStyle = "#111";
      cx.fillRect(eyeX + (facing === 1 ? Math.round(es * 0.4) : 0), eyeY + 1, Math.max(2, es - 2), Math.max(2, es - 2));
      const legTopY = y + Math.round(h * 0.72);
      const legH = h - Math.round(h * 0.72);
      const legW = Math.round(w * 0.28);
      cx.fillStyle = darken(color, 25);
      const bob = isWalking ? Math.sin(tick / 9) * 4 : 0;
      cx.fillRect(x + 2, legTopY + bob, legW, legH - bob);
      cx.fillRect(x + w - 2 - legW, legTopY - bob, legW, legH + bob);
      cx.fillStyle = lighten(color, 12);
      const armTopY = y + Math.round(h * 0.3);
      const armW = Math.round(w * 0.2);
      const armH = Math.round(h * 0.3);
      if (isAttacking) {
        const aExtX = facing === 1 ? x + w : x - Math.round(w * 0.45);
        const aOffY = stateName === "attack_leg" ? Math.round(h * 0.42) : stateName === "attack_uppercut" ? -Math.round(h * 0.08) : Math.round(h * 0.1);
        cx.fillRect(aExtX, armTopY + aOffY, Math.round(w * 0.42), Math.round(h * 0.14));
        const restX = facing === 1 ? x - 3 : x + w - armW + 3;
        cx.fillRect(restX, armTopY, armW, armH);
      } else {
        cx.fillRect(x - 3, armTopY, armW, armH);
        cx.fillRect(x + w - armW + 3, armTopY, armW, armH);
      }
      if (isBlocking) {
        cx.save();
        cx.strokeStyle = "rgba(140,140,255,0.9)";
        cx.lineWidth = 2;
        cx.shadowColor = "#8888ff";
        cx.shadowBlur = 12;
        cx.strokeRect(x - 4, y - 4, w + 8, h + 8);
        cx.restore();
      }
    }
    cx.restore();
  }
  var drawSprite = drawPlayerPlaceholder;
  function drawCharSprite(cx, img, hitX, hitY, facing) {
    const dh = SPRITE_DISPLAY_H;
    const dw = dh * (img.naturalWidth / img.naturalHeight);
    const drawY = hitY + PLAYER_H - dh;
    const cxMid = hitX + PLAYER_W / 2;
    cx.save();
    cx.imageSmoothingEnabled = false;
    cx.translate(cxMid, 0);
    if (facing === -1) cx.scale(-1, 1);
    cx.drawImage(img, -dw / 2, drawY, dw, dh);
    cx.restore();
  }
  var HIT_EFFECT_DURATION_MS = 420;
  var HIT_EFFECT_FRAMES = 8;
  var hitEffectImg = null;
  var hitEffectLoaded = false;
  (function loadHitEffectPng() {
    const img = new Image();
    img.onload = () => {
      hitEffectImg = img;
      hitEffectLoaded = true;
    };
    img.onerror = () => {
      hitEffectLoaded = true;
    };
    img.src = "assets/hit_effect.png";
  })();
  function drawHitEffects(effects) {
    const now = performance.now();
    for (const fx of effects) {
      const age = now - fx.startMs;
      const t = Math.min(age / HIT_EFFECT_DURATION_MS, 1);
      const alpha = 1 - t;
      if (hitEffectImg) {
        const frameIdx = Math.min(Math.floor(t * HIT_EFFECT_FRAMES), HIT_EFFECT_FRAMES - 1);
        const frameW = hitEffectImg.naturalWidth / HIT_EFFECT_FRAMES;
        const drawSize = 80 + t * 40;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.drawImage(
          hitEffectImg,
          frameIdx * frameW,
          0,
          frameW,
          hitEffectImg.naturalHeight,
          fx.x - drawSize / 2,
          fx.y - drawSize / 2,
          drawSize,
          drawSize
        );
        ctx.restore();
      } else {
        const isProjectile = fx.kind === "projectile";
        const coreColor = isProjectile ? "#ff6600" : "#ffffff";
        const ringColor = isProjectile ? "#ff2200" : "#ffcc00";
        ctx.save();
        if (t < 0.35) {
          const flashAlpha = (1 - t / 0.35) * 0.85;
          const flashR = 4 + t * 28;
          ctx.globalAlpha = flashAlpha;
          ctx.beginPath();
          ctx.arc(fx.x, fx.y, flashR, 0, Math.PI * 2);
          ctx.fillStyle = "#ffffff";
          ctx.shadowColor = coreColor;
          ctx.shadowBlur = 18;
          ctx.fill();
        }
        const ringR = 8 + t * 38;
        const ringW = Math.max(1, 4 - t * 3);
        ctx.globalAlpha = alpha * 0.9;
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = ringW;
        ctx.shadowColor = ringColor;
        ctx.shadowBlur = 10;
        ctx.stroke();
        const sparkLen = 6 + t * 18;
        const sparkFade = Math.max(0, 1 - t * 2.2);
        ctx.globalAlpha = sparkFade;
        ctx.strokeStyle = coreColor;
        ctx.lineWidth = 1.5;
        ctx.shadowBlur = 6;
        for (let i = 0; i < 6; i++) {
          const angle = i / 6 * Math.PI * 2;
          const inner = ringR * 0.4;
          const outer = inner + sparkLen;
          ctx.beginPath();
          ctx.moveTo(fx.x + Math.cos(angle) * inner, fx.y + Math.sin(angle) * inner);
          ctx.lineTo(fx.x + Math.cos(angle) * outer, fx.y + Math.sin(angle) * outer);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }
  function drawProjectiles(projectiles) {
    const msSinceSnap = performance.now() - state.lastSnapAt;
    const extraTicks = Math.min(msSinceSnap / (1e3 / 60), 4);
    for (const proj of projectiles) {
      const rx = proj.x + proj.vx * extraTicks;
      const ry = proj.y;
      ctx.save();
      ctx.shadowColor = "#ff2200";
      ctx.shadowBlur = 30;
      ctx.beginPath();
      ctx.arc(rx, ry, 22, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,80,0,0.35)";
      ctx.fill();
      ctx.shadowBlur = 20;
      ctx.beginPath();
      ctx.arc(rx, ry, 14, 0, Math.PI * 2);
      ctx.fillStyle = "#ff4400";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 3;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }
  function drawPowerUps(powerUps) {
    const t = Date.now() / 1e3;
    for (const pu of powerUps) {
      const bob = Math.sin(t * 2.5 + pu.id) * 3;
      const label = pu.kind === "speed" ? "\u26A1" : pu.kind === "shoot" ? "\u{1F525}" : "\u{1F4A5}";
      const glow = pu.kind === "speed" ? "#00eeff" : pu.kind === "shoot" ? "#ff4400" : "#ff8800";
      ctx.save();
      ctx.shadowColor = glow;
      ctx.shadowBlur = 16 + Math.sin(t * 3) * 6;
      ctx.font = "20px serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, pu.x, pu.y + bob);
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = glow;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.5 + 0.3 * Math.sin(t * 3);
      ctx.beginPath();
      ctx.arc(pu.x, pu.y + bob, 14, t * 2, t * 2 + Math.PI * 1.5);
      ctx.stroke();
      ctx.restore();
    }
  }
  function drawGamePlayer(p) {
    const isLocal = p.id === state.playerID;
    let x, y;
    if (isLocal && state.pred && !SERVER_ONLY_STATES.has(p.state)) {
      x = Math.round(state.pred.x);
      y = Math.round(state.pred.y);
    } else if (!isLocal) {
      const interp = interpOppPos(p.x, p.y);
      x = Math.round(interp.x);
      y = Math.round(interp.y);
    } else {
      x = Math.round(p.x);
      y = Math.round(p.y);
    }
    let renderState = p.state;
    if (isLocal && state.predictedAttack && (p.state === "idle" || p.state === "walking" || p.state === "jumping")) {
      renderState = state.predictedAttack;
    }
    {
      const col = p.id === 0 ? "#FF69B4" : "#FF8C00";
      ctx.save();
      ctx.fillStyle = p.id === 0 ? "rgba(255,105,180,0.10)" : "rgba(255,140,0,0.10)";
      ctx.fillRect(x, y, PLAYER_W, PLAYER_H);
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.shadowColor = col;
      ctx.shadowBlur = 6;
      ctx.strokeRect(x, y, PLAYER_W, PLAYER_H);
      const t2 = 6;
      ctx.lineWidth = 2;
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.moveTo(x, y + t2);
      ctx.lineTo(x, y);
      ctx.lineTo(x + t2, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + PLAYER_W - t2, y);
      ctx.lineTo(x + PLAYER_W, y);
      ctx.lineTo(x + PLAYER_W, y + t2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, y + PLAYER_H - t2);
      ctx.lineTo(x, y + PLAYER_H);
      ctx.lineTo(x + t2, y + PLAYER_H);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + PLAYER_W - t2, y + PLAYER_H);
      ctx.lineTo(x + PLAYER_W, y + PLAYER_H);
      ctx.lineTo(x + PLAYER_W, y + PLAYER_H - t2);
      ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    if (state.hitFlash[p.id] > 0) ctx.globalAlpha = state.hitFlash[p.id] % 2 === 0 ? 0.3 : 1;
    const spriteFrame = getSpriteFrame(p.id, renderState);
    if (spriteFrame) {
      drawCharSprite(ctx, spriteFrame, x, y, p.facing);
    } else {
      drawPlayerPlaceholder(ctx, x, y, PLAYER_W, PLAYER_H, p.color, p.facing, Date.now() / 16, renderState);
    }
    ctx.restore();
    if (p.attackActive && p.attackBox) {
      const ab = p.attackBox;
      const atkFill = p.state === "attack_fist" ? "rgba(0,200,255,0.30)" : p.state === "attack_leg" ? "rgba(255,160,0,0.30)" : "rgba(230,0,255,0.30)";
      const atkStroke = p.state === "attack_fist" ? "rgba(0,220,255,0.90)" : p.state === "attack_leg" ? "rgba(255,180,0,0.90)" : "rgba(230,0,255,0.90)";
      ctx.save();
      ctx.fillStyle = atkFill;
      ctx.strokeStyle = atkStroke;
      ctx.lineWidth = 2;
      ctx.fillRect(ab.x, ab.y, ab.w, ab.h);
      ctx.strokeRect(ab.x, ab.y, ab.w, ab.h);
      ctx.fillStyle = atkStroke;
      ctx.font = "bold 8px monospace";
      ctx.textAlign = "center";
      ctx.fillText(
        p.state === "attack_fist" ? "FIST" : p.state === "attack_leg" ? "KICK" : "UPCUT",
        ab.x + ab.w / 2,
        ab.y - 2
      );
      ctx.restore();
    }
    const t = Date.now() / 1e3;
    if ((p.speedBuff ?? 0) > 0 || (p.damageBuff ?? 0) > 0) {
      ctx.save();
      if ((p.speedBuff ?? 0) > 0) {
        ctx.strokeStyle = "#00eeff";
        ctx.shadowColor = "#00eeff";
        ctx.shadowBlur = 10 + Math.sin(t * 6) * 4;
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 4, y - 4, PLAYER_W + 8, PLAYER_H + 8);
      }
      if ((p.damageBuff ?? 0) > 0) {
        ctx.strokeStyle = "#ff6600";
        ctx.shadowColor = "#ff4400";
        ctx.shadowBlur = 10 + Math.sin(t * 6 + 1) * 4;
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 7, y - 7, PLAYER_W + 14, PLAYER_H + 14);
      }
      ctx.restore();
    }
    if (p.state !== "ko") {
      const buffIcons = [
        (p.speedBuff ?? 0) > 0 ? "\u26A1" : "",
        (p.damageBuff ?? 0) > 0 ? "\u{1F4A5}" : "",
        (p.shootBuff ?? 0) > 0 ? `\u{1F525}\xD7${p.shootBuff}` : ""
      ].filter(Boolean).join(" ");
      ctx.save();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 13px Bangers";
      ctx.textAlign = "center";
      ctx.shadowColor = "#000";
      ctx.shadowBlur = 5;
      ctx.fillText(p.name + (buffIcons ? " " + buffIcons : ""), x + PLAYER_W / 2, y - 5);
      ctx.restore();
    }
  }
  function drawHealthBar(x, y, w, h, p, rightAlign) {
    const pct = Math.max(0, p.hp / p.maxHp);
    const barW = Math.round(pct * (w - 4));
    const hpCol = pct > 0.5 ? "#44ff44" : pct > 0.25 ? "#ffcc00" : "#ff2222";
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = hpCol;
    if (rightAlign) ctx.fillRect(x + 2 + (w - 4 - barW), y + 2, barW, h - 4);
    else ctx.fillRect(x + 2, y + 2, barW, h - 4);
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 2;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 6;
    ctx.strokeRect(x, y, w, h);
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#fff";
    ctx.font = "bold 11px Bangers";
    ctx.textAlign = "center";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 4;
    ctx.fillText(`${p.name}  ${p.hp}/${p.maxHp}`, x + w / 2, y + h - 6);
    ctx.shadowBlur = 0;
  }
  function drawHUD(gameState) {
    if (!gameState?.players) return;
    const [p1, p2] = gameState.players;
    if (!p1 || !p2) return;
    drawHealthBar(16, 16, 384, 45, p1, false);
    drawHealthBar(W - 400, 16, 384, 45, p2, true);
    ctx.save();
    ctx.font = "bold 32px Bangers";
    ctx.textAlign = "center";
    ctx.fillStyle = "#FFD700";
    ctx.shadowColor = "#FF6600";
    ctx.shadowBlur = 10;
    ctx.fillText("VS", W / 2, 48);
    ctx.restore();
    if (state.playerID !== null) {
      const isLeft = state.playerID === 0;
      ctx.save();
      ctx.font = "bold 16px Bangers";
      ctx.fillStyle = "#00ff99";
      ctx.textAlign = isLeft ? "left" : "right";
      ctx.fillText(isLeft ? "\u25B2 YOU" : "YOU \u25B2", isLeft ? 19 : W - 19, 83);
      ctx.restore();
    }
  }
  function drawCountdown(count) {
    if (count <= 0) return;
    ctx.save();
    ctx.font = "bold 208px Bangers";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#FFD700";
    ctx.shadowColor = "#FF6600";
    ctx.shadowBlur = 40;
    ctx.fillText(String(count), W / 2, H / 2);
    ctx.restore();
  }
  function drawFightText(fightFlash) {
    const alpha = Math.min(1, fightFlash / 25);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = "bold 176px Bangers";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#FF6600";
    ctx.shadowColor = "#FF0000";
    ctx.shadowBlur = 50;
    ctx.fillText("FIGHT!", W / 2, H / 2);
    ctx.restore();
  }
  function drawGameOver(winner, isMe, secsLeft) {
    ctx.fillStyle = "rgba(0,0,0,0.62)";
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 141px Bangers";
    ctx.fillStyle = "#FF2222";
    ctx.shadowColor = "#FF0000";
    ctx.shadowBlur = 40;
    ctx.fillText("K.O.!", W / 2, H / 2 - 104);
    ctx.font = "bold 67px Bangers";
    ctx.fillStyle = "#FFD700";
    ctx.shadowColor = "#FF8800";
    ctx.shadowBlur = 20;
    ctx.fillText(`${winner} WINS!`, W / 2, H / 2 + 29);
    ctx.font = "bold 35px Bangers";
    ctx.fillStyle = isMe ? "#00ff88" : "#ff4466";
    ctx.shadowBlur = 10;
    ctx.fillText(isMe ? "VICTORY!" : "DEFEATED", W / 2, H / 2 + 115);
    ctx.font = "bold 22px Bangers";
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.shadowBlur = 0;
    ctx.fillText(
      secsLeft > 0 ? `Returning to menu in ${secsLeft}\u2026  (press any key to skip)` : "Returning\u2026",
      W / 2,
      H / 2 + 175
    );
    ctx.restore();
  }
  function drawLoading() {
    ctx.fillStyle = "#0d001a";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#FFD700";
    ctx.font = "35px Bangers";
    ctx.textAlign = "center";
    ctx.fillText("Loading\u2026", W / 2, H / 2);
  }
  function drawWaitingHPBar(x, y, w, h, color, name, rightAlign) {
    ctx.save();
    if (rightAlign) ctx.globalAlpha = 0.35;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x, y, w, h);
    if (!rightAlign) {
      ctx.fillStyle = "#44ff44";
      ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    ctx.strokeRect(x, y, w, h);
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#fff";
    ctx.font = "bold 11px Bangers";
    ctx.textAlign = "center";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 4;
    ctx.fillText(rightAlign ? "???  --/--" : `${name}  100/100`, x + w / 2, y + h - 6);
    ctx.restore();
  }
  function renderWaiting(queuedAs) {
    const t = Date.now() / 16;
    ctx.clearRect(0, 0, W, H);
    drawBackground();
    drawGround();
    const p1x = 192, p1y = GROUND_Y - PLAYER_H;
    drawSprite(ctx, p1x, p1y, PLAYER_W, PLAYER_H, "#FF69B4", 1, t, "idle");
    ctx.save();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 18px Bangers";
    ctx.textAlign = "center";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 5;
    ctx.fillText(queuedAs ?? "YOU", p1x + PLAYER_W / 2, p1y - 11);
    ctx.restore();
    const p2x = W - 120 - PLAYER_W, p2y = GROUND_Y - PLAYER_H;
    const alpha = 0.25 + 0.2 * Math.sin(Date.now() / 400);
    ctx.save();
    ctx.globalAlpha = alpha;
    drawSprite(ctx, p2x, p2y, PLAYER_W, PLAYER_H, "#FF8C00", -1, t, "idle");
    ctx.globalAlpha = Math.min(1, alpha * 2.2);
    ctx.fillStyle = "#FF8C00";
    ctx.font = "bold 18px Bangers";
    ctx.textAlign = "center";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 5;
    ctx.fillText("???", p2x + PLAYER_W / 2, p2y - 7);
    ctx.restore();
    drawWaitingHPBar(10, 10, 240, 28, "#FF69B4", queuedAs ?? "YOU", false);
    drawWaitingHPBar(W - 250, 10, 240, 28, "#FF8C00", "???", true);
    ctx.save();
    ctx.font = "bold 20px Bangers";
    ctx.textAlign = "center";
    ctx.fillStyle = "#FFD700";
    ctx.shadowColor = "#FF6600";
    ctx.shadowBlur = 10;
    ctx.fillText("VS", W / 2, 30);
    ctx.restore();
  }
  function drawSpectateHealthBar(cx, x, y, w, h, p, rightAlign) {
    const pct = Math.max(0, p.hp / p.maxHp);
    const barW = Math.round(pct * (w - 4));
    const hpCol = pct > 0.5 ? "#44ff44" : pct > 0.25 ? "#ffcc00" : "#ff2222";
    cx.fillStyle = "rgba(0,0,0,0.6)";
    cx.fillRect(x, y, w, h);
    cx.fillStyle = hpCol;
    if (rightAlign) cx.fillRect(x + 2 + (w - 4 - barW), y + 2, barW, h - 4);
    else cx.fillRect(x + 2, y + 2, barW, h - 4);
    cx.strokeStyle = p.color;
    cx.lineWidth = 2;
    cx.shadowColor = p.color;
    cx.shadowBlur = 6;
    cx.strokeRect(x, y, w, h);
    cx.shadowBlur = 0;
    cx.fillStyle = "#fff";
    cx.font = "bold 11px Bangers";
    cx.textAlign = "center";
    cx.shadowColor = "#000";
    cx.shadowBlur = 4;
    cx.fillText(`${p.name}  ${p.hp}/${p.maxHp}`, x + w / 2, y + h - 6);
    cx.shadowBlur = 0;
  }
  function renderSpectate(snapshot) {
    const cx = spectateCtx;
    const cw = spectateCanvas.width;
    const ch = spectateCanvas.height;
    cx.clearRect(0, 0, cw, ch);
    if (!snapshot) {
      const g = cx.createLinearGradient(0, 0, 0, ch);
      g.addColorStop(0, "#07001a");
      g.addColorStop(1, "#140030");
      cx.fillStyle = g;
      cx.fillRect(0, 0, cw, ch);
      cx.save();
      cx.textAlign = "center";
      cx.textBaseline = "middle";
      cx.font = "bold 52px Bangers";
      cx.fillStyle = "rgba(255,255,255,0.12)";
      cx.fillText("NO ACTIVE MATCH", cw / 2, ch / 2 - 30);
      cx.font = "bold 26px Bangers";
      cx.fillStyle = "rgba(255,215,0,0.35)";
      cx.fillText("BE THE FIRST TO FIGHT", cw / 2, ch / 2 + 30);
      cx.restore();
      return;
    }
    const bg = cx.createLinearGradient(0, 0, 0, GROUND_Y);
    bg.addColorStop(0, "#07001a");
    bg.addColorStop(1, "#140030");
    cx.fillStyle = bg;
    cx.fillRect(0, 0, cw, ch);
    cx.strokeStyle = "rgba(80,0,180,0.22)";
    cx.lineWidth = 1;
    for (let x = 0; x <= cw; x += 64) {
      cx.beginPath();
      cx.moveTo(x, 0);
      cx.lineTo(x, GROUND_Y);
      cx.stroke();
    }
    for (let y = 0; y <= GROUND_Y; y += 64) {
      cx.beginPath();
      cx.moveTo(0, y);
      cx.lineTo(cw, y);
      cx.stroke();
    }
    cx.fillStyle = "rgba(255,255,255,0.5)";
    [
      [80, 48],
      [320, 96],
      [608, 32],
      [896, 72],
      [1152, 112],
      [208, 160],
      [496, 128],
      [768, 176],
      [1040, 56],
      [1216, 152]
    ].forEach(([sx, sy]) => cx.fillRect(sx, sy, 2, 2));
    cx.fillStyle = "#3a0060";
    cx.fillRect(0, GROUND_Y, cw, ch - GROUND_Y);
    for (let x = 0; x < cw; x += 128) {
      cx.fillStyle = x / 128 % 2 === 0 ? "#4a1080" : "#3a0060";
      cx.fillRect(x, GROUND_Y + 4, 128, ch - GROUND_Y - 4);
    }
    const edge = cx.createLinearGradient(0, GROUND_Y - 2, 0, GROUND_Y + 6);
    edge.addColorStop(0, "#cc44ff");
    edge.addColorStop(1, "#6600cc");
    cx.fillStyle = edge;
    cx.fillRect(0, GROUND_Y, cw, 5);
    for (const p of snapshot.players) {
      if (!p) continue;
      const spriteFrame = getSpriteFrame(p.id, p.state);
      cx.save();
      if (spriteFrame) {
        const dh = SPRITE_DISPLAY_H;
        const dw = dh * (spriteFrame.naturalWidth / spriteFrame.naturalHeight);
        const drawY = p.y + PLAYER_H - dh;
        const cxMid = p.x + PLAYER_W / 2;
        cx.imageSmoothingEnabled = false;
        cx.translate(cxMid, 0);
        if (p.facing === -1) cx.scale(-1, 1);
        cx.drawImage(spriteFrame, -dw / 2, drawY, dw, dh);
      } else {
        drawSprite(cx, p.x, p.y, PLAYER_W, PLAYER_H, p.color, p.facing, Date.now() / 16, p.state);
      }
      cx.restore();
      if (p.state !== "ko") {
        cx.save();
        cx.fillStyle = "#fff";
        cx.font = "bold 18px Bangers";
        cx.textAlign = "center";
        cx.shadowColor = "#000";
        cx.shadowBlur = 5;
        cx.fillText(p.name, p.x + PLAYER_W / 2, p.y - 11);
        cx.restore();
      }
    }
    const [p1, p2] = snapshot.players;
    if (p1 && p2) {
      drawSpectateHealthBar(cx, 16, 16, 384, 45, p1, false);
      drawSpectateHealthBar(cx, cw - 400, 16, 384, 45, p2, true);
      cx.save();
      cx.font = "bold 32px Bangers";
      cx.textAlign = "center";
      cx.fillStyle = "#FFD700";
      cx.shadowColor = "#FF6600";
      cx.shadowBlur = 10;
      cx.fillText("VS", cw / 2, 48);
      cx.restore();
    }
    if (snapshot.phase === "countdown" && snapshot.countdown > 0) {
      cx.save();
      cx.font = "bold 208px Bangers";
      cx.textAlign = "center";
      cx.textBaseline = "middle";
      cx.fillStyle = "#FFD700";
      cx.shadowColor = "#FF6600";
      cx.shadowBlur = 40;
      cx.fillText(String(snapshot.countdown), cw / 2, ch / 2);
      cx.restore();
    }
    if (snapshot.phase === "gameover") {
      cx.fillStyle = "rgba(0,0,0,0.62)";
      cx.fillRect(0, 0, cw, ch);
      cx.save();
      cx.textAlign = "center";
      cx.textBaseline = "middle";
      cx.font = "bold 141px Bangers";
      cx.fillStyle = "#FF2222";
      cx.shadowColor = "#FF0000";
      cx.shadowBlur = 40;
      cx.fillText("K.O.!", cw / 2, ch / 2 - 104);
      cx.font = "bold 67px Bangers";
      cx.fillStyle = "#FFD700";
      cx.shadowColor = "#FF8800";
      cx.shadowBlur = 20;
      cx.fillText(`${snapshot.winner} WINS!`, cw / 2, ch / 2 + 29);
      cx.restore();
    }
    cx.save();
    cx.fillStyle = "#ff2222";
    cx.beginPath();
    cx.roundRect(cw - 90, 8, 76, 26, 6);
    cx.fill();
    cx.fillStyle = "#fff";
    cx.font = "bold 14px Bangers";
    cx.textAlign = "center";
    cx.textBaseline = "middle";
    cx.fillText("\u25CF LIVE", cw - 52, 21);
    cx.restore();
  }

  // src/ui.ts
  var loginScreen = document.getElementById("login-screen");
  var nicknameScreen = document.getElementById("nickname-screen");
  var queueScreen = document.getElementById("queue-screen");
  var gameScreen = document.getElementById("game-screen");
  var nameInput = document.getElementById("name-input");
  var joinBtn = document.getElementById("join-btn");
  var privateBtn = document.getElementById("private-btn");
  var cancelBtn = document.getElementById("cancel-btn");
  var nameForm = document.getElementById("name-form");
  var queueStatus = document.getElementById("queue-status");
  var queueMsg = document.getElementById("queue-msg");
  var toastEl = document.getElementById("toast");
  var nickInput = document.getElementById("nick-input");
  var nickBtn = document.getElementById("nick-btn");
  var nickError = document.getElementById("nick-error");
  var welcomeBar = document.getElementById("welcome-bar");
  var welcomeMsg = document.getElementById("welcome-msg");
  var waitingOverlay = document.getElementById("waiting-overlay");
  var woShareBtn = document.getElementById("wo-share-btn");
  var woCancelBtn = document.getElementById("wo-cancel-btn");
  var spectateNameplates = document.getElementById("spectate-nameplates");
  var npP1Name = document.getElementById("np-p1-name");
  var npP2Name = document.getElementById("np-p2-name");
  var toastTimer = null;
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2400);
  }
  function showQueueScreen() {
    [loginScreen, nicknameScreen, gameScreen].forEach((s) => s.classList.add("hidden"));
    hideWaitingOverlay();
    queueScreen.classList.remove("hidden");
    showBgCanvas();
    queueStatus.classList.add("hidden");
    state.phase = "menu";
    const joinLabel = joinBtn.querySelector(".btn-label");
    if (state.authedNickname) {
      nameInput.classList.add("hidden");
      nameInput.value = state.authedNickname;
      if (joinLabel) joinLabel.textContent = `FIGHT AS ${state.authedNickname.toUpperCase()}`;
    } else {
      nameInput.classList.remove("hidden");
      if (joinLabel) joinLabel.textContent = "PLAY NEXT";
    }
    nameForm.classList.remove("hidden");
    fetchLeaderboard();
    fetchQueue();
  }
  var onWaitingStart = null;
  var onGameStart = null;
  function setScreenCallbacks(cb) {
    if (cb.onWaitingStart) onWaitingStart = cb.onWaitingStart;
    if (cb.onGameStart) onGameStart = cb.onGameStart;
  }
  function showWaitingScreen() {
    hideBgCanvas();
    queueScreen.classList.add("hidden");
    gameScreen.classList.remove("hidden");
    waitingOverlay.classList.remove("hidden");
    state.phase = "waiting";
    document.activeElement?.blur();
    onWaitingStart?.();
  }
  function hideWaitingOverlay() {
    waitingOverlay.classList.add("hidden");
  }
  function showGameScreen() {
    hideWaitingOverlay();
    gameScreen.classList.remove("hidden");
    state.phase = "game";
    document.activeElement?.blur();
    onGameStart?.();
  }
  function showLoginScreen() {
    [queueScreen, nicknameScreen, gameScreen].forEach((s) => s.classList.add("hidden"));
    loginScreen.classList.remove("hidden");
  }
  function showNicknameScreen() {
    [queueScreen, loginScreen, gameScreen].forEach((s) => s.classList.add("hidden"));
    nicknameScreen.classList.remove("hidden");
  }
  function showWelcomeBar(nickname) {
    welcomeMsg.innerHTML = `Welcome back, <strong>${nickname}</strong>`;
    welcomeBar.classList.remove("hidden");
  }
  function joinQueue() {
    const name = state.authedNickname ?? (nameInput.value.trim() || "Fighter");
    state.queuedAs = name;
    track("click_join", { name });
    joinQueueFromSpectate(name);
    showWaitingScreen();
  }
  joinBtn.addEventListener("click", joinQueue);
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinQueue();
  });
  cancelBtn.addEventListener("click", () => {
    track("click_cancel_queue");
    if (state.ws) {
      state.ws.close();
      state.ws = null;
    }
    nameForm.classList.remove("hidden");
    queueStatus.classList.add("hidden");
  });
  document.querySelectorAll(".panel-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset["tab"];
      document.querySelectorAll(".panel-tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".panel-pane").forEach((p) => p.classList.add("hidden"));
      tab.classList.add("active");
      document.getElementById(`tab-${target}`).classList.remove("hidden");
      if (target === "leaderboard") fetchLeaderboard();
    });
  });
  privateBtn.addEventListener("click", () => {
    track("click_share");
    const name = state.authedNickname ?? (nameInput.value.trim() || "Fighter");
    state.queuedAs = name;
    joinQueueFromSpectate(name);
    showWaitingScreen();
    const url = window.location.href.split("?")[0];
    navigator.clipboard.writeText(url).then(
      () => showToast("INVITE LINK COPIED!"),
      () => prompt("Share this link:", url)
    );
  });
  woShareBtn.addEventListener("click", () => {
    track("click_share_waiting");
    const url = window.location.href.split("?")[0];
    navigator.clipboard.writeText(url).then(
      () => {
        woShareBtn.textContent = "COPIED!";
        setTimeout(() => {
          woShareBtn.textContent = "COPY INVITE LINK";
        }, 1800);
      },
      () => prompt("Share this link:", url)
    );
  });
  woCancelBtn.addEventListener("click", () => {
    track("click_cancel_queue");
    if (state.ws) {
      state.ws.close();
      state.ws = null;
    }
    hideWaitingOverlay();
    showQueueScreen();
  });
  var RANK_MEDALS = ["\u{1F947}", "\u{1F948}", "\u{1F949}", "4", "5"];
  async function fetchLeaderboard() {
    try {
      const res = await fetch("/leaderboard");
      const data = await res.json();
      renderLeaderboard(data);
    } catch (_) {
    }
  }
  function renderLeaderboard(entries) {
    const tbody = document.getElementById("leaderboard-body");
    if (!entries || entries.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="lb-empty">No matches played yet</td></tr>';
      return;
    }
    tbody.innerHTML = entries.map((e) => `
    <tr>
      <td class="lb-rank-${e.rank}">${RANK_MEDALS[e.rank - 1]}</td>
      <td class="lb-rank-${e.rank}">${e.name}</td>
      <td class="lb-wins">${e.wins} W</td>
    </tr>
  `).join("");
  }
  async function fetchQueue() {
    try {
      const res = await fetch("/queue");
      const data = await res.json();
      renderQueue(data);
    } catch (_) {
    }
  }
  function renderQueue(q) {
    const tbody = document.getElementById("queue-body");
    const stats = document.getElementById("server-stats");
    if (!q || !tbody || !stats) return;
    let rows = "";
    if (q.active_matches > 0) {
      rows += `<tr class="queue-fighting queue-row-clickable" data-action="watch">
      <td><span class="queue-dot dot-fighting"></span>Fighting</td>
      <td>${q.active_matches} match${q.active_matches !== 1 ? "es" : ""}</td>
      <td class="queue-action-hint">\u25B6 WATCH</td>
    </tr>`;
    }
    if (q.waiting_name) {
      const s = q.waiting_secs;
      const timeStr = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
      rows += `<tr class="queue-waiting queue-row-clickable" data-action="join">
      <td><span class="queue-dot dot-waiting"></span>Waiting</td>
      <td>${q.waiting_name}</td>
      <td class="queue-action-hint">\u2694 CHALLENGE</td>
    </tr>`;
    }
    if (!rows) {
      rows = '<tr><td colspan="3" class="lb-empty">Queue is empty</td></tr>';
    }
    tbody.innerHTML = rows;
    stats.textContent = `${q.online} player${q.online !== 1 ? "s" : ""} online`;
    tbody.querySelectorAll("tr[data-action]").forEach((row) => {
      row.addEventListener("click", () => {
        if (row.dataset["action"] === "join") {
          joinQueue();
        } else if (row.dataset["action"] === "watch") {
          const liveTab = document.querySelector('.panel-tab[data-tab="spectate"]');
          liveTab?.click();
        }
      });
    });
  }
  async function checkAuth() {
    try {
      const res = await fetch("/auth/me");
      const data = await res.json();
      if (!data.authEnabled) {
        showQueueScreen();
        return;
      }
      if (!data.authed) {
        showLoginScreen();
        return;
      }
      if (data.needsNick) {
        showNicknameScreen();
        return;
      }
      state.authedNickname = data.nickname ?? null;
      if (data.nickname) showWelcomeBar(data.nickname);
      track("login_returning", { nickname: data.nickname });
      showQueueScreen();
    } catch (_) {
      showQueueScreen();
    }
  }
  function startSpectating() {
    connectSpectator();
  }
  function updateNameplates() {
    const info = state.spectateMatchInfo;
    if (info) {
      npP1Name.textContent = info.p1;
      npP2Name.textContent = info.p2;
      spectateNameplates.classList.remove("hidden");
    } else {
      spectateNameplates.classList.add("hidden");
    }
  }
  fetchLeaderboard();
  setInterval(() => {
    if (state.phase === "menu") fetchLeaderboard();
  }, 1e4);
  fetchQueue();

  // src/preview.ts
  function makePreviewPlayer(id, x, color, facing, name) {
    return {
      id,
      name,
      color,
      x,
      y: GROUND_Y - PLAYER_H,
      vx: 0,
      vy: 0,
      hp: 100,
      maxHp: 100,
      facing,
      state: "idle",
      attackActive: false
    };
  }
  function startPreview() {
    state.previewMode = true;
    state.previewBotTick = 0;
    state.playerID = 0;
    const p = makePreviewPlayer(0, 150, "#FF69B4", 1, "YOU");
    const bot = makePreviewPlayer(1, 600, "#FF8C00", -1, "BOT");
    state.gameState = {
      phase: "fighting",
      countdown: 0,
      tick: 0,
      winner: "",
      players: [p, bot]
    };
    state.pred = null;
    initPred(p.x, p.y);
    queueScreen.classList.add("hidden");
    hideBgCanvas();
    gameScreen.classList.remove("hidden");
    state.phase = "game";
    document.activeElement?.blur();
  }
  function stopPreview() {
    state.previewMode = false;
    state.gameState = null;
    state.playerID = null;
    state.pred = null;
    showQueueScreen();
  }
  function stepPreview() {
    if (!state.previewMode || !state.gameState) return;
    state.gameState.tick++;
    state.previewBotTick++;
    const players = state.gameState.players;
    const p = players[0];
    const bot = players[1];
    const { keys } = state;
    const onGround = p.y >= GROUND_Y - PLAYER_H - 1;
    if (keys.left) p.vx = -PREVIEW_SPEED;
    else if (keys.right) p.vx = PREVIEW_SPEED;
    else {
      p.vx *= 0.8;
      if (Math.abs(p.vx) < 0.2) p.vx = 0;
    }
    if (keys.jump && onGround) p.vy = PREVIEW_JUMP_VEL;
    p.vy += PREVIEW_GRAVITY;
    if (p.vy > 15) p.vy = 15;
    p.x += p.vx;
    p.y += p.vy;
    if (p.y >= GROUND_Y - PLAYER_H) {
      p.y = GROUND_Y - PLAYER_H;
      p.vy = 0;
    }
    p.x = Math.max(0, Math.min(W - PLAYER_W, p.x));
    p.facing = bot.x > p.x ? 1 : -1;
    if (state.previewAttackTimer > 0) {
      state.previewAttackTimer--;
      p.state = state.previewAttackState ?? "idle";
    } else if (!onGround || p.vy < -0.1) {
      p.state = "jumping";
    } else if (Math.abs(p.vx) > 0.3) {
      p.state = "walking";
    } else if (keys.fist) {
      p.state = "attack_fist";
      state.previewAttackState = "attack_fist";
      state.previewAttackTimer = PREVIEW_ATTACK_DURATION;
    } else if (keys.leg) {
      p.state = "attack_leg";
      state.previewAttackState = "attack_leg";
      state.previewAttackTimer = PREVIEW_ATTACK_DURATION;
    } else if (keys.uppercut) {
      p.state = "attack_uppercut";
      state.previewAttackState = "attack_uppercut";
      state.previewAttackTimer = PREVIEW_ATTACK_DURATION;
    } else if (keys.block) {
      p.state = "blocking";
    } else if (keys.dodge) {
      p.state = "dodging";
    } else {
      p.state = "idle";
    }
    const botWalkRight = Math.sin(state.previewBotTick / 80) > 0;
    bot.vx = botWalkRight ? 2 : -2;
    bot.x += bot.vx;
    bot.x = Math.max(80, Math.min(W - PLAYER_W - 80, bot.x));
    bot.facing = p.x < bot.x ? -1 : 1;
    bot.state = "walking";
    if (state.pred) {
      state.pred.x = p.x;
      state.pred.y = p.y;
      state.pred.vx = p.vx;
      state.pred.vy = p.vy;
    }
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.previewMode) stopPreview();
  });
  var previewBtn = document.getElementById("preview-btn");
  if (previewBtn) {
    const isDev = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (isDev) previewBtn.classList.remove("hidden");
    previewBtn.addEventListener("click", startPreview);
  }

  // src/main.ts
  function waitingRenderLoop() {
    if (state.phase !== "waiting") return;
    renderWaiting(state.queuedAs);
    requestAnimationFrame(waitingRenderLoop);
  }
  function gameRenderLoop() {
    if (state.phase !== "game") return;
    renderGame();
    requestAnimationFrame(gameRenderLoop);
  }
  function renderGame() {
    checkGameOverTransition();
    if (state.previewMode) stepPreview();
    else stepPred();
    ctx.clearRect(0, 0, W, H);
    if (!state.gameState) {
      drawLoading();
      return;
    }
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
    if (state.gameState.phase === "countdown") {
      drawCountdown(state.gameState.countdown);
    }
    if (state.fightFlash > 0) {
      drawFightText(state.fightFlash);
      state.fightFlash--;
    }
    if (state.gameState.phase === "gameover") {
      const winner = state.gameState.winner || "???";
      const isMe = !!(state.matchInfo && winner === state.matchInfo.you);
      const secsLeft = Math.ceil(Math.max(0, (gameOverReturnAt - performance.now()) / 1e3));
      drawGameOver(winner, isMe, secsLeft);
      if (performance.now() >= gameOverReturnAt) returnToMenu();
    }
    for (let i = 0; i < 2; i++) {
      if (state.hitFlash[i] > 0) state.hitFlash[i]--;
    }
  }
  var RETURN_DELAY_MS = 5e3;
  var gameOverReturnAt = Infinity;
  function returnToMenu() {
    gameOverReturnAt = Infinity;
    state.gameState = null;
    state.matchInfo = null;
    state.playerID = null;
    state.pred = null;
    state.hitEffects = [];
    showQueueScreen();
    startSpectating();
    startSpectateLoop();
  }
  var sawGameOver = false;
  function checkGameOverTransition() {
    if (state.phase !== "game") {
      sawGameOver = false;
      return;
    }
    if (state.gameState?.phase === "gameover" && !sawGameOver) {
      sawGameOver = true;
      gameOverReturnAt = performance.now() + RETURN_DELAY_MS;
    }
  }
  document.addEventListener("keydown", () => {
    if (state.phase === "game" && state.gameState?.phase === "gameover") {
      returnToMenu();
    }
  });
  var spectateRafId = null;
  var lastSpectateDraw = 0;
  function spectateRenderLoop(now) {
    if (state.phase !== "menu" && state.phase !== "waiting") {
      spectateRafId = null;
      return;
    }
    if (now - lastSpectateDraw >= 33) {
      renderSpectate(state.spectateState);
      lastSpectateDraw = now;
    }
    spectateRafId = requestAnimationFrame(spectateRenderLoop);
  }
  function startSpectateLoop() {
    if (spectateRafId !== null) return;
    spectateRafId = requestAnimationFrame(spectateRenderLoop);
  }
  setScreenCallbacks({
    onWaitingStart: () => requestAnimationFrame(waitingRenderLoop),
    onGameStart: () => requestAnimationFrame(gameRenderLoop)
  });
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
      queueMsg.textContent = "Disconnected. Refresh to try again.";
    },
    onError() {
      queueMsg.textContent = "Cannot reach server. Is it running on :8080?";
    }
  });
  (async () => {
    await initBgGif();
    await checkAuth();
    startSpectating();
    startSpectateLoop();
  })();
})();
//# sourceMappingURL=game.js.map
