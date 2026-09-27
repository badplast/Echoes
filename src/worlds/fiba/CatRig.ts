import { Matrix3, Matrix4, Vector3, Vector4 } from 'three';
import { bus, type PadGesture } from '../../core/events';
import type { Macros } from '../../core/ParameterStore';
import { lerp, smooth } from '../../core/derive';
import { LIMBS, PARTS, TAIL } from './catShader';

type V3 = [number, number, number];
interface Part {
  c: V3;
  yaw: number;
  r: V3;
  k: number;
}

// Local space: seat top at y = 0, +x toward her head, +z toward the viewer.
// Torso: 0 hips · 1 middle · 2 chest · 3 shoulder · 4 near haunch · 5 neck · 6 far haunch · 7 belly
// IMG_9390: rib cage curls behind a distinct forward thigh. The chest
// rests between the elbows; the head is supported by the far wrist and cushion.
const CURL_A: Part[] = [
  { c: [-0.110, 0.081, -0.017], yaw: 0.18, r: [0.095, 0.079, 0.086], k: 0.022 },
  { c: [-0.022, 0.077, -0.048], yaw: -0.2, r: [0.093, 0.069, 0.073], k: 0.024 },
  { c: [0.071, 0.067, -0.010], yaw: -0.5, r: [0.069, 0.062, 0.064], k: 0.020 },
  { c: [0.084, 0.071, 0.032], yaw: 0.2, r: [0.046, 0.046, 0.046], k: 0.017 },
  { c: [-0.112, 0.067, 0.068], yaw: -0.4, r: [0.069, 0.062, 0.059], k: 0.008 },
  { c: [0.116, 0.063, 0.074], yaw: -0.2, r: [0.039, 0.039, 0.039], k: 0.014 },
  { c: [-0.12, 0.070, -0.075], yaw: 0, r: [0, 0, 0], k: 0.014 },
  { c: [-0.009, 0.036, 0.026], yaw: 0.2, r: [0.083, 0.032, 0.048], k: 0.018 },
];
// A second, slightly tighter curl: hips tucked, neck lower. Used when she resettles.
const CURL_B: Part[] = CURL_A.map((p, i) => {
  const q: Part = { c: [...p.c], yaw: p.yaw, r: [...p.r], k: p.k };
  if (i === 0) q.c = [-0.100, 0.080, -0.021];
  if (i === 5) q.c = [0.114, 0.061, 0.079];
  return q;
});
/**
 * The stretch is two poses played in sequence, like a real cat:
 * REACH — the bow: head forward, shoulders and forelegs slide far forward, chest low, hips still up;
 * EXTEND — the hind half follows: spine long, hind legs pushed back, tail streaming behind.
 * Radii stay close to the curl: joints move, nothing is stretched like clay.
 */
const REACH: Part[] = [
  { c: [-0.1, 0.13, -0.015], yaw: 0.1, r: [0.106, 0.083, 0.094], k: 0.025 },
  { c: [-0.005, 0.1, -0.015], yaw: 0, r: [0.102, 0.077, 0.084], k: 0.025 },
  { c: [0.1, 0.058, -0.005], yaw: 0, r: [0.084, 0.062, 0.074], k: 0.021 },
  { c: [0.14, 0.05, 0.0], yaw: 0, r: [0.056, 0.047, 0.056], k: 0.016 },
  { c: [-0.105, 0.11, 0.045], yaw: 0.2, r: [0.064, 0.054, 0.052], k: 0.016 },
  { c: [0.18, 0.055, 0.0], yaw: 0, r: [0.042, 0.041, 0.043], k: 0.016 },
  { c: [-0.105, 0.11, -0.045], yaw: 0.2, r: [0.064, 0.054, 0.052], k: 0.016 },
  { c: [0.02, 0.058, 0.0], yaw: 0, r: [0.068, 0.038, 0.058], k: 0.019 },
];
const EXTEND: Part[] = [
  { c: [-0.16, 0.088, -0.005], yaw: 0, r: [0.108, 0.082, 0.094], k: 0.025 },
  { c: [-0.04, 0.086, -0.005], yaw: 0, r: [0.104, 0.064, 0.070], k: 0.025 },
  { c: [0.075, 0.074, 0.0], yaw: 0, r: [0.078, 0.059, 0.066], k: 0.021 },
  { c: [0.12, 0.074, 0.0], yaw: 0, r: [0.056, 0.048, 0.055], k: 0.016 },
  { c: [-0.17, 0.068, 0.05], yaw: 0, r: [0.066, 0.054, 0.052], k: 0.016 },
  { c: [0.165, 0.08, 0.0], yaw: 0, r: [0.042, 0.041, 0.043], k: 0.016 },
  { c: [-0.17, 0.068, -0.05], yaw: 0, r: [0.066, 0.054, 0.052], k: 0.016 },
  { c: [-0.03, 0.046, 0.0], yaw: 0, r: [0.07, 0.032, 0.052], k: 0.019 },
];
/** How much each torso part belongs to the front of the body (leads the REACH). */
const FRONTNESS = [0.1, 0.45, 0.85, 1, 0.1, 1, 0.1, 0.5];

/** A leg: upper end, elbow/knee, paw; each point with its radius. */
interface Leg {
  a: [number, number, number, number];
  m: [number, number, number, number];
  b: [number, number, number, number];
}
// 0 near foreleg · 1 far foreleg · 2 near hind leg · 3 far hind leg
const LEGS_CURL: Leg[] = [
  { a: [0.069, 0.065, 0.041, 0.025], m: [0.037, 0.031, 0.092, 0.019], b: [0.097, 0.017, 0.139, 0.018] },
  { a: [0.104, 0.063, -0.013, 0.023], m: [0.142, 0.030, 0.030, 0.017], b: [0.171, 0.016, 0.087, 0.016] },
  { a: [-0.109, 0.054, 0.051, 0.024], m: [-0.060, 0.024, 0.058, 0.018], b: [-0.015, 0.014, 0.043, 0.015] },
  { a: [-0.12, 0.06, -0.08, 0], m: [-0.14, 0.03, -0.06, 0], b: [-0.12, 0.018, -0.02, 0] },
];
const LEGS_REACH: Leg[] = [
  { a: [0.14, 0.055, 0.035, 0.021], m: [0.23, 0.028, 0.04, 0.017], b: [0.31, 0.014, 0.042, 0.0135] },
  { a: [0.14, 0.055, -0.035, 0.02], m: [0.225, 0.028, -0.04, 0.016], b: [0.3, 0.014, -0.042, 0.013] },
  // hind legs standing: the hips stay high while the chest sinks toward the seat (the bow)
  { a: [-0.1, 0.1, 0.058, 0.026], m: [-0.14, 0.052, 0.066, 0.016], b: [-0.09, 0.014, 0.07, 0.0135] },
  { a: [-0.1, 0.1, -0.058, 0.026], m: [-0.14, 0.052, -0.066, 0.016], b: [-0.09, 0.014, -0.07, 0.0135] },
];
const LEGS_EXTEND: Leg[] = [
  { a: [0.12, 0.062, 0.035, 0.021], m: [0.2, 0.03, 0.04, 0.017], b: [0.28, 0.014, 0.042, 0.0135] },
  { a: [0.12, 0.062, -0.035, 0.02], m: [0.195, 0.03, -0.04, 0.016], b: [0.27, 0.014, -0.042, 0.013] },
  { a: [-0.17, 0.058, 0.055, 0.026], m: [-0.23, 0.03, 0.06, 0.016], b: [-0.29, 0.014, 0.062, 0.0135] },
  { a: [-0.17, 0.058, -0.055, 0.026], m: [-0.23, 0.03, -0.06, 0.016], b: [-0.29, 0.014, -0.062, 0.0135] },
];

interface HeadPose {
  pos: V3;
  yaw: number;
  pitch: number;
  roll: number;
}
const HEAD_CURL_A: HeadPose = { pos: [0.141, 0.061, 0.109], yaw: -0.22, pitch: 0.18, roll: 0.34 };
const HEAD_CURL_B: HeadPose = { pos: [0.138, 0.060, 0.112], yaw: -0.18, pitch: 0.20, roll: 0.38 };
const HEAD_UP: HeadPose = { pos: [0.145, 0.131, 0.085], yaw: 0.30, pitch: -0.05, roll: 0.03 };
const HEAD_REACH: HeadPose = { pos: [0.225, 0.078, 0.0], yaw: 0.2, pitch: -0.35, roll: 0.0 };
const HEAD_EXTEND: HeadPose = { pos: [0.2, 0.1, 0.0], yaw: 0.3, pitch: -0.1, roll: 0.05 };

type Action = { kind: 'stir' | 'wake' | 'stretch' | 'settle'; t: number; dur: number } | null;

const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
/** 0 -> 1 -> 0 over an action, with rise/fall portions of the duration. */
const envelope = (t: number, rise: number, fall: number) => ease(t / rise) * (1 - ease((t - (1 - fall)) / fall));

/**
 * Fiba's body and her quiet mind. The mind keeps an "arousal" level that music raises and time
 * lets down; almost everything she does is rare and slow, and she always goes back to sleep.
 */
export class CatRig {
  readonly part = Array.from({ length: PARTS }, () => new Vector4());
  readonly partR = Array.from({ length: PARTS }, () => new Vector4());
  readonly tail = Array.from({ length: TAIL }, () => new Vector4());
  readonly limbA = Array.from({ length: LIMBS }, () => new Vector4());
  readonly limbM = Array.from({ length: LIMBS }, () => new Vector4());
  readonly limbB = Array.from({ length: LIMBS }, () => new Vector4());
  private rotX = new Matrix4();
  private rotZ = new Matrix4();
  readonly headPos = new Vector3();
  readonly headRot = new Matrix3();
  readonly ears = new Vector4();
  readonly eyes = new Vector4(0, 0, 0.6, 0);
  /** 0..1 — for the shader and the world (max of the two stretch phases) */
  stretch = 0;
  private reach = 0;
  private extend = 0;

  /** 0 asleep .. 1 fully roused */
  arousal = 0;
  private action: Action = null;
  private time = 0;
  private breathPhase = 0;
  private variant = 0; // 0 = curl A, 1 = curl B
  private variantTarget = 0;
  private headUp = 0;
  private eyeOpen = 0;
  private eyePeek = 0;
  private look = 0;
  private earL = 0;
  private earR = 0;
  private earBack = 0;
  private tailFlick = 0;
  private tailPhase = 0;
  private pawTwitch = 0;
  private purr = 0;
  private nextEar = 6;
  private nextTwitch = 40;
  private nextSettle = 150;
  private nextStretch = 260;
  private lastWake = -99;
  private lastStretch = -999;
  private m: Macros | null = null;
  private mat4 = new Matrix4();

  // ------------------------------------------------------------------ inputs

  onNote(pn: number, vel: number, played: boolean): void {
    const m = this.m;
    const sens = m ? lerp(0.35, 1.6, m.energy) : 1;
    // Soft notes barely reach her; strong accents do.
    this.arousal = Math.min(1, this.arousal + Math.pow(vel, 2.2) * 0.07 * sens * (played ? 1 : 0.3));
    if (pn > 0.62 && Math.random() < 0.3 * vel) this.flickEar(Math.random() < 0.5 ? 'L' : 'R');
    if (pn < 0.38 && Math.random() < 0.35 * vel) this.tailFlick = Math.min(1, this.tailFlick + 0.6 * vel);
    if (vel > 0.88 && played && Math.random() < 0.5) this.flickEar('both');
  }

  onPad(g: PadGesture, vel: number): void {
    if (g === 'wake') this.start('wake', lerp(4.5, 7, Math.random()), true);
    else if (g === 'stretch') this.start('stretch', 7.5, true);
    else if (g === 'purr') this.purr = Math.min(1, this.purr + 0.6 + vel * 0.4);
    else if (g === 'dust') this.flickEar(Math.random() < 0.5 ? 'L' : 'R');
    else if (g === 'lift') this.eyePeek = Math.max(this.eyePeek, 0.3);
  }

  private flickEar(which: 'L' | 'R' | 'both'): void {
    if (which !== 'R') this.earL = 1;
    if (which !== 'L') this.earR = 1;
  }

  private start(kind: 'stir' | 'wake' | 'stretch' | 'settle', dur: number, force = false): void {
    if (this.action && !force) return;
    if (this.action?.kind === 'stretch') return; // never cut a stretch short
    this.action = { kind, t: 0, dur };
    if (kind === 'wake') this.lastWake = this.time;
    if (kind === 'stretch') this.lastStretch = this.time;
    if (kind !== 'stir') bus.emit('cat:move', { kind, strength: kind === 'stretch' ? 1 : 0.6 });
  }

  // ------------------------------------------------------------------ mind

  update(dt: number, m: Macros, ts: number): void {
    this.m = m;
    this.time += dt;
    const t = this.time;
    const chaos = m.chaos;

    this.arousal = Math.max(0, this.arousal - dt * lerp(0.06, 0.035, m.energy));
    this.purr = Math.max(0, this.purr - dt * 0.08);

    // spontaneous life, rare
    if (t > this.nextEar) {
      this.flickEar(Math.random() < 0.4 ? 'both' : Math.random() < 0.5 ? 'L' : 'R');
      this.nextEar = t + lerp(22, 7, chaos) * (0.5 + Math.random());
    }
    if (t > this.nextTwitch) {
      this.pawTwitch = 1; // dreaming
      this.nextTwitch = t + lerp(70, 25, chaos) * (0.6 + Math.random() * 0.8);
    }
    if (!this.action) {
      if (this.arousal > 0.72 && t - this.lastWake > 25) {
        if (this.arousal > 0.9 && t - this.lastStretch > 80) this.start('stretch', 7.5);
        else this.start('wake', lerp(4, 7, Math.random()));
      } else if (this.arousal > 0.4 && Math.random() < dt * 0.5) {
        this.start('stir', 2.6);
      } else if (t > this.nextStretch && t - this.lastStretch > 180) {
        this.start('stretch', 7.5);
        this.nextStretch = t + lerp(420, 200, m.energy) * (0.7 + Math.random() * 0.6);
      } else if (t > this.nextSettle) {
        this.start('settle', 3.2);
        this.nextSettle = t + lerp(240, 110, chaos) * (0.7 + Math.random() * 0.6);
      }
    }

    // run the current action
    let headUpT = 0;
    let eyeT = this.eyePeek;
    let reachT = 0;
    let extendT = 0;
    let lookT = 0;
    if (this.action) {
      const a = this.action;
      a.t += dt;
      const x = a.t / a.dur;
      if (a.kind === 'stir') {
        const e = envelope(x, 0.35, 0.45);
        headUpT = 0.28 * e;
        eyeT = Math.max(eyeT, 0.22 * e);
      } else if (a.kind === 'wake') {
        const e = envelope(x, 0.2, 0.3);
        headUpT = e;
        eyeT = Math.max(eyeT, 0.72 * envelope(x, 0.25, 0.35));
        lookT = Math.sin(x * Math.PI * 2) * 0.35 * e;
        if (x > 0.7) this.arousal = Math.min(this.arousal, 0.35);
      } else if (a.kind === 'stretch') {
        // 1 head lifts · 2 the bow (front reaches, chest drops) · 3 the hind half follows · 4 curl up
        headUpT = 0.6 * envelope(x, 0.08, 0.9);
        reachT = ease((x - 0.08) / 0.3) * (1 - ease((x - 0.62) / 0.16));
        extendT = ease((x - 0.45) / 0.2) * (1 - ease((x - 0.72) / 0.22));
        eyeT = Math.max(eyeT, 0.28 * Math.max(reachT, extendT));
        this.earBack = Math.max(reachT, extendT) * 0.55;
        if (x > 0.78 && x - dt / a.dur <= 0.78) this.variantTarget = 1 - this.variantTarget;
      } else if (a.kind === 'settle') {
        headUpT = 0.18 * envelope(x, 0.3, 0.5);
        if (x > 0.3 && x - dt / a.dur <= 0.3) this.variantTarget = 1 - this.variantTarget;
      }
      if (a.t >= a.dur) {
        if (a.kind === 'stretch' || a.kind === 'wake') bus.emit('cat:move', { kind: 'settle', strength: 0.5 });
        if (a.kind === 'stretch') this.arousal *= 0.3;
        this.action = null;
      }
    }
    if (!this.action || this.action.kind !== 'stretch') this.earBack *= Math.exp(-dt * 2);
    // a purr is contentment: a slow half-blink, ears soft
    eyeT = Math.max(eyeT, this.purr > 0.3 ? 0.12 + 0.08 * Math.sin(t * 0.6) : 0);

    const k = (tau: number) => 1 - Math.exp(-dt / tau);
    this.headUp += (headUpT - this.headUp) * k(0.6);
    this.eyeOpen += (eyeT - this.eyeOpen) * k(eyeT > this.eyeOpen ? 0.5 : 0.9);
    this.look += (lookT - this.look) * k(0.8);
    this.reach += (reachT - this.reach) * k(0.28);
    this.extend += (extendT - this.extend) * k(0.32);
    // Exponential decay never reaches zero: without snapping, hidden parts kept radii of 1e-20 and
    // the distance function overflowed (the whole proxy box lit up). Snap tiny weights to exactly 0.
    if (this.reach < 1e-3) this.reach = 0;
    if (this.extend < 1e-3) this.extend = 0;
    this.stretch = Math.max(this.reach, this.extend);
    this.variant += (this.variantTarget - this.variant) * k(0.9);
    this.eyePeek *= Math.exp(-dt * 0.5);
    this.earL *= Math.exp(-dt * 7);
    this.earR *= Math.exp(-dt * 6);
    this.tailFlick *= Math.exp(-dt * 1.2);
    this.pawTwitch *= Math.exp(-dt * 5);
    this.breathPhase += dt * Math.PI * 2 * (lerp(0.2, 0.3, m.energy) + this.arousal * 0.12 - this.purr * 0.04) * lerp(0.85, 1.15, m.motion);
    this.tailPhase += dt * ts * (0.35 + this.arousal * 0.8 + this.tailFlick * 4);

    this.build();
  }

  // ------------------------------------------------------------------ body

  private build(): void {
    const ra = ease(this.reach);
    const ex = ease(this.extend);
    const vb = this.variant;
    const breath = Math.sin(this.breathPhase);
    for (let i = 0; i < PARTS; i++) {
      const a = CURL_A[i];
      const b = CURL_B[i];
      const r1 = REACH[i];
      const r2 = EXTEND[i];
      const f = FRONTNESS[i];
      // the front leads the bow; the rear only follows it a little until the extend phase
      const w1 = ra * lerp(0.3, 1, f);
      const w2 = ex * lerp(1, 0.55, f);
      let cx = lerp(a.c[0], b.c[0], vb), cy = lerp(a.c[1], b.c[1], vb), cz = lerp(a.c[2], b.c[2], vb);
      cx = lerp(cx, r1.c[0], w1); cy = lerp(cy, r1.c[1], w1); cz = lerp(cz, r1.c[2], w1);
      cx = lerp(cx, r2.c[0], w2); cy = lerp(cy, r2.c[1], w2); cz = lerp(cz, r2.c[2], w2);
      const wy = Math.max(w1, w2);
      const yaw = lerp(a.yaw, w2 > w1 ? r2.yaw : r1.yaw, wy);
      // radii: joints move, the body barely changes size
      let rx = lerp(a.r[0], w2 > w1 ? r2.r[0] : r1.r[0], wy);
      let ry = lerp(a.r[1], w2 > w1 ? r2.r[1] : r1.r[1], wy);
      let rz = lerp(a.r[2], w2 > w1 ? r2.r[2] : r1.r[2], wy);
      const z = { k: lerp(r1.k, r2.k, ex) };
      if (i <= 1) {
        // breathing: the flank rises and falls
        ry *= 1 + breath * 0.012;
        rz *= 1 + breath * 0.008;
        cy += breath * 0.0008;
      }
      if (i === 6) { const on = smooth(0.0, 0.25, wy); rx *= on; ry *= on; rz *= on; if (rx < 0.003) rx = ry = rz = 0; }
      this.part[i].set(cx, cy, cz, yaw);
      this.partR[i].set(rx, ry, rz, lerp(a.k, z.k, wy));
    }

    // head: curled pose -> head up (stir / wake) -> stretch
    const hc = mixHead(HEAD_CURL_A, HEAD_CURL_B, vb);
    const hu = mixHead(hc, HEAD_UP, ease(this.headUp));
    const h = mixHead(mixHead(hu, HEAD_REACH, ra), HEAD_EXTEND, ex * 0.6);
    this.headPos.set(h.pos[0], h.pos[1] + breath * 0.0004, h.pos[2]);
    this.mat4.makeRotationY(h.yaw + this.look);
    this.mat4.multiply(this.rotX.makeRotationX(h.pitch)).multiply(this.rotZ.makeRotationZ(-h.roll));
    this.headRot.setFromMatrix4(this.mat4);
    // neck follows the head a little
    this.part[5].y += this.headUp * 0.040;
    this.partR[5].y += this.headUp * 0.006;
    this.part[5].z -= this.headUp * 0.012;
    this.partR[5].z *= 1 - this.headUp * 0.15;

    // legs: tucked under and in front of her when curled, reaching out when she stretches
    // forelegs reach in the bow; hind legs fold under, then push back in the extend
    const leg = (out: Vector4, c: number[], r1: number[], r2: number[], w1: number, w2: number, dy: number) => {
      let x = lerp(c[0], r1[0], w1), y = lerp(c[1], r1[1], w1), z = lerp(c[2], r1[2], w1), r = lerp(c[3], r1[3], w1);
      x = lerp(x, r2[0], w2); y = lerp(y, r2[1], w2); z = lerp(z, r2[2], w2); r = lerp(r, r2[3], w2);
      out.set(x, y + dy, z, r < 0.003 ? 0 : r); // a leg thinner than 3 mm is simply off
    };
    for (let i = 0; i < LIMBS; i++) {
      const c = LEGS_CURL[i];
      const r1 = LEGS_REACH[i];
      const r2 = LEGS_EXTEND[i];
      const fore = i < 2;
      const w1 = fore ? ra : ra * 0.8;
      const w2 = fore ? ex * 0.5 : ex;
      // a small lift of the paw as it travels: a step, not a slide
      const lift = fore ? Math.sin(Math.PI * Math.min(1, ra * 1.2)) * 0.012 * (1 - ex) : Math.sin(Math.PI * ex) * 0.01;
      const twitch = i === 0 ? this.pawTwitch * 0.008 : 0; // a dreaming paw
      leg(this.limbA[i], c.a, r1.a, r2.a, w1, w2, 0);
      leg(this.limbM[i], c.m, r1.m, r2.m, w1, w2, lift * 0.6 + twitch * 0.5);
      leg(this.limbB[i], c.b, r1.b, r2.b, w1, w2, lift + twitch);
    }

    this.ears.set(-this.earL * 0.6, this.earR * 0.6, this.earBack, 0);
    this.eyes.set(this.eyeOpen, this.eyeOpen, lerp(0.9, 0.35, this.eyeOpen), this.look);

    // tail: a chain of fixed-length links. Only the bend changes, so it can never stretch or fold.
    //   curled: from the hips round her side to rest along the front, tip near the paws
    //   stretched: streaming behind her, lifting a little, then lying down
    const tb = ease(Math.max(this.extend, this.reach * 0.35));
    const base = this.part[0];
    let px = lerp(-0.194, base.x - 0.086, tb);
    let py = lerp(0.029, 0.087, tb);
    let pz = lerp(-0.014, base.z, tb);
    let heading = lerp(Math.PI * 0.58, Math.PI, tb); // direction in the seat plane
    const turn = lerp(-2.15, -0.25, tb);            // total bend along the tail
    const LINK = 0.024;
    for (let i = 0; i < TAIL; i++) {
      const u = i / (TAIL - 1);
      this.tail[i].set(px, py, pz, lerp(0.019, 0.006, Math.pow(u, 1.4)));
      // the tip lives its own slow life, and flicks when the music asks
      const tip = smooth(0.45, 1, u);
      const sway = Math.sin(this.tailPhase + u * 2.2) * (0.05 + this.tailFlick * 0.2) * tip;
      heading += turn / (TAIL - 1) + sway / (TAIL - 1) * 3;
      const curlY = lerp(0.019, 0.006, Math.pow(Math.min(1, u + 1 / (TAIL - 1)), 1.4)) + 0.002 + tip * this.tailFlick * 0.02 * Math.max(0, Math.sin(this.tailPhase * 1.3));
      const liftY = lerp(0.087, 0.017, u) + Math.sin(u * Math.PI) * 0.05 * (1 - Math.abs(this.extend - 0.5) * 2);
      const ny = lerp(curlY, liftY, tb) - smooth(0.34, 0.61, Math.abs(px)) * 0.16 * tb;
      const dy = Math.max(-LINK * 0.9, Math.min(LINK * 0.9, ny - py));
      const flat = Math.sqrt(Math.max(1e-6, LINK * LINK - dy * dy));
      px += Math.cos(heading) * flat;
      pz += Math.sin(heading) * flat;
      py += dy;
    }
  }

  /** Head frame (for whiskers and sparkles). */
  headMatrix(out: Matrix4): Matrix4 {
    out.setFromMatrix3(this.headRot);
    out.setPosition(this.headPos);
    return out;
  }
}

function mixHead(a: HeadPose, b: HeadPose, t: number): HeadPose {
  return {
    pos: [lerp(a.pos[0], b.pos[0], t), lerp(a.pos[1], b.pos[1], t), lerp(a.pos[2], b.pos[2], t)],
    yaw: lerp(a.yaw, b.yaw, t),
    pitch: lerp(a.pitch, b.pitch, t),
    roll: lerp(a.roll, b.roll, t),
  };
}
