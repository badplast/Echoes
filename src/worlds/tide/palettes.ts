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
  { name: 'Midnight Blue', zenith: '#0a1633', horizon: '#46618f', sun: '#c4d8ff', fog: '#26395a', water: '#050c1a', accent: '#6f9dff', accent2: '#cfe2ff' },
  { name: 'Deep Teal', zenith: '#052226', horizon: '#3d8583', sun: '#dcfff3', fog: '#1d4c4d', water: '#021416', accent: '#3fd6bd', accent2: '#c2fff1' },
  { name: 'Violet Mist', zenith: '#140c2c', horizon: '#76659f', sun: '#f3dcff', fog: '#3d315f', water: '#0a0716', accent: '#a483ff', accent2: '#f3d0ff' },
  { name: 'Cold Cyan', zenith: '#071d30', horizon: '#6cb8d0', sun: '#eeffff', fog: '#2c6a84', water: '#03121d', accent: '#63dcff', accent2: '#e2fbff' },
  { name: 'Warm Dawn', zenith: '#191833', horizon: '#e39a73', sun: '#ffd9ac', fog: '#5b4556', water: '#0d0a14', accent: '#ffa878', accent2: '#ffe6c4' },
  { name: 'Pale Rose', zenith: '#241629', horizon: '#dba7ad', sun: '#ffe8e6', fog: '#6a5060', water: '#110a12', accent: '#ff9bb3', accent2: '#ffe3ec' },
  { name: 'Amber Horizon', zenith: '#171006', horizon: '#dc8e3e', sun: '#ffd48f', fog: '#57391f', water: '#0a0703', accent: '#ffae4a', accent2: '#ffe9b8' },
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
    if (key === 'zenith') tmpB.lerp(tmpA.setRGB(0.07, 0.16, 0.34), 0.45);
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
