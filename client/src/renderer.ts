import {
  W, H, GROUND_Y, PLAYER_W, PLAYER_H, SPRITE_DISPLAY_H,
  PW, PH, PGY, PW_P, PH_P, LOOP_LEN,
} from './constants';
import type { PlayerState, GameSnapshot, PowerUp, Projectile, HitEffect } from './types';
import { state } from './state';
import { getSpriteFrame } from './sprites';
import { interpOppPos } from './prediction';
import { SERVER_ONLY_STATES } from './constants';
import { lighten, darken, hexAlpha } from './colors';

// ── Canvas refs ────────────────────────────────────────────────────────────────

export const canvas  = document.getElementById('game-canvas') as HTMLCanvasElement;
export const ctx     = canvas.getContext('2d')!;
export const bgCanvas = document.getElementById('bg-canvas') as HTMLCanvasElement;
export const bgCtx   = bgCanvas.getContext('2d')!;

// Spectate canvas lives on the menu screen
export const spectateCanvas = document.getElementById('spectate-canvas') as HTMLCanvasElement;
export const spectateCtx    = spectateCanvas.getContext('2d')!;

// ── Background GIF (plays once, then freezes) ──────────────────────────────────

export function showBgCanvas(): void { bgCanvas.style.display = 'block'; }
export function hideBgCanvas(): void { bgCanvas.style.display = 'none'; }

export function initBgGif(): void {
  bgCanvas.width  = window.innerWidth;
  bgCanvas.height = window.innerHeight;
  window.addEventListener('resize', () => {
    bgCanvas.width  = window.innerWidth;
    bgCanvas.height = window.innerHeight;
  });

  const bgImg = new Image();
  bgImg.src = 'assets/background.gif';

  bgImg.onload = () => {
    state.bgAnimating = true;
    showBgCanvas();

    (function drawFrame() {
      if (!state.bgAnimating) return;
      bgCtx.drawImage(bgImg, 0, 0, bgCanvas.width, bgCanvas.height);
      bgCtx.fillStyle = 'rgba(13,0,26,0.55)';
      bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
      requestAnimationFrame(drawFrame);
    })();

    // Parse GIF frame delays in the background to know when to stop animating
    fetch('assets/background.gif')
      .then(r => r.arrayBuffer())
      .then(buf => {
        const data = new Uint8Array(buf);
        let durationMs = 0;
        for (let i = 0; i < data.length - 5; i++) {
          if (data[i] === 0x21 && data[i + 1] === 0xF9 && data[i + 2] === 0x04) {
            durationMs += ((data[i + 4] | (data[i + 5] << 8)) || 10) * 10;
            i += 7;
          }
        }
        if (durationMs > 0) setTimeout(() => { state.bgAnimating = false; }, durationMs);
      })
      .catch(() => { /* best-effort */ });
  };
}

// ── Background & ground ────────────────────────────────────────────────────────

export function drawBackground(): void {
  const g = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  g.addColorStop(0, '#07001a');
  g.addColorStop(1, '#140030');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(80,0,180,0.22)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 64) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, GROUND_Y); ctx.stroke();
  }
  for (let y = 0; y <= GROUND_Y; y += 64) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ([
    [80, 48], [320, 96], [608, 32], [896, 72], [1152, 112],
    [208, 160], [496, 128], [768, 176], [1040, 56], [1216, 152],
  ] as [number, number][]).forEach(([sx, sy]) => ctx.fillRect(sx, sy, 2, 2));
}

export function drawGround(): void {
  ctx.fillStyle = '#3a0060';
  ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
  for (let x = 0; x < W; x += 128) {
    ctx.fillStyle = (x / 128) % 2 === 0 ? '#4a1080' : '#3a0060';
    ctx.fillRect(x, GROUND_Y + 4, 128, H - GROUND_Y - 4);
  }
  const edge = ctx.createLinearGradient(0, GROUND_Y - 2, 0, GROUND_Y + 6);
  edge.addColorStop(0, '#cc44ff');
  edge.addColorStop(1, '#6600cc');
  ctx.fillStyle = edge;
  ctx.fillRect(0, GROUND_Y, W, 5);
}

// ── Placeholder character renderer ─────────────────────────────────────────────
//
// This is the PLACEHOLDER visual layer. When you have real 2D sprite sheets,
// replace the body of drawPlayerPlaceholder with drawImage() calls. The
// function signature, coordinate system, and all surrounding layers (hitbox
// outline, attack box, buff aura, name tag) stay exactly the same.
//
// Coordinate contract:
//   (x, y)        = top-left of the body hitbox   (PLAYER_W × PLAYER_H)
//   facing        = 1 (right) | -1 (left)
//   stateName     = one of PlayerStateName (idle, walking, attack_fist, …)
//
// Attack box coordinates come from the server already in world-space —
// no local calculation needed. They are drawn in a separate layer below.

export function drawPlayerPlaceholder(
  cx: CanvasRenderingContext2D,
  x: number, y: number,
  w: number, h: number,
  color: string,
  facing: number,
  tick: number,
  stateName: string,
): void {
  const isWalking   = stateName === 'walking';
  const isAttacking = stateName.startsWith('attack_');
  const isHurt      = stateName === 'hurt';
  const isBlocking  = stateName === 'blocking';
  const isDodging   = stateName === 'dodging';
  const isKO        = stateName === 'ko';

  cx.save();

  if (isHurt)    cx.globalAlpha = tick % 4 < 2 ? 0.35 : 1.0;
  if (isDodging) { cx.shadowColor = '#00eeff'; cx.shadowBlur = 14; }

  if (isKO) {
    // Fallen — horizontal bar
    cx.globalAlpha = 0.5;
    cx.fillStyle = color;
    cx.fillRect(x - Math.round(w * 0.3), y + h - Math.round(h * 0.18), w + Math.round(w * 0.6), Math.round(h * 0.18));
  } else {
    // ── Torso ─────────────────────────────────────────────────────────────────
    cx.fillStyle = color;
    cx.fillRect(x, y + Math.round(h * 0.30), w, Math.round(h * 0.42));

    // ── Head ──────────────────────────────────────────────────────────────────
    const headH = Math.round(h * 0.30);
    const headW = w - Math.round(w * 0.18);
    const headX = x + Math.round(w * 0.09);
    cx.fillStyle = lighten(color, 28);
    cx.fillRect(headX, y, headW, headH);

    // Eye
    const eyeOffX = Math.round(headW * (facing === 1 ? 0.65 : 0.15));
    const eyeX    = headX + eyeOffX;
    const eyeY    = y + Math.round(headH * 0.25);
    const es      = Math.max(3, Math.round(headW * 0.18));
    cx.fillStyle = '#fff';
    cx.fillRect(eyeX, eyeY, es, es);
    cx.fillStyle = '#111';
    cx.fillRect(eyeX + (facing === 1 ? Math.round(es * 0.4) : 0), eyeY + 1, Math.max(2, es - 2), Math.max(2, es - 2));

    // ── Legs ──────────────────────────────────────────────────────────────────
    const legTopY = y + Math.round(h * 0.72);
    const legH    = h - Math.round(h * 0.72);
    const legW    = Math.round(w * 0.28);
    cx.fillStyle  = darken(color, 25);
    const bob = isWalking ? Math.sin(tick / 9) * 4 : 0;
    cx.fillRect(x + 2,             legTopY + bob, legW, legH - bob);
    cx.fillRect(x + w - 2 - legW,  legTopY - bob, legW, legH + bob);

    // ── Arms ──────────────────────────────────────────────────────────────────
    cx.fillStyle = lighten(color, 12);
    const armTopY = y + Math.round(h * 0.30);
    const armW    = Math.round(w * 0.20);
    const armH    = Math.round(h * 0.30);

    if (isAttacking) {
      // Extend the attacking arm toward opponent
      const aExtX   = facing === 1 ? x + w : x - Math.round(w * 0.45);
      const aOffY   = stateName === 'attack_leg'      ? Math.round(h * 0.42)
                    : stateName === 'attack_uppercut' ? -Math.round(h * 0.08)
                    : Math.round(h * 0.10);
      cx.fillRect(aExtX, armTopY + aOffY, Math.round(w * 0.42), Math.round(h * 0.14));
      // Resting arm on the other side
      const restX = facing === 1 ? x - 3 : x + w - armW + 3;
      cx.fillRect(restX, armTopY, armW, armH);
    } else {
      cx.fillRect(x - 3,            armTopY, armW, armH);
      cx.fillRect(x + w - armW + 3, armTopY, armW, armH);
    }

    // ── Block shield ──────────────────────────────────────────────────────────
    if (isBlocking) {
      cx.save();
      cx.strokeStyle = 'rgba(140,140,255,0.9)';
      cx.lineWidth = 2;
      cx.shadowColor = '#8888ff';
      cx.shadowBlur = 12;
      cx.strokeRect(x - 4, y - 4, w + 8, h + 8);
      cx.restore();
    }
  }

  cx.restore();
}

// Keep the old name as an alias so preview.ts / waiting screen still compile.
export const drawSprite = drawPlayerPlaceholder;

// Draw a PNG sprite centred on the hitbox horizontally, feet anchored to hitbox bottom.
function drawCharSprite(
  cx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  hitX: number, hitY: number,
  facing: number,
): void {
  const dh   = SPRITE_DISPLAY_H;
  const dw   = dh * (img.naturalWidth / img.naturalHeight);
  const drawY  = hitY + PLAYER_H - dh;
  const cxMid  = hitX + PLAYER_W / 2;

  cx.save();
  cx.imageSmoothingEnabled = false;
  cx.translate(cxMid, 0);
  if (facing === -1) cx.scale(-1, 1);
  cx.drawImage(img, -dw / 2, drawY, dw, dh);
  cx.restore();
}

// ── Hit effects ────────────────────────────────────────────────────────────────
//
// PNG contract (optional — canvas fallback is automatic):
//   File: assets/hit_effect.png
//   Layout: single horizontal strip of 8 frames, each frame square.
//   Drop the file and it will be used automatically on the next page load.

const HIT_EFFECT_DURATION_MS = 420;
const HIT_EFFECT_FRAMES       = 8;

let hitEffectImg: HTMLImageElement | null = null;
let hitEffectLoaded = false;

(function loadHitEffectPng() {
  const img = new Image();
  img.onload  = () => { hitEffectImg = img; hitEffectLoaded = true; };
  img.onerror = () => { hitEffectLoaded = true; /* no png, use canvas fallback */ };
  img.src = 'assets/hit_effect.png';
})();

export function drawHitEffects(effects: HitEffect[]): void {
  const now = performance.now();
  for (const fx of effects) {
    const age    = now - fx.startMs;
    const t      = Math.min(age / HIT_EFFECT_DURATION_MS, 1); // 0→1 over duration
    const alpha  = 1 - t;

    if (hitEffectImg) {
      // ── PNG sprite sheet path ─────────────────────────────────────────────
      const frameIdx = Math.min(Math.floor(t * HIT_EFFECT_FRAMES), HIT_EFFECT_FRAMES - 1);
      const frameW   = hitEffectImg.naturalWidth / HIT_EFFECT_FRAMES;
      const drawSize = 80 + t * 40; // scale up slightly as it plays
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(
        hitEffectImg,
        frameIdx * frameW, 0, frameW, hitEffectImg.naturalHeight,
        fx.x - drawSize / 2, fx.y - drawSize / 2, drawSize, drawSize,
      );
      ctx.restore();
    } else {
      // ── Canvas fallback ───────────────────────────────────────────────────
      const isProjectile = fx.kind === 'projectile';
      const coreColor    = isProjectile ? '#ff6600' : '#ffffff';
      const ringColor    = isProjectile ? '#ff2200' : '#ffcc00';

      ctx.save();

      // Flash burst (sharp at t=0, gone by t=0.35)
      if (t < 0.35) {
        const flashAlpha = (1 - t / 0.35) * 0.85;
        const flashR     = 4 + t * 28;
        ctx.globalAlpha = flashAlpha;
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, flashR, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = coreColor;
        ctx.shadowBlur  = 18;
        ctx.fill();
      }

      // Expanding ring
      const ringR = 8 + t * 38;
      const ringW = Math.max(1, 4 - t * 3);
      ctx.globalAlpha = alpha * 0.9;
      ctx.beginPath();
      ctx.arc(fx.x, fx.y, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = ringColor;
      ctx.lineWidth   = ringW;
      ctx.shadowColor = ringColor;
      ctx.shadowBlur  = 10;
      ctx.stroke();

      // 6 spark lines radiating outward
      const sparkLen = 6 + t * 18;
      const sparkFade = Math.max(0, 1 - t * 2.2);
      ctx.globalAlpha = sparkFade;
      ctx.strokeStyle = coreColor;
      ctx.lineWidth   = 1.5;
      ctx.shadowBlur  = 6;
      for (let i = 0; i < 6; i++) {
        const angle  = (i / 6) * Math.PI * 2;
        const inner  = ringR * 0.4;
        const outer  = inner + sparkLen;
        ctx.beginPath();
        ctx.moveTo(fx.x + Math.cos(angle) * inner, fx.y + Math.sin(angle) * inner);
        ctx.lineTo(fx.x + Math.cos(angle) * outer, fx.y + Math.sin(angle) * outer);
        ctx.stroke();
      }

      ctx.restore();
    }
  }
}

// ── Projectiles ────────────────────────────────────────────────────────────────
//
// Positions are extrapolated forward from the last server snapshot so the
// bullet moves smoothly between ticks rather than snapping every 16 ms.

export function drawProjectiles(projectiles: Projectile[]): void {
  const msSinceSnap = performance.now() - state.lastSnapAt;
  const extraTicks  = Math.min(msSinceSnap / (1000 / 60), 4);

  for (const proj of projectiles) {
    const rx = proj.x + proj.vx * extraTicks;
    const ry = proj.y;

    // ── PLACEHOLDER: replace with sprite image ──────────────────────────────
    ctx.save();

    // Outer glow halo
    ctx.shadowColor = '#ff2200';
    ctx.shadowBlur  = 30;
    ctx.beginPath();
    ctx.arc(rx, ry, 22, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,80,0,0.35)';
    ctx.fill();

    // Core circle
    ctx.shadowBlur  = 20;
    ctx.beginPath();
    ctx.arc(rx, ry, 14, 0, Math.PI * 2);
    ctx.fillStyle   = '#ff4400';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth   = 3;
    ctx.fill();
    ctx.stroke();

    ctx.restore();
  }
}

// ── Power-ups ──────────────────────────────────────────────────────────────────

export function drawPowerUps(powerUps: PowerUp[]): void {
  const t = Date.now() / 1000;
  for (const pu of powerUps) {
    const bob = Math.sin(t * 2.5 + pu.id) * 3;
    const label = pu.kind === 'speed' ? '⚡' : pu.kind === 'shoot' ? '🔥' : '💥';
    const glow  = pu.kind === 'speed' ? '#00eeff' : pu.kind === 'shoot' ? '#ff4400' : '#ff8800';

    ctx.save();
    ctx.shadowColor = glow;
    ctx.shadowBlur  = 16 + Math.sin(t * 3) * 6;
    ctx.font = '20px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, pu.x, pu.y + bob);
    ctx.restore();

    // Spinning ring
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

// ── Full-size game player ──────────────────────────────────────────────────────
//
// Rendering is split into clearly ordered layers so each layer can be
// swapped independently when real art assets become available:
//
//   Layer 1 — body hitbox outline   (collision reference, always visible)
//   Layer 2 — character visual      ← REPLACE THIS with sprite sheet
//   Layer 3 — attack hitbox rect    (server-authoritative, colour-coded)
//   Layer 4 — buff aura             (visual only, from server buff ticks)
//   Layer 5 — name tag              (always on top)

export function drawGamePlayer(p: PlayerState): void {
  const isLocal = p.id === state.playerID;

  // ── Resolve render position ─────────────────────────────────────────────────
  let x: number, y: number;
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

  // Local predicted attack state for instant visual feedback
  let renderState: string = p.state;
  if (
    isLocal && state.predictedAttack &&
    (p.state === 'idle' || p.state === 'walking' || p.state === 'jumping')
  ) {
    renderState = state.predictedAttack;
  }

  // ── Layer 1: Body hitbox rectangle ──────────────────────────────────────────
  // Solid vertical rect = exact collision box the server uses.
  // Remove or reduce opacity once real sprites are in.
  {
    const col = p.id === 0 ? '#FF69B4' : '#FF8C00';
    ctx.save();
    // Slight fill so the inside of the box is readable
    ctx.fillStyle = p.id === 0 ? 'rgba(255,105,180,0.10)' : 'rgba(255,140,0,0.10)';
    ctx.fillRect(x, y, PLAYER_W, PLAYER_H);
    // Solid outline
    ctx.strokeStyle = col;
    ctx.lineWidth   = 2;
    ctx.shadowColor = col;
    ctx.shadowBlur  = 6;
    ctx.strokeRect(x, y, PLAYER_W, PLAYER_H);
    // Corner ticks to make it feel like a targeting reticle
    const t = 6;
    ctx.lineWidth = 2;
    ctx.shadowBlur = 0;
    // top-left
    ctx.beginPath(); ctx.moveTo(x, y + t); ctx.lineTo(x, y); ctx.lineTo(x + t, y); ctx.stroke();
    // top-right
    ctx.beginPath(); ctx.moveTo(x + PLAYER_W - t, y); ctx.lineTo(x + PLAYER_W, y); ctx.lineTo(x + PLAYER_W, y + t); ctx.stroke();
    // bottom-left
    ctx.beginPath(); ctx.moveTo(x, y + PLAYER_H - t); ctx.lineTo(x, y + PLAYER_H); ctx.lineTo(x + t, y + PLAYER_H); ctx.stroke();
    // bottom-right
    ctx.beginPath(); ctx.moveTo(x + PLAYER_W - t, y + PLAYER_H); ctx.lineTo(x + PLAYER_W, y + PLAYER_H); ctx.lineTo(x + PLAYER_W, y + PLAYER_H - t); ctx.stroke();
    ctx.restore();
  }

  // ── Layer 2: Character visual (placeholder → replace with sprite) ───────────
  ctx.save();
  if (state.hitFlash[p.id] > 0) ctx.globalAlpha = state.hitFlash[p.id] % 2 === 0 ? 0.3 : 1.0;

  const spriteFrame = getSpriteFrame(p.id, renderState);
  if (spriteFrame) {
    // PNG sprite sheet: drawImage centred on hitbox, feet anchored to bottom
    drawCharSprite(ctx, spriteFrame, x, y, p.facing);
  } else {
    // ── PLACEHOLDER ────────────────────────────────────────────────────────────
    // Replace this block with your 2D sprite sheet rendering.
    // Keep (x, y, PLAYER_W, PLAYER_H) as the anchor contract.
    drawPlayerPlaceholder(ctx, x, y, PLAYER_W, PLAYER_H, p.color, p.facing, Date.now() / 16, renderState);
  }
  ctx.restore();

  // ── Layer 3: Attack hitbox (colour-coded per move) ──────────────────────────
  // Box coordinates come from the server — no local math needed.
  if (p.attackActive && p.attackBox) {
    const ab = p.attackBox;
    const atkFill   = p.state === 'attack_fist'     ? 'rgba(0,200,255,0.30)'
                    : p.state === 'attack_leg'       ? 'rgba(255,160,0,0.30)'
                    :                                  'rgba(230,0,255,0.30)';
    const atkStroke = p.state === 'attack_fist'     ? 'rgba(0,220,255,0.90)'
                    : p.state === 'attack_leg'       ? 'rgba(255,180,0,0.90)'
                    :                                  'rgba(230,0,255,0.90)';
    ctx.save();
    ctx.fillStyle   = atkFill;
    ctx.strokeStyle = atkStroke;
    ctx.lineWidth   = 2;
    ctx.fillRect(ab.x, ab.y, ab.w, ab.h);
    ctx.strokeRect(ab.x, ab.y, ab.w, ab.h);
    // Small label so you can tell moves apart at a glance
    ctx.fillStyle = atkStroke;
    ctx.font = 'bold 8px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(
      p.state === 'attack_fist' ? 'FIST' : p.state === 'attack_leg' ? 'KICK' : 'UPCUT',
      ab.x + ab.w / 2, ab.y - 2,
    );
    ctx.restore();
  }

  // ── Layer 4: Buff aura ──────────────────────────────────────────────────────
  const t = Date.now() / 1000;
  if ((p.speedBuff ?? 0) > 0 || (p.damageBuff ?? 0) > 0) {
    ctx.save();
    if ((p.speedBuff ?? 0) > 0) {
      ctx.strokeStyle = '#00eeff';
      ctx.shadowColor = '#00eeff';
      ctx.shadowBlur  = 10 + Math.sin(t * 6) * 4;
      ctx.lineWidth   = 2;
      ctx.strokeRect(x - 4, y - 4, PLAYER_W + 8, PLAYER_H + 8);
    }
    if ((p.damageBuff ?? 0) > 0) {
      ctx.strokeStyle = '#ff6600';
      ctx.shadowColor = '#ff4400';
      ctx.shadowBlur  = 10 + Math.sin(t * 6 + 1) * 4;
      ctx.lineWidth   = 2;
      ctx.strokeRect(x - 7, y - 7, PLAYER_W + 14, PLAYER_H + 14);
    }
    ctx.restore();
  }

  // ── Layer 5: Name tag ───────────────────────────────────────────────────────
  if (p.state !== 'ko') {
    const buffIcons = [
      (p.speedBuff  ?? 0) > 0 ? '⚡' : '',
      (p.damageBuff ?? 0) > 0 ? '💥' : '',
      (p.shootBuff  ?? 0) > 0 ? `🔥×${p.shootBuff}` : '',
    ].filter(Boolean).join(' ');
    ctx.save();
    ctx.fillStyle   = '#fff';
    ctx.font        = 'bold 13px Bangers';
    ctx.textAlign   = 'center';
    ctx.shadowColor = '#000';
    ctx.shadowBlur  = 5;
    ctx.fillText(p.name + (buffIcons ? ' ' + buffIcons : ''), x + PLAYER_W / 2, y - 5);
    ctx.restore();
  }
}

// ── HUD ────────────────────────────────────────────────────────────────────────

function drawHealthBar(
  x: number, y: number, w: number, h: number,
  p: PlayerState,
  rightAlign: boolean,
): void {
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
  ctx.shadowColor = p.color;
  ctx.shadowBlur = 6;
  ctx.strokeRect(x, y, w, h);
  ctx.shadowBlur = 0;

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px Bangers';
  ctx.textAlign = 'center';
  ctx.shadowColor = '#000';
  ctx.shadowBlur = 4;
  ctx.fillText(`${p.name}  ${p.hp}/${p.maxHp}`, x + w / 2, y + h - 6);
  ctx.shadowBlur = 0;
}

export function drawHUD(gameState: GameSnapshot | null): void {
  if (!gameState?.players) return;
  const [p1, p2] = gameState.players;
  if (!p1 || !p2) return;

  drawHealthBar(16,       16, 384, 45, p1, false);
  drawHealthBar(W - 400,  16, 384, 45, p2, true);

  ctx.save();
  ctx.font = 'bold 32px Bangers';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#FFD700';
  ctx.shadowColor = '#FF6600';
  ctx.shadowBlur = 10;
  ctx.fillText('VS', W / 2, 48);
  ctx.restore();

  if (state.playerID !== null) {
    const isLeft = state.playerID === 0;
    ctx.save();
    ctx.font = 'bold 16px Bangers';
    ctx.fillStyle = '#00ff99';
    ctx.textAlign = isLeft ? 'left' : 'right';
    ctx.fillText(isLeft ? '▲ YOU' : 'YOU ▲', isLeft ? 19 : W - 19, 83);
    ctx.restore();
  }
}

// ── Overlays ───────────────────────────────────────────────────────────────────

export function drawCountdown(count: number): void {
  if (count <= 0) return;
  ctx.save();
  ctx.font = 'bold 208px Bangers';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFD700';
  ctx.shadowColor = '#FF6600';
  ctx.shadowBlur = 40;
  ctx.fillText(String(count), W / 2, H / 2);
  ctx.restore();
}

export function drawFightText(fightFlash: number): void {
  const alpha = Math.min(1, fightFlash / 25);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = 'bold 176px Bangers';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FF6600';
  ctx.shadowColor = '#FF0000';
  ctx.shadowBlur = 50;
  ctx.fillText('FIGHT!', W / 2, H / 2);
  ctx.restore();
}

export function drawGameOver(
  winner: string,
  isMe: boolean,
  secsLeft: number,
): void {
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.font = 'bold 141px Bangers';
  ctx.fillStyle = '#FF2222';
  ctx.shadowColor = '#FF0000';
  ctx.shadowBlur = 40;
  ctx.fillText('K.O.!', W / 2, H / 2 - 104);

  ctx.font = 'bold 67px Bangers';
  ctx.fillStyle = '#FFD700';
  ctx.shadowColor = '#FF8800';
  ctx.shadowBlur = 20;
  ctx.fillText(`${winner} WINS!`, W / 2, H / 2 + 29);

  ctx.font = 'bold 35px Bangers';
  ctx.fillStyle = isMe ? '#00ff88' : '#ff4466';
  ctx.shadowBlur = 10;
  ctx.fillText(isMe ? 'VICTORY!' : 'DEFEATED', W / 2, H / 2 + 115);

  ctx.font = 'bold 22px Bangers';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.shadowBlur = 0;
  ctx.fillText(
    secsLeft > 0 ? `Returning to menu in ${secsLeft}…  (press any key to skip)` : 'Returning…',
    W / 2, H / 2 + 175,
  );

  ctx.restore();
}

export function drawLoading(): void {
  ctx.fillStyle = '#0d001a';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#FFD700';
  ctx.font = '35px Bangers';
  ctx.textAlign = 'center';
  ctx.fillText('Loading…', W / 2, H / 2);
}

// ── Waiting screen ─────────────────────────────────────────────────────────────

function drawWaitingHPBar(
  x: number, y: number, w: number, h: number,
  color: string, name: string, rightAlign: boolean,
): void {
  ctx.save();
  if (rightAlign) ctx.globalAlpha = 0.35;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(x, y, w, h);
  if (!rightAlign) {
    ctx.fillStyle = '#44ff44';
    ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.shadowColor = color;
  ctx.shadowBlur = 6;
  ctx.strokeRect(x, y, w, h);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px Bangers';
  ctx.textAlign = 'center';
  ctx.shadowColor = '#000';
  ctx.shadowBlur = 4;
  ctx.fillText(rightAlign ? '???  --/--' : `${name}  100/100`, x + w / 2, y + h - 6);
  ctx.restore();
}

export function renderWaiting(queuedAs: string | null): void {
  const t = Date.now() / 16;
  ctx.clearRect(0, 0, W, H);
  drawBackground();
  drawGround();

  const p1x = 192, p1y = GROUND_Y - PLAYER_H;
  drawSprite(ctx, p1x, p1y, PLAYER_W, PLAYER_H, '#FF69B4', 1, t, 'idle');
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 18px Bangers';
  ctx.textAlign = 'center';
  ctx.shadowColor = '#000';
  ctx.shadowBlur = 5;
  ctx.fillText(queuedAs ?? 'YOU', p1x + PLAYER_W / 2, p1y - 11);
  ctx.restore();

  const p2x = W - 120 - PLAYER_W, p2y = GROUND_Y - PLAYER_H;
  const alpha = 0.25 + 0.2 * Math.sin(Date.now() / 400);
  ctx.save();
  ctx.globalAlpha = alpha;
  drawSprite(ctx, p2x, p2y, PLAYER_W, PLAYER_H, '#FF8C00', -1, t, 'idle');
  ctx.globalAlpha = Math.min(1, alpha * 2.2);
  ctx.fillStyle = '#FF8C00';
  ctx.font = 'bold 18px Bangers';
  ctx.textAlign = 'center';
  ctx.shadowColor = '#000';
  ctx.shadowBlur = 5;
  ctx.fillText('???', p2x + PLAYER_W / 2, p2y - 7);
  ctx.restore();

  drawWaitingHPBar(10,      10, 240, 28, '#FF69B4', queuedAs ?? 'YOU', false);
  drawWaitingHPBar(W - 250, 10, 240, 28, '#FF8C00', '???',             true);

  ctx.save();
  ctx.font = 'bold 20px Bangers';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#FFD700';
  ctx.shadowColor = '#FF6600';
  ctx.shadowBlur = 10;
  ctx.fillText('VS', W / 2, 30);
  ctx.restore();
}

// ── Preview mini-canvas ────────────────────────────────────────────────────────

function drawPreviewHPBar(
  cx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  hp: number, maxHp: number,
  color: string, name: string, right: boolean,
): void {
  const pct  = Math.max(0, hp / maxHp);
  const bw   = Math.round(pct * (w - 2));
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
  cx.font = 'bold 7px Bangers';
  cx.textAlign = 'center';
  cx.fillText(`${name} ${hp}`, x + w / 2, y + h - 2);
}

interface PreviewScene {
  ax: number; ay: number;
  bx: number; by: number;
  aState: string; bState: string;
  aHP: number; bHP: number;
  aFace: number; bFace: number;
}

export function getPreviewScene(t: number): PreviewScene {
  const f = t % LOOP_LEN;

  let ax = 55, ay = PGY - PH_P;
  let bx = PW - 55 - PW_P, by = PGY - PH_P;
  let aState = 'idle', bState = 'idle';
  let aHP = 100, bHP = 100;
  let aFace = 1, bFace = -1;

  if (f < 50) {
    if (f > 20 && f < 35) bState = 'jumping';
  } else if (f < 100) {
    const pct = (f - 50) / 50;
    ax = 55 + pct * 55;
    aState = 'walking';
  } else if (f < 120) {
    ax = 110;
    aState = 'attack_fist';
  } else if (f < 155) {
    ax = 110;
    bx = PW - 55 - PW_P + (f - 120) * 1.2;
    aState = 'idle';
    bState = f < 138 ? 'hurt' : 'idle';
    bHP = 90;
  } else if (f < 210) {
    const pct = (f - 155) / 55;
    ax = 110;
    bx = Math.max((PW - 55 - PW_P + 42) - pct * 100, ax + PW_P + 20);
    bState = 'walking';
    bHP = 90;
  } else if (f < 230) {
    ax = 110; bx = ax + PW_P + 22;
    bState = 'attack_leg';
    bHP = 90;
    aFace = 1; bFace = -1;
  } else if (f < 260) {
    ax = 110; bx = ax + PW_P + 22;
    aState = f < 248 ? 'blocking' : 'idle';
    bHP = 90; aHP = 93;
  } else if (f < 290) {
    ax = 110; bx = ax + PW_P + 22;
    aState = 'attack_uppercut';
    bState = f < 275 ? 'idle' : 'hurt';
    bHP = f < 278 ? 90 : 65;
    aHP = 93;
    if (f < 275) ay = PGY - PH_P - Math.sin(((f - 260) / 15) * Math.PI) * 18;
  } else if (f < 320) {
    ax = 110; bx = ax + PW_P + 30 + (f - 290) * 1.5;
    bState = 'hurt';
    bHP = 65; aHP = 93;
  } else {
    const pct = (f - 320) / 60;
    ax = 110 - pct * 60;
    bx = Math.min(PW - 55 - PW_P, (ax + PW_P + 50) + pct * 70);
    aState = pct > 0.1 ? 'walking' : 'idle';
    bState = pct > 0.1 ? 'walking' : 'idle';
    aFace = pct < 0.5 ? -1 : 1;
    bFace = pct < 0.5 ? 1 : -1;
    bHP = 65 + Math.round(pct * 35);
    aHP = 93 + Math.round(pct * 7);
  }

  ax = Math.max(2, Math.min(PW - PW_P - 2, ax));
  bx = Math.max(2, Math.min(PW - PW_P - 2, bx));

  return { ax, ay, bx, by, aState, bState, aHP, bHP, aFace, bFace };
}

export function drawPreview(cx: CanvasRenderingContext2D, pw: number, ph: number, tick: number): void {
  cx.clearRect(0, 0, pw, ph);

  const bg = cx.createLinearGradient(0, 0, 0, PGY);
  bg.addColorStop(0, '#080014');
  bg.addColorStop(1, '#110025');
  cx.fillStyle = bg;
  cx.fillRect(0, 0, pw, ph);

  cx.strokeStyle = 'rgba(70, 0, 160, 0.25)';
  cx.lineWidth = 1;
  for (let x = 0; x <= pw; x += 30) {
    cx.beginPath(); cx.moveTo(x, 0); cx.lineTo(x, PGY); cx.stroke();
  }
  for (let y = 0; y <= PGY; y += 30) {
    cx.beginPath(); cx.moveTo(0, y); cx.lineTo(pw, y); cx.stroke();
  }

  cx.fillStyle = '#3a0060';
  cx.fillRect(0, PGY, pw, ph - PGY);
  const topEdge = cx.createLinearGradient(0, PGY - 2, 0, PGY + 5);
  topEdge.addColorStop(0, '#cc44ff');
  topEdge.addColorStop(1, '#660099');
  cx.fillStyle = topEdge;
  cx.fillRect(0, PGY, pw, 4);
  for (let x = 0; x < pw; x += 60) {
    cx.fillStyle = (x / 60) % 2 === 0 ? '#4a1080' : '#3a0060';
    cx.fillRect(x, PGY + 4, 60, ph - PGY - 4);
  }

  const sc = getPreviewScene(tick);

  drawPreviewHPBar(cx, 6, 6, 120, 14, sc.aHP, 100, '#FF69B4', 'ALICE', false);
  drawPreviewHPBar(cx, pw - 126, 6, 120, 14, sc.bHP, 100, '#FF8C00', 'BOB', true);

  drawSprite(cx, sc.ax, sc.ay, PW_P, PH_P, '#FF69B4', sc.aFace, tick, sc.aState);
  drawSprite(cx, sc.bx, sc.by, PW_P, PH_P, '#FF8C00', sc.bFace, tick, sc.bState);

  cx.save();
  cx.fillStyle = '#ff2222';
  cx.beginPath();
  (cx as CanvasRenderingContext2D & { roundRect: CanvasRenderingContext2D['roundRect'] })
    .roundRect(pw - 44, ph - 20, 40, 14, 3);
  cx.fill();
  cx.fillStyle = '#fff';
  cx.font = 'bold 8px Bangers';
  cx.textAlign = 'center';
  cx.fillText('● LIVE', pw - 24, ph - 9);
  cx.restore();
}

export function drawCharCard(
  cx: CanvasRenderingContext2D,
  cw: number, ch: number,
  color: string, facing: number,
  tick: number, name: string,
): void {
  cx.clearRect(0, 0, cw, ch);

  const grd = cx.createRadialGradient(cw / 2, ch * 0.5, 5, cw / 2, ch * 0.5, 70);
  grd.addColorStop(0, hexAlpha(color, 0.18));
  grd.addColorStop(1, 'transparent');
  cx.fillStyle = grd;
  cx.fillRect(0, 0, cw, ch);

  const breath = Math.sin(tick / 40) * 2;
  const spW = 52, spH = 78;
  const sx = (cw - spW) / 2;
  const sy = ch - spH - 14 + breath;
  drawSprite(cx, sx, sy, spW, spH, color, facing, tick, 'idle');

  cx.fillStyle = 'rgba(255,255,255,0.08)';
  cx.fillRect(8, ch - 16, cw - 16, 2);

  cx.fillStyle = 'rgba(0,0,0,0.3)';
  cx.beginPath();
  cx.ellipse(cw / 2, ch - 14, 22, 5, 0, 0, Math.PI * 2);
  cx.fill();

  void name; // name used by callers for label rendering outside this function
}

// ── Spectate render (menu page live view) ─────────────────────────────────────
// Renders directly from the server snapshot — no client-side prediction.
// Uses spectateCtx so it never touches the in-match game canvas.

function drawSpectateHealthBar(
  cx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  p: GameSnapshot['players'][0],
  rightAlign: boolean,
): void {
  const pct  = Math.max(0, p.hp / p.maxHp);
  const barW = Math.round(pct * (w - 4));
  const hpCol = pct > 0.5 ? '#44ff44' : pct > 0.25 ? '#ffcc00' : '#ff2222';

  cx.fillStyle = 'rgba(0,0,0,0.6)';
  cx.fillRect(x, y, w, h);

  cx.fillStyle = hpCol;
  if (rightAlign) cx.fillRect(x + 2 + (w - 4 - barW), y + 2, barW, h - 4);
  else            cx.fillRect(x + 2, y + 2, barW, h - 4);

  cx.strokeStyle = p.color;
  cx.lineWidth = 2;
  cx.shadowColor = p.color; cx.shadowBlur = 6;
  cx.strokeRect(x, y, w, h);
  cx.shadowBlur = 0;

  cx.fillStyle = '#fff';
  cx.font = 'bold 11px Bangers';
  cx.textAlign = 'center';
  cx.shadowColor = '#000'; cx.shadowBlur = 4;
  cx.fillText(`${p.name}  ${p.hp}/${p.maxHp}`, x + w / 2, y + h - 6);
  cx.shadowBlur = 0;
}

export function renderSpectate(snapshot: GameSnapshot | null): void {
  const cx = spectateCtx;
  const cw = spectateCanvas.width;   // 1280
  const ch = spectateCanvas.height;  // 720

  cx.clearRect(0, 0, cw, ch);

  if (!snapshot) {
    // No active match — draw a placeholder
    const g = cx.createLinearGradient(0, 0, 0, ch);
    g.addColorStop(0, '#07001a');
    g.addColorStop(1, '#140030');
    cx.fillStyle = g;
    cx.fillRect(0, 0, cw, ch);

    cx.save();
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.font = 'bold 52px Bangers';
    cx.fillStyle = 'rgba(255,255,255,0.12)';
    cx.fillText('NO ACTIVE MATCH', cw / 2, ch / 2 - 30);
    cx.font = 'bold 26px Bangers';
    cx.fillStyle = 'rgba(255,215,0,0.35)';
    cx.fillText('BE THE FIRST TO FIGHT', cw / 2, ch / 2 + 30);
    cx.restore();
    return;
  }

  // ── Draw arena ────────────────────────────────────────────────────────────
  // Background
  const bg = cx.createLinearGradient(0, 0, 0, GROUND_Y);
  bg.addColorStop(0, '#07001a');
  bg.addColorStop(1, '#140030');
  cx.fillStyle = bg;
  cx.fillRect(0, 0, cw, ch);

  cx.strokeStyle = 'rgba(80,0,180,0.22)';
  cx.lineWidth = 1;
  for (let x = 0; x <= cw; x += 64) { cx.beginPath(); cx.moveTo(x, 0); cx.lineTo(x, GROUND_Y); cx.stroke(); }
  for (let y = 0; y <= GROUND_Y; y += 64) { cx.beginPath(); cx.moveTo(0, y); cx.lineTo(cw, y); cx.stroke(); }
  cx.fillStyle = 'rgba(255,255,255,0.5)';
  ([
    [80, 48], [320, 96], [608, 32], [896, 72], [1152, 112],
    [208, 160], [496, 128], [768, 176], [1040, 56], [1216, 152],
  ] as [number, number][]).forEach(([sx, sy]) => cx.fillRect(sx, sy, 2, 2));

  // Ground
  cx.fillStyle = '#3a0060';
  cx.fillRect(0, GROUND_Y, cw, ch - GROUND_Y);
  for (let x = 0; x < cw; x += 128) {
    cx.fillStyle = (x / 128) % 2 === 0 ? '#4a1080' : '#3a0060';
    cx.fillRect(x, GROUND_Y + 4, 128, ch - GROUND_Y - 4);
  }
  const edge = cx.createLinearGradient(0, GROUND_Y - 2, 0, GROUND_Y + 6);
  edge.addColorStop(0, '#cc44ff'); edge.addColorStop(1, '#6600cc');
  cx.fillStyle = edge;
  cx.fillRect(0, GROUND_Y, cw, 5);

  // ── Draw players ──────────────────────────────────────────────────────────
  for (const p of snapshot.players) {
    if (!p) continue;
    const spriteFrame = getSpriteFrame(p.id, p.state);
    cx.save();
    if (spriteFrame) {
      const dh   = SPRITE_DISPLAY_H;
      const dw   = dh * (spriteFrame.naturalWidth / spriteFrame.naturalHeight);
      const drawY  = p.y + PLAYER_H - dh;
      const cxMid  = p.x + PLAYER_W / 2;
      cx.imageSmoothingEnabled = false;
      cx.translate(cxMid, 0);
      if (p.facing === -1) cx.scale(-1, 1);
      cx.drawImage(spriteFrame, -dw / 2, drawY, dw, dh);
    } else {
      drawSprite(cx, p.x, p.y, PLAYER_W, PLAYER_H, p.color, p.facing, Date.now() / 16, p.state);
    }
    cx.restore();

    // Name tag
    if (p.state !== 'ko') {
      cx.save();
      cx.fillStyle = '#fff'; cx.font = 'bold 18px Bangers';
      cx.textAlign = 'center'; cx.shadowColor = '#000'; cx.shadowBlur = 5;
      cx.fillText(p.name, p.x + PLAYER_W / 2, p.y - 11);
      cx.restore();
    }
  }

  // ── HUD ───────────────────────────────────────────────────────────────────
  const [p1, p2] = snapshot.players;
  if (p1 && p2) {
    drawSpectateHealthBar(cx, 16,      16, 384, 45, p1, false);
    drawSpectateHealthBar(cx, cw - 400, 16, 384, 45, p2, true);
    cx.save();
    cx.font = 'bold 32px Bangers'; cx.textAlign = 'center';
    cx.fillStyle = '#FFD700'; cx.shadowColor = '#FF6600'; cx.shadowBlur = 10;
    cx.fillText('VS', cw / 2, 48);
    cx.restore();
  }

  // ── Overlays ──────────────────────────────────────────────────────────────
  if (snapshot.phase === 'countdown' && snapshot.countdown > 0) {
    cx.save();
    cx.font = 'bold 208px Bangers'; cx.textAlign = 'center'; cx.textBaseline = 'middle';
    cx.fillStyle = '#FFD700'; cx.shadowColor = '#FF6600'; cx.shadowBlur = 40;
    cx.fillText(String(snapshot.countdown), cw / 2, ch / 2);
    cx.restore();
  }

  if (snapshot.phase === 'gameover') {
    cx.fillStyle = 'rgba(0,0,0,0.62)';
    cx.fillRect(0, 0, cw, ch);
    cx.save();
    cx.textAlign = 'center'; cx.textBaseline = 'middle';
    cx.font = 'bold 141px Bangers'; cx.fillStyle = '#FF2222';
    cx.shadowColor = '#FF0000'; cx.shadowBlur = 40;
    cx.fillText('K.O.!', cw / 2, ch / 2 - 104);
    cx.font = 'bold 67px Bangers'; cx.fillStyle = '#FFD700';
    cx.shadowColor = '#FF8800'; cx.shadowBlur = 20;
    cx.fillText(`${snapshot.winner} WINS!`, cw / 2, ch / 2 + 29);
    cx.restore();
  }

  // 🔴 LIVE badge
  cx.save();
  cx.fillStyle = '#ff2222';
  cx.beginPath();
  cx.roundRect(cw - 90, 8, 76, 26, 6);
  cx.fill();
  cx.fillStyle = '#fff'; cx.font = 'bold 14px Bangers';
  cx.textAlign = 'center'; cx.textBaseline = 'middle';
  cx.fillText('● LIVE', cw - 52, 21);
  cx.restore();
}
