import type { BeepOptions, SoundName } from './types';

let audioCtx: AudioContext | null = null;

function ac(): AudioContext {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  }
  return audioCtx;
}

function beep({
  type = 'square',
  freq = 300,
  endFreq,
  duration = 0.1,
  volume = 0.25,
  delay = 0,
}: BeepOptions = {}): void {
  try {
    const a    = ac();
    const osc  = a.createOscillator();
    const gain = a.createGain();
    osc.connect(gain);
    gain.connect(a.destination);
    osc.type = type;
    const t = a.currentTime + delay;
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(endFreq, t + duration);
    }
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.start(t);
    osc.stop(t + duration + 0.01);
  } catch (_) {
    // Audio context may be blocked until user interaction — silent fail.
  }
}

export function playSound(name: SoundName): void {
  switch (name) {
    case 'fist':
      beep({ type: 'square',   freq: 220, endFreq: 80,  duration: 0.10 }); break;
    case 'leg':
      beep({ type: 'sawtooth', freq: 160, endFreq: 55,  duration: 0.14 }); break;
    case 'uppercut':
      beep({ type: 'square', freq: 110, endFreq: 380, duration: 0.06 });
      beep({ type: 'square', freq: 380, endFreq: 50,  duration: 0.18, delay: 0.06 });
      break;
    case 'hit':
      beep({ type: 'square',   freq: 350, endFreq: 90,  duration: 0.08, volume: 0.45 }); break;
    case 'block':
      beep({ type: 'triangle', freq: 600, endFreq: 400, duration: 0.07, volume: 0.2 }); break;
    case 'ko':
      beep({ type: 'sawtooth', freq: 440, endFreq: 55,  duration: 0.55, volume: 0.6 }); break;
    case 'countdown':
      beep({ type: 'sine',     freq: 440,                duration: 0.18, volume: 0.3 }); break;
    case 'fight':
      ([440, 550, 660] as const).forEach((f, i) =>
        beep({ type: 'sine', freq: f, duration: 0.2, volume: 0.3, delay: i * 0.11 })
      );
      break;
    case 'jump':
      beep({ type: 'sine', freq: 300, endFreq: 500, duration: 0.12, volume: 0.15 }); break;
  }
}
