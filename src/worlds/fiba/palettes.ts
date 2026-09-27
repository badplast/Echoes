import { Color } from 'three';
import { lerp, smooth } from '../../core/derive';

/**
 * FIBA palettes colour the DREAM around her — backdrop, air, mist, the rim of light behind her,
 * the dream motes — never her fur and never the lamp (a lamp is a lamp).
 * COLOR walks through five tasteful states; HOUR (WORLD) sets how deep the night is.
 */
interface Def {
  name: string;
  deep: string; // darkest backdrop tone
  room: string; // mid backdrop tone (the wall in the dark)
  glow: string; // window / moon glow in the backdrop
  mist: string; // dream mist
  rim: string; // back light on Fiba and the chair
  dream: string; // dream motes, low notes
  dream2: string; // dream motes, high notes
}

const DEFS: Def[] = [
  { name: 'Moon Linen', deep: '#0d0c10', room: '#2b2622', glow: '#c9cfe0', mist: '#8f877e', rim: '#b8b2c8', dream: '#ffd9a8', dream2: '#fff4e2' },
  { name: 'Moonlit Blue', deep: '#070a12', room: '#18223a', glow: '#9fb8ec', mist: '#5e7196', rim: '#8fb0f0', dream: '#b8d0ff', dream2: '#eef4ff' },
  { name: 'Dusty Blue', deep: '#0b0e12', room: '#27313b', glow: '#bcd2de', mist: '#7f94a2', rim: '#a9c4d4', dream: '#cfe6ee', dream2: '#f4fbff' },
  { name: 'Lilac Dream', deep: '#0e0a12', room: '#2e2334', glow: '#d6c0e6', mist: '#8e7c9c', rim: '#c9aee0', dream: '#f0c6e4', dream2: '#fff0fa' },
  { name: 'Amber Night', deep: '#100a06', room: '#33231a', glow: '#f0c89a', mist: '#9a7a5c', rim: '#e8b884', dream: '#ffc27a', dream2: '#fff0d2' },
];

type Key = Exclude<keyof Def, 'name'>;
const KEYS: Key[] = ['deep', 'room', 'glow', 'mist', 'rim', 'dream', 'dream2'];
const LIN = DEFS.map((d) => {
  const o = {} as Record<Key, Color>;
  for (const k of KEYS) o[k] = new Color(d[k]);
  return o;
});

export type DreamPalette = Record<Key, Color> & { bright: number };

export function createPalette(): DreamPalette {
  const o = { bright: 1 } as DreamPalette;
  for (const k of KEYS) o[k] = new Color();
  return o;
}

const DAWN = new Color('#b9c6dc');

export function samplePalette(color: number, hour: number, out: DreamPalette): DreamPalette {
  const x = color * (LIN.length - 1);
  const i = Math.min(LIN.length - 2, Math.floor(x));
  const t = smooth(0, 1, x - i);
  const dawn = smooth(0.45, 1, hour);
  for (const k of KEYS) {
    out[k].copy(LIN[i][k]).lerp(LIN[i + 1][k], t);
    // first light washes the dream toward a pale, cool morning
    if (k === 'room' || k === 'deep' || k === 'mist') out[k].lerp(DAWN, dawn * (k === 'deep' ? 0.25 : 0.45));
  }
  out.bright = lerp(0.75, 2.4, smooth(0.2, 1, hour));
  return out;
}

export function paletteName(color: number): string {
  return DEFS[Math.round(color * (DEFS.length - 1))].name;
}
