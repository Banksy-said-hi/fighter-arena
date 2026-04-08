import type { PlayerIndex, PlayerStateName, SpriteName } from './types';
import { STATE_TO_SPRITE, MS_PER_FRAME } from './constants';

// sprites[playerIndex][spriteName] = HTMLImageElement[]
// Falls back to rectangle renderer for any state without loaded frames.
const sprites: Record<PlayerIndex, Partial<Record<SpriteName, HTMLImageElement[]>>> = {
  0: {},
  1: {},
};

function loadFrames(charIdx: PlayerIndex, basePath: string, stateName: SpriteName, count: number): void {
  const frames: HTMLImageElement[] = [];
  for (let i = 0; i < count; i++) {
    const img = new Image();
    img.src = `${basePath}/${stateName}_${i}.png`;
    img.onerror = () => console.error(`[sprite] failed to load: ${img.src}`);
    frames.push(img);
  }
  sprites[charIdx][stateName] = frames;
}

// Register char1 sprites — add more states as PNGs are created.
// Both players share char1 for now; swap charIdx 1 to '/assets/char2' later.
loadFrames(0, '/assets/char1', 'idle', 4);
loadFrames(1, '/assets/char1', 'idle', 4);
loadFrames(0, '/assets/char1', 'walk', 5);
loadFrames(1, '/assets/char1', 'walk', 5);
// loadFrames(0, '/assets/char1', 'jump', 3);
// loadFrames(0, '/assets/char1', 'attack_fist', 4);
// loadFrames(0, '/assets/char1', 'attack_leg', 4);
// loadFrames(0, '/assets/char1', 'attack_uppercut', 5);
// loadFrames(0, '/assets/char1', 'blocking', 2);
// loadFrames(0, '/assets/char1', 'dodging', 4);
// loadFrames(0, '/assets/char1', 'hurt', 3);
// loadFrames(0, '/assets/char1', 'ko', 2);

/**
 * Returns the current animation frame for charIdx in state `playerState`,
 * or null if no sprite is loaded (caller falls back to rectangle render).
 */
export function getSpriteFrame(charIdx: PlayerIndex, playerState: PlayerStateName | string): HTMLImageElement | null {
  const charSprites = sprites[charIdx as PlayerIndex] ?? {};

  function tryFrames(name: SpriteName): HTMLImageElement | null {
    const frames = charSprites[name];
    if (!frames || frames.length === 0) return null;
    const frame = frames[Math.floor(Date.now() / MS_PER_FRAME) % frames.length];
    return frame && frame.complete && frame.naturalWidth > 0 ? frame : null;
  }

  // Use the typed map if the state is a known PlayerStateName, else fall back to idle.
  const spriteName: SpriteName = (playerState in STATE_TO_SPRITE)
    ? STATE_TO_SPRITE[playerState as PlayerStateName]
    : 'idle';

  return tryFrames(spriteName) ?? tryFrames('idle');
}
