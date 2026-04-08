import type { AttackKey, AttackStateName, PlayerStateName, SpriteName } from './types';

// ── Canvas / world ─────────────────────────────────────────────────────────────
export const W = 1280;
export const H = 720;
export const GROUND_Y = 592;
export const PLAYER_W = 27;
export const PLAYER_H = 42;

// ── Physics (per-tick at 60 fps — must mirror server match.go exactly) ─────────
export const GRAVITY       = 0.52;
export const JUMP_VEL      = -10.8;
export const MOVE_SPEED    = 4.0;
export const MAX_FALL_SPEED = 14.4;

// ── Networking ─────────────────────────────────────────────────────────────────
export const TICK_MS = 1000 / 60; // expected ms between server ticks

// ── Sprites ────────────────────────────────────────────────────────────────────
export const MS_PER_FRAME    = 150;  // 150 ms per frame → ~6.7 fps
export const SPRITE_DISPLAY_H = 117; // render height on the 720-tall canvas

/** PlayerStateName → sprite sheet basename */
export const STATE_TO_SPRITE: Record<PlayerStateName, SpriteName> = {
  idle:            'idle',
  walking:         'walk',
  jumping:         'jump',
  attack_fist:     'attack_fist',
  attack_leg:      'attack_leg',
  attack_uppercut: 'attack_uppercut',
  blocking:        'blocking',
  dodging:         'dodging',
  hurt:            'hurt',
  ko:              'ko',
};

// ── Attack timing (ticks @ 60 fps) ────────────────────────────────────────────
export const ATTACK_DURATIONS: Record<AttackStateName, number> = {
  attack_fist:     36,
  attack_leg:      44,
  attack_uppercut: 56,
};

export const ATTACK_COOLDOWNS: Record<AttackStateName, number> = {
  attack_fist:     56,
  attack_leg:      76,
  attack_uppercut: 110,
};

/** Maps AttackStateName → the cooldown key used in localCooldowns / server cooldowns */
export const ATTACK_CD_KEY: Record<AttackStateName, AttackKey> = {
  attack_fist:     'fist',
  attack_leg:      'leg',
  attack_uppercut: 'uppercut',
};

/** States where client-side prediction defers to server for position */
export const SERVER_ONLY_STATES = new Set<PlayerStateName>([
  'blocking', 'dodging', 'hurt', 'ko',
]);

// ── Preview mini-canvas ────────────────────────────────────────────────────────
export const PW    = 420;
export const PH    = 190;
export const SC    = 0.75;
export const PW_P  = Math.round(PLAYER_W * SC); // 60
export const PH_P  = Math.round(PLAYER_H * SC); // 96
export const PGY   = 155;  // ground Y in preview

export const CW = 130; // character card canvas width
export const CH = 180; // character card canvas height

export const LOOP_LEN = 380; // frames per full preview loop

// ── Preview offline physics ────────────────────────────────────────────────────
export const PREVIEW_GRAVITY         = 0.52;
export const PREVIEW_JUMP_VEL        = -10.8;
export const PREVIEW_SPEED           = 4.0;
export const PREVIEW_ATTACK_DURATION = 20; // frames to show attack state
