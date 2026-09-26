import { Matrix3, Matrix4, Vector3, Vector4 } from 'three';
import { bus, type PadGesture } from '../../core/events';
import type { Macros } from '../../core/ParameterStore';
import { lerp, smooth } from '../../core/derive';
import { PARTS, TAIL } from './catShader';

type V3 = [number, number, number];
interface Part {
  c: V3;
  yaw: number;
  r: V3;
  k: number;
}

// Local space: seat top at y = 0, +x toward her head, +z toward the viewer.
// Indices: 0 hips · 1 middle · 2 chest · 3 shoulder · 4 near thigh · 5 hind paw · 6/7 front paws
//          8/9 forearms · 10 neck · 11 far thigh
const CURL_A: Part[] = [
  { c: [-0.105, 0.098, -0.035], yaw: 0.3, r: [0.132, 0.1, 0.122], k: 0.05 },
  { c: [0.0, 0.098, -0.075], yaw: -0.1, r: [0.12, 0.094, 0.105], k: 0.05 },
  { c: [0.095, 0.088, -0.03], yaw: -0.6, r: [0.096, 0.082, 0.09], k: 0.045 },
  { c: [0.125, 0.105, 0.01], yaw: 0, r: [0.065, 0.055, 0.06], k: 0.035 },
  { c: [-0.07, 0.072, 0.068], yaw: 0.5, r: [0.075, 0.058, 0.066], k: 0.035 },
  { c: [0.0, 0.026, 0.122], yaw: 0.2, r: [0.052, 0.021, 0.028], k: 0.02 },
  { c: [0.083, 0.028, 0.13], yaw: 0.4, r: [0.026, 0.021, 0.05], k: 0.018 },
  { c: [0.135, 0.03, 0.105], yaw: 0.9, r: [0.026, 0.021, 0.046], k: 0.018 },
  { c: [0.1, 0.045, 0.09], yaw: 0.4, r: [0.03, 0.028, 0.05], k: 0.025 },
  { c: [0.14, 0.05, 0.07], yaw: 0.9, r: [0.028, 0.026, 0.045], k: 0.025 },
  { c: [0.14, 0.085, 0.045], yaw: 0, r: [0.05, 0.048, 0.05], k: 0.035 },
  { c: [-0.12, 0.08, -0.09], yaw: 0, r: [0, 0, 0], k: 0.035 },
];
// A second, slightly tighter curl: head tucked lower, paws closer. Used when she resettles.
const CURL_B: Part[] = CURL_A.map((p, i) => {
  const q: Part = { c: [...p.c], yaw: p.yaw, r: [...p.r], k: p.k };
  if (i === 0) q.c = [-0.095, 0.1, -0.045];
  if (i === 6) q.c = [0.07, 0.03, 0.125];
  if (i === 7) q.c = [0.12, 0.028, 0.115];
  if (i === 10) q.c = [0.135, 0.08, 0.05];
  return q;
});
const STRETCH: Part[] = [
  { c: [-0.17, 0.155, -0.01], yaw: 0, r: [0.115, 0.095, 0.105], k: 0.05 },
  { c: [-0.05, 0.13, -0.01], yaw: 0, r: [0.115, 0.085, 0.095], k: 0.05 },
  { c: [0.07, 0.095, 0.0], yaw: 0, r: [0.095, 0.075, 0.085], k: 0.045 },
  { c: [0.1, 0.1, 0.0], yaw: 0, r: [0.055, 0.05, 0.055], k: 0.035 },
  { c: [-0.16, 0.1, 0.065], yaw: 0, r: [0.07, 0.075, 0.055], k: 0.035 },
  { c: [-0.15, 0.025, 0.07], yaw: 0, r: [0.045, 0.02, 0.028], k: 0.02 },
  { c: [0.32, 0.018, 0.045], yaw: 0, r: [0.045, 0.018, 0.027], k: 0.02 },
  { c: [0.3, 0.018, -0.045], yaw: 0, r: [0.045, 0.018, 0.027], k: 0.02 },
  { c: [0.21, 0.032, 0.035], yaw: 0, r: [0.075, 0.028, 0.03], k: 0.03 },
  { c: [0.2, 0.032, -0.035], yaw: 0, r: [0.075, 0.028, 0.03], k: 0.03 },
  { c: [0.14, 0.1, 0.0], yaw: 0, r: [0.05, 0.05, 0.05], k: 0.035 },
  { c: [-0.16, 0.1, -0.07], yaw: 0, r: [0.07, 0.075, 0.055], k: 0.035 },
];

interface HeadPose {
  pos: V3;
  yaw: number;
  pitch: number;
  roll: number;
}
const HEAD_CURL_A: HeadPose = { pos: [0.168, 0.072, 0.09], yaw: 0.65, pitch: 0.3, roll: 0.55 };
const HEAD_CURL_B: HeadPose = { pos: [0.158, 0.066, 0.098], yaw: 0.8, pitch: 0.38, roll: 0.62 };
const HEAD_UP: HeadPose = { pos: [0.165, 0.15, 0.07], yaw: 0.35, pitch: -0.12, roll: 0.08 };
const HEAD_STRETCH: HeadPose = { pos: [0.2, 0.14, 0.01], yaw: 0.45, pitch: -0.3, roll: 0.0 };

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
  readonly headPos = new Vector3();
  readonly headRot = new Matrix3();
  readonly ears = new Vector4();
  readonly eyes = new Vector4(0, 0, 0.6, 0);
  stretch = 0;

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
    else if (g === 'stretch') this.start('stretch', 6.4, true);
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
        if (this.arousal > 0.9 && t - this.lastStretch > 80) this.start('stretch', 6.4);
        else this.start('wake', lerp(4, 7, Math.random()));
      } else if (this.arousal > 0.4 && Math.random() < dt * 0.5) {
        this.start('stir', 2.6);
      } else if (t > this.nextStretch && t - this.lastStretch > 180) {
        this.start('stretch', 6.4);
        this.nextStretch = t + lerp(420, 200, m.energy) * (0.7 + Math.random() * 0.6);
      } else if (t > this.nextSettle) {
        this.start('settle', 3.2);
        this.nextSettle = t + lerp(240, 110, chaos) * (0.7 + Math.random() * 0.6);
      }
    }

    // run the current action
    let headUpT = 0;
    let eyeT = this.eyePeek;
    let stretchT = 0;
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
        eyeT = Math.max(eyeT, 0.82 * envelope(x, 0.25, 0.35));
        lookT = Math.sin(x * Math.PI * 2) * 0.35 * e;
        if (x > 0.7) this.arousal = Math.min(this.arousal, 0.35);
      } else if (a.kind === 'stretch') {
        stretchT = envelope(x, 0.34, 0.38);
        eyeT = Math.max(eyeT, 0.3 * stretchT);
        this.earBack = stretchT * 0.6;
        if (x > 0.62 && x - dt / a.dur <= 0.62) this.variantTarget = 1 - this.variantTarget;
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
    this.stretch += (stretchT - this.stretch) * k(0.35);
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
    const s = ease(this.stretch);
    const vb = this.variant;
    const breath = Math.sin(this.breathPhase);
    for (let i = 0; i < PARTS; i++) {
      const a = CURL_A[i];
      const b = CURL_B[i];
      const z = STRETCH[i];
      const cx = lerp(lerp(a.c[0], b.c[0], vb), z.c[0], s);
      let cy = lerp(lerp(a.c[1], b.c[1], vb), z.c[1], s);
      const cz = lerp(lerp(a.c[2], b.c[2], vb), z.c[2], s);
      const yaw = lerp(a.yaw, z.yaw, s);
      let rx = lerp(a.r[0], z.r[0], s);
      let ry = lerp(a.r[1], z.r[1], s);
      let rz = lerp(a.r[2], z.r[2], s);
      if (i <= 1) {
        // breathing: the flank rises and falls
        ry *= 1 + breath * 0.035;
        rz *= 1 + breath * 0.025;
        cy += breath * 0.003;
      }
      if (i === 6) cy += this.pawTwitch * 0.01;
      if (i === 11 && s < 0.02) rx = ry = rz = 0;
      this.part[i].set(cx, cy, cz, yaw);
      this.partR[i].set(rx, ry, rz, lerp(a.k, z.k, s));
    }

    // head: curled pose -> head up (stir / wake) -> stretch
    const hc = mixHead(HEAD_CURL_A, HEAD_CURL_B, vb);
    const hu = mixHead(hc, HEAD_UP, ease(this.headUp));
    const h = mixHead(hu, HEAD_STRETCH, s);
    this.headPos.set(h.pos[0], h.pos[1] + breath * 0.002, h.pos[2]);
    this.mat4.makeRotationY(h.yaw + this.look);
    const rx = new Matrix4().makeRotationX(h.pitch);
    const rz = new Matrix4().makeRotationZ(-h.roll);
    this.mat4.multiply(rx).multiply(rz);
    this.headRot.setFromMatrix4(this.mat4);
    // neck follows the head a little
    this.part[10].y += this.headUp * 0.03;

    this.ears.set(-this.earL * 0.6, this.earR * 0.6, this.earBack, 0);
    this.eyes.set(this.eyeOpen, this.eyeOpen, lerp(0.9, 0.35, this.eyeOpen), this.look);

    // tail: wrapped around the front when curled, straight back when she stretches
    for (let i = 0; i < TAIL; i++) {
      const u = i / (TAIL - 1);
      // from the hips round her back-left side to rest along the front, tip near her paws
      const ang = lerp(Math.PI * 1.02, Math.PI * 0.4, u);
      const R = lerp(0.205, 0.17, u);
      let x = Math.cos(ang) * R + 0.005;
      let y = lerp(0.052, 0.026, u);
      let z = Math.sin(ang) * R + 0.005;
      // the tip lives its own slow life
      const tip = smooth(0.55, 1, u);
      const sway = Math.sin(this.tailPhase + u * 2.2) * (0.012 + this.tailFlick * 0.03) * tip;
      x += -Math.sin(ang) * sway;
      z += Math.cos(ang) * sway;
      y += tip * this.tailFlick * 0.02 * Math.max(0, Math.sin(this.tailPhase * 1.3));
      const sx = -0.25 - u * 0.24;
      const sy = 0.15 - u * 0.03 + Math.sin(this.tailPhase + u * 3) * 0.01 * u;
      const sz = u * 0.03;
      x = lerp(x, sx, s);
      y = lerp(y, sy, s);
      z = lerp(z, sz, s);
      this.tail[i].set(x, y, z, lerp(0.027, 0.017, u));
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
