import { load, save } from './storage';

export const MACROS = ['world', 'weather', 'energy', 'space', 'texture', 'motion', 'color', 'chaos'] as const;
export type MacroKey = (typeof MACROS)[number];
export type Macros = Record<MacroKey, number>;

export const MACRO_INFO: Record<MacroKey, { label: string; lo: string; hi: string }> = {
  world: { label: 'World', lo: 'night', hi: 'daylight' },
  weather: { label: 'Weather', lo: 'clear', hi: 'storm' },
  energy: { label: 'Energy', lo: 'still', hi: 'alive' },
  space: { label: 'Space', lo: 'intimate', hi: 'vast' },
  texture: { label: 'Texture', lo: 'smooth', hi: 'granular' },
  motion: { label: 'Motion', lo: 'slow', hi: 'flowing' },
  color: { label: 'Color', lo: 'midnight', hi: 'amber' },
  chaos: { label: 'Chaos', lo: 'order', hi: 'drift' },
};

export const MACRO_DEFAULTS: Macros = {
  world: 0.24,
  weather: 0.16,
  energy: 0.35,
  space: 0.62,
  texture: 0.25,
  motion: 0.4,
  color: 0.1,
  chaos: 0.25,
};

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The shared emotional state of the world. Knobs, sliders and keyboard write `target`;
 * audio and visuals read `value`, which glides toward the target so every change is a transition.
 */
export class ParameterStore {
  readonly target: Macros;
  readonly value: Macros;
  private listeners = new Set<(key: MacroKey, v: number) => void>();
  private saveTimer = 0;

  constructor() {
    const stored = load<Partial<Macros>>('macros', {});
    this.target = { ...MACRO_DEFAULTS };
    for (const k of MACROS) {
      const v = stored[k];
      if (typeof v === 'number' && Number.isFinite(v)) this.target[k] = clamp01(v);
    }
    this.value = { ...this.target };
  }

  set(key: MacroKey, v: number): void {
    const c = clamp01(v);
    if (this.target[key] === c) return;
    this.target[key] = c;
    for (const fn of this.listeners) fn(key, c);
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => save('macros', this.target), 400);
  }

  onChange(fn: (key: MacroKey, v: number) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  reset(): void {
    for (const k of MACROS) this.set(k, MACRO_DEFAULTS[k]);
  }

  /** Exponential glide toward the target, frame-rate independent. */
  update(dt: number): void {
    // Short enough that a knob feels immediate, long enough to hide the 1-2 step resolution.
    const a = 1 - Math.exp(-dt / 0.12);
    for (const k of MACROS) this.value[k] += (this.target[k] - this.value[k]) * a;
  }
}
