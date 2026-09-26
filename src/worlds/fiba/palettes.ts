import { Color } from 'three';
import { lerp, smooth } from '../../core/derive';

/**
 * FIBA palettes: cosy, low-saturation states of one quiet room.
 * Each defines the colour of the lamp, the light at the window, the air and the echoes.
 * WORLD then sets the hour: lamp-lit night -> blue pre-dawn -> soft early light.
 */
interface Def {
  name: string;
  lamp: string; // the globe lamp on the floor
  moon: string; // night light at the window
  dawn: string; // early light at the window
  air: string; // ambient / fog
  wall: string; // tint of the walls
  accent: string; // light echoes
  accent2: string; // sparkles
}

const DEFS: Def[] = [
  { name: 'Warm Linen', lamp: '#ffb46e', moon: '#9fb0cf', dawn: '#f3dcc0', air: '#3a3430', wall: '#d9d0c4', accent: '#ffcf9a', accent2: '#fff1dc' },
  { name: 'Moon Grey', lamp: '#ffae6a', moon: '#8fa6d6', dawn: '#c9d6ec', air: '#262c38', wall: '#c9ced8', accent: '#b9cdf2', accent2: '#eef3ff' },
  { name: 'Amber', lamp: '#ff9a4a', moon: '#a49ec4', dawn: '#ffd49a', air: '#3a2a20', wall: '#dcc8ae', accent: '#ffb870', accent2: '#ffe7c2' },
  { name: 'Dusty Lilac', lamp: '#ffae80', moon: '#a79cc9', dawn: '#e8cfd9', air: '#302a36', wall: '#d4ccd6', accent: '#e2bfd8', accent2: '#fbeaf4' },
  { name: 'Early Blue', lamp: '#ffc08a', moon: '#8fb2d8', dawn: '#d6e8f6', air: '#243038', wall: '#cdd6dc', accent: '#a9d2f0', accent2: '#eef8ff' },
];

type Key = Exclude<keyof Def, 'name'>;
const KEYS: Key[] = ['lamp', 'moon', 'dawn', 'air', 'wall', 'accent', 'accent2'];
const LIN = DEFS.map((d) => {
  const o = {} as Record<Key, Color>;
  for (const k of KEYS) o[k] = new Color(d[k]);
  return o;
});

export interface FibaLight {
  lamp: Color;
  lampI: number;
  window: Color;
  windowI: number;
  ambient: Color;
  ground: Color;
  fog: Color;
  wall: Color;
  accent: Color;
  accent2: Color;
  exposure: number;
}

export function createLight(): FibaLight {
  return {
    lamp: new Color(), lampI: 1, window: new Color(), windowI: 1, ambient: new Color(), ground: new Color(),
    fog: new Color(), wall: new Color(), accent: new Color(), accent2: new Color(), exposure: 1,
  };
}

const tmp = new Color();

/** COLOR picks the palette, WORLD the hour. */
export function sampleLight(color: number, world: number, out: FibaLight): FibaLight {
  const x = color * (LIN.length - 1);
  const i = Math.min(LIN.length - 2, Math.floor(x));
  const t = smooth(0, 1, x - i);
  const P = {} as Record<Key, Color>;
  for (const k of KEYS) P[k] = tmp.copy(LIN[i][k]).lerp(LIN[i + 1][k], t).clone();

  const dawn = smooth(0.25, 0.75, world); // pre-dawn blue arrives
  const day = smooth(0.6, 1, world); // soft early light
  out.lamp.copy(P.lamp);
  out.lampI = lerp(1.6, 0.35, smooth(0.3, 1, world));
  // window: moonlight -> blue hour -> pale warm morning
  out.window.copy(P.moon).lerp(new Color(0.32, 0.38, 0.62), dawn * (1 - day)).lerp(P.dawn, day);
  out.windowI = lerp(0.55, 1.6, smooth(0.15, 1, world));
  out.ambient.copy(P.air).multiplyScalar(lerp(0.5, 1.8, smooth(0.35, 1, world))).lerp(out.window, 0.25);
  out.ground.copy(P.air).multiplyScalar(lerp(0.35, 1.1, world)).lerp(P.lamp, 0.12 * out.lampI);
  out.fog.copy(P.air).multiplyScalar(lerp(0.25, 1.4, smooth(0.3, 1, world)));
  out.wall.copy(P.wall);
  out.accent.copy(P.accent);
  out.accent2.copy(P.accent2);
  out.exposure = lerp(1.0, 0.95, world);
  return out;
}

export function paletteName(color: number): string {
  return DEFS[Math.round(color * (DEFS.length - 1))].name;
}
