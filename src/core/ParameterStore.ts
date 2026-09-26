import { load, save } from './storage';

/** The eight emotional macros of the world (encoders 1–8). */
export const MACROS = ['world', 'weather', 'energy', 'space', 'texture', 'motion', 'color', 'chaos'] as const;
/** Four mix levels (faders 1–4): how much of each layer of the place you hear and see. */
export const FADERS = ['atmos', 'rain', 'fog', 'drone'] as const;
export const PARAMS = [...MACROS, ...FADERS] as const;

export type MacroKey = (typeof MACROS)[number];
export type FaderKey = (typeof FADERS)[number];
export type ParamKey = (typeof PARAMS)[number];
/** Every shared parameter, 0..1. Audio and world read the same object. */
export type Macros = Record<ParamKey, number>;

export const PARAM_INFO: Record<ParamKey, { label: string; lo: string; hi: string }> = {
  world: { label: 'World', lo: 'night', hi: 'daylight' },
  weather: { label: 'Weather', lo: 'clear', hi: 'storm' },
  energy: { label: 'Energy', lo: 'still', hi: 'storm-alive' },
  space: { label: 'Space', lo: 'intimate', hi: 'vast' },
  texture: { label: 'Texture', lo: 'smooth', hi: 'granular' },
  motion: { label: 'Motion', lo: 'slow', hi: 'flowing' },
  color: { label: 'Color', lo: 'blue hour', hi: 'ember' },
  chaos: { label: 'Chaos', lo: 'order', hi: 'drift' },
  atmos: { label: 'Atmosphere', lo: 'bare', hi: 'immersive' },
  rain: { label: 'Rain', lo: 'dry', hi: 'downpour' },
  fog: { label: 'Fog', lo: 'clear air', hi: 'sea fog' },
  drone: { label: 'Drone', lo: 'silent', hi: 'deep' },
};
/** Back-compat alias used by the UI for the eight macros. */
export const MACRO_INFO = PARAM_INFO;

export const MACRO_DEFAULTS: Macros = {
  world: 0.24,
  weather: 0.16,
  energy: 0.35,
  space: 0.62,
  texture: 0.25,
  motion: 0.4,
  color: 0.14,
  chaos: 0.25,
  // Fader neutral points reproduce the v0.1 balance.
  atmos: 0.7,
  rain: 0,
  fog: 0.5,
  drone: 0.6,
};

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The shared emotional state of the world. Knobs, faders, sliders and keyboard write `target`;
 * audio and visuals read `value`, which glides toward the target so every change is a transition.
 */
export class ParameterStore {
  readonly target: Macros;
  readonly value: Macros;
  private listeners = new Set<(key: ParamKey, v: number) => void>();
  private saveTimer = 0;

  constructor() {
    const stored = load<Partial<Macros>>('macros', {});
    this.target = { ...MACRO_DEFAULTS };
    for (const k of PARAMS) {
      const v = stored[k];
      if (typeof v === 'number' && Number.isFinite(v)) this.target[k] = clamp01(v);
    }
    this.value = { ...this.target };
  }

  set(key: ParamKey, v: number): void {
    const c = clamp01(v);
    if (this.target[key] === c) return;
    this.target[key] = c;
    for (const fn of this.listeners) fn(key, c);
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => save('macros', this.target), 400);
  }

  onChange(fn: (key: ParamKey, v: number) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  reset(): void {
    for (const k of PARAMS) this.set(k, MACRO_DEFAULTS[k]);
  }

  /** Exponential glide toward the target, frame-rate independent. */
  update(dt: number): void {
    // Short enough that a knob feels immediate, long enough to hide the 1-2 step resolution.
    const a = 1 - Math.exp(-dt / 0.12);
    for (const k of PARAMS) this.value[k] += (this.target[k] - this.value[k]) * a;
  }
}
