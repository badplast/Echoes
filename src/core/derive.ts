import type { Macros } from './ParameterStore';

/**
 * Derived quantities that BOTH the audio engine and the world read, so that sound and image
 * agree by construction (e.g. the delay echo time is also the interval of visual echo ripples).
 */

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Musical/visual time multiplier driven by MOTION. */
export function timeScale(m: Macros): number {
  return lerp(0.22, 1.9, Math.pow(m.motion, 1.25));
}

/** Delay line time (seconds). Visual echo ripples use the same spacing. */
export function echoTime(m: Macros): number {
  return lerp(0.95, 0.42, m.motion) * lerp(0.85, 1.25, m.space);
}

/** Delay feedback 0..1. Visual echo ripples decay by the same factor. */
export function echoFeedback(m: Macros): number {
  return lerp(0.16, 0.52, m.space) * lerp(1, 0.8, m.weather);
}

/** Warmth of the current colour palette, 0 cold .. 1 warm. Mirrors the palette order in TIDE. */
const WARMTH = [0.05, 0.25, 0.5, 0.78, 1.0];
export function warmth(m: Macros): number {
  const x = m.color * (WARMTH.length - 1);
  const i = Math.min(WARMTH.length - 2, Math.floor(x));
  return lerp(WARMTH[i], WARMTH[i + 1], smooth(0, 1, x - i));
}

/** Mean seconds between autonomous generative events (musical echoes + drips). */
export function eventInterval(m: Macros): number {
  return lerp(18, 1.1, Math.pow(m.energy, 0.75)) / lerp(0.8, 1.4, m.motion);
}

/** Rain 0..1: WEATHER brings it in with the storm, fader 2 can add it on any sky. */
export function rainLevel(m: Macros): number {
  return Math.max(smooth(0.4, 0.95, m.weather), m.rain);
}

/**
 * Fog 0..1 (0.5 ≈ the v0.1 look). Fader 3 sets the base, WEATHER thickens it,
 * and high WORLD (clear daylight) thins it: a sunny day should read as clean air.
 */
export function fogLevel(m: Macros): number {
  const dayClear = lerp(1, 0.3, smooth(0.55, 1, m.world));
  return Math.min(1, (m.fog * (0.75 + m.weather * 0.9)) * dayClear + m.weather * 0.15);
}

/** Normalized pitch for spatial mapping, 0 = low, 1 = high. */
export function pitchNorm(note: number): number {
  return Math.min(1, Math.max(0, (note - 28) / (100 - 28)));
}
