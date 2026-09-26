import { Color } from 'three';
import { smooth } from '../../core/derive';

/**
 * Hand-picked palettes, authored at their "dawn" state (WORLD = 0.5).
 * Night and daylight are derived from them, so COLOR picks the identity and WORLD the hour.
 * Order must match WARMTH in core/derive.ts.
 */
interface PaletteDef {
  name: string;
  zenith: string;
  horizon: string;
  sun: string;
  fog: string;
  water: string;
  accent: string; // low notes
  accent2: string; // high notes
}

const DEFS: PaletteDef[] = [
  // One natural axis, cold -> warm: the sky over the Sea of Japan from blue hour to the last ember.
  // Zeniths stay a muted blue in all of them; horizon, light and water carry the change.
  { name: 'Blue Hour', zenith: '#0e1d3a', horizon: '#5b7ea6', sun: '#d4e2ff', fog: '#3a5172', water: '#07111e', accent: '#80b0f5', accent2: '#d6e6ff' },
  { name: 'Steel', zenith: '#26313f', horizon: '#98a4ae', sun: '#eef0ea', fog: '#66727d', water: '#101820', accent: '#a8c2d8', accent2: '#eef3f7' },
  { name: 'Pearl', zenith: '#262b42', horizon: '#c4b6ae', sun: '#fff0dc', fog: '#766f7a', water: '#12121a', accent: '#d6c2b2', accent2: '#fff1e4' },
  { name: 'Sunset', zenith: '#212747', horizon: '#e39a5e', sun: '#ffd29a', fog: '#80604f', water: '#130f13', accent: '#ffb072', accent2: '#ffe2bd' },
  { name: 'Ember', zenith: '#1a1a33', horizon: '#d35a3c', sun: '#ffb070', fog: '#673a31', water: '#0e0a0c', accent: '#ff8c56', accent2: '#ffd2a4' },
];

export const PALETTE_NAMES = DEFS.map((d) => d.name);

type Key = Exclude<keyof PaletteDef, 'name'>;
const KEYS: Key[] = ['zenith', 'horizon', 'sun', 'fog', 'water', 'accent', 'accent2'];

// Pre-converted to linear working space once.
const LINEAR = DEFS.map((d) => {
  const o = {} as Record<Key, Color>;
  for (const k of KEYS) o[k] = new Color(d[k]);
  return o;
});

export type Palette = Record<Key, Color>;

export function createPalette(): Palette {
  const o = {} as Palette;
  for (const k of KEYS) o[k] = new Color();
  return o;
}

const tmpA = new Color();
const tmpB = new Color();
const mixed = new Color();
const NIGHT_TINT = new Color(0.34, 0.45, 0.85);
const DAY_WASH = new Color(0.92, 0.95, 1.0);

function luma(c: Color): number {
  return c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
}

/** Night: desaturated toward moonlit blue and very dark. Day: washed, brighter, airy. */
function timeOfDay(c: Color, key: Key, world: number, out: Color): Color {
  const night = 1 - smooth(0.0, 0.5, world);
  const day = smooth(0.5, 1.0, world);
  out.copy(c);
  if (night > 0) {
    tmpA.copy(NIGHT_TINT).multiplyScalar(luma(c) * 1.6);
    const dark = key === 'sun' ? 0.55 : key === 'accent' || key === 'accent2' ? 0.8 : 0.1;
    tmpA.lerp(c, key === 'sun' ? 0.25 : 0.4).multiplyScalar(dark);
    out.lerp(tmpA, night);
  }
  if (day > 0) {
    const wash = key === 'water' ? 0.08 : key === 'zenith' ? 0.12 : key === 'accent' || key === 'accent2' ? 0.1 : 0.22;
    const gain = key === 'water' ? 1.9 : key === 'zenith' ? 2.4 : key === 'sun' ? 1.0 : key === 'fog' ? 1.15 : 0.95;
    tmpB.copy(c).lerp(DAY_WASH, wash).multiplyScalar(gain);
    // a clear day is blue overhead and pale blue at the horizon, whatever the palette's accent
    if (key === 'zenith') tmpB.lerp(tmpA.setRGB(0.07, 0.19, 0.46), 0.72);
    if (key === 'horizon') tmpB.lerp(tmpA.setRGB(0.5, 0.62, 0.78), 0.4);
    if (key === 'fog') tmpB.lerp(tmpA.setRGB(0.42, 0.52, 0.64), 0.45);
    if (key === 'water') tmpB.lerp(tmpA.setRGB(0.03, 0.07, 0.12), 0.5);
    out.lerp(tmpB, day);
  }
  return out;
}

export function samplePalette(color: number, world: number, out: Palette): Palette {
  const x = color * (LINEAR.length - 1);
  const i = Math.min(LINEAR.length - 2, Math.floor(x));
  const t = smooth(0, 1, x - i);
  for (const k of KEYS) {
    mixed.copy(LINEAR[i][k]).lerp(LINEAR[i + 1][k], t);
    timeOfDay(mixed, k, world, out[k]);
  }
  return out;
}

export function paletteName(color: number): string {
  return DEFS[Math.round(color * (DEFS.length - 1))].name;
}
