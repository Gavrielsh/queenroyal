/**
 * UI sound effects, synthesized with the Web Audio API — no audio files to ship or load.
 *
 * Sounds only ever play in response to something the player did (a click that starts a spin,
 * a purchase), which is also what browsers require before an AudioContext may start. Every
 * entry point is a silent no-op when Web Audio is unavailable (SSR, jsdom, old browsers) or
 * the player muted sound, so callers never need to guard.
 *
 * The mute preference is per browser (localStorage). It is a convenience, not state anyone
 * else depends on, so a storage failure simply falls back to "sound on".
 */

export type SoundName =
  | "click"
  | "spin"
  | "reelStop"
  | "win"
  | "bigWin"
  | "tier"
  | "purchase"
  | "tick"
  | "coin"
  | "creak"
  | "open"
  | "levelUp";

const STORAGE_KEY = "qr-sound-muted";

let muted = readMuted();
let context: AudioContext | null = null;
const listeners = new Set<() => void>();

function readMuted(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!context) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      context = new Ctor();
    } catch {
      return null;
    }
  }
  if (context.state === "suspended") void context.resume().catch(() => undefined);
  return context;
}

/** One enveloped oscillator note. `at` and `duration` are seconds from now. */
function tone(
  ctx: AudioContext,
  frequency: number,
  at: number,
  duration: number,
  type: OscillatorType,
  volume: number,
  glideTo?: number,
): void {
  const start = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, start);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, start + duration);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.03);
}

function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Vibration is a nicety; unsupported or blocked is fine.
  }
}

const ARPEGGIO = [523, 659, 784, 1046] as const;
const FANFARE = [392, 523, 659, 784, 1046, 1318] as const;

const RECIPES: Readonly<Record<SoundName, (ctx: AudioContext) => void>> = {
  click: (ctx) => tone(ctx, 700, 0, 0.06, "sine", 0.1),
  spin: (ctx) => tone(ctx, 330, 0, 0.35, "triangle", 0.08, 990),
  reelStop: (ctx) => {
    tone(ctx, 170, 0, 0.1, "sine", 0.22, 90);
    vibrate(8);
  },
  win: (ctx) => ARPEGGIO.forEach((f, i) => tone(ctx, f, i * 0.08, 0.28, "triangle", 0.14)),
  bigWin: (ctx) => {
    FANFARE.forEach((f, i) => {
      tone(ctx, f, i * 0.07, 0.4, "sawtooth", 0.05);
      tone(ctx, f, i * 0.07, 0.4, "triangle", 0.12);
    });
    vibrate([30, 40, 30]);
  },
  tier: (ctx) => {
    tone(ctx, 784, 0, 0.12, "square", 0.06);
    tone(ctx, 1175, 0.09, 0.35, "triangle", 0.14);
  },
  tick: (ctx) => {
    tone(ctx, 2000, 0, 0.02, "square", 0.035);
    vibrate(6);
  },
  coin: (ctx) => {
    tone(ctx, 1480, 0, 0.08, "triangle", 0.09);
    tone(ctx, 2220, 0.035, 0.12, "triangle", 0.06);
  },
  creak: (ctx) => tone(ctx, 150, 0, 0.45, "sawtooth", 0.04, 70),
  open: (ctx) => {
    tone(ctx, 220, 0, 0.2, "sine", 0.18, 700);
    [1046, 1318, 1568, 2093].forEach((f, i) => tone(ctx, f, 0.2 + i * 0.07, 0.35, "triangle", 0.09));
  },
  levelUp: (ctx) => {
    [523, 659, 784, 1046, 1318, 1568, 2093].forEach((f, i) => tone(ctx, f, i * 0.07, 0.45, "triangle", 0.11));
    tone(ctx, 2093, 0.55, 1.3, "sine", 0.07);
    vibrate([20, 30, 20, 30, 60]);
  },
  purchase: (ctx) => {
    [0, 1, 2].forEach((i) => {
      tone(ctx, 1480, i * 0.06, 0.08, "triangle", 0.09);
      tone(ctx, 2220, i * 0.06 + 0.035, 0.12, "triangle", 0.06);
    });
  },
};

/** Play a sound effect. Safe to call anywhere; silent when muted or unsupported. */
export function playSound(name: SoundName): void {
  if (muted) return;
  const ctx = audio();
  if (!ctx) return;
  try {
    RECIPES[name](ctx);
  } catch {
    // A failed effect must never break the interaction that triggered it.
  }
}

export function isSoundMuted(): boolean {
  return muted;
}

export function setSoundMuted(next: boolean): void {
  muted = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    // Storage blocked: the preference lasts for this page view only.
  }
  listeners.forEach((listener) => listener());
}

/** useSyncExternalStore-compatible subscription to the mute preference. */
export function subscribeSound(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
