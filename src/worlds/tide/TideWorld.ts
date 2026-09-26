import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  Vector4,
  type IUniform,
  type WebGLRenderer,
  AgXToneMapping,
  Raycaster,
  Plane,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { bus, type NoteOn, type PadGesture } from '../../core/events';
import type { Macros } from '../../core/ParameterStore';
import { echoFeedback, echoTime, fogLevel, lerp, pitchNorm, rainLevel, smooth, timeScale } from '../../core/derive';
import type { World } from '../World';
import { createPalette, samplePalette } from './palettes';
import { createCloudNoise, createWaterDetail } from './noise';
import { NOTE_RIPPLES, ORBS, RIPPLES } from './shaders/common';
import { skyFragment, skyVertex } from './shaders/sky';
import { waterFragment, waterVertex } from './shaders/water';
import {
  finishShader,
  mistFragment,
  mistVertex,
  orbFragment,
  orbVertex,
  particleFragment,
  particleVertex,
} from './shaders/atmos';

const PARTICLES = 2600;
const MIST_LAYERS = [0.5, 1.15, 1.9];

interface Orb {
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  rise: number;
  size: number;
  color: Color;
  peak: number;
  intensity: number;
  age: number;
  held: boolean;
  releasedAge: number;
  noteId: string;
  alive: boolean;
}

interface PendingEcho {
  at: number;
  x: number;
  z: number;
  note: number;
  vel: number;
  active: boolean;
}

/** Quadratic-spaced grid: dense under the camera, sparse toward the horizon. */
function makeWaterGeometry(seg: number, extent: number): BufferGeometry {
  const n = seg + 1;
  const pos = new Float32Array(n * n * 3);
  const f = (t: number) => Math.sign(t) * Math.pow(Math.abs(t), 2.4) * extent;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = (j * n + i) * 3;
      pos[k] = f((i / seg) * 2 - 1);
      pos[k + 1] = 0;
      pos[k + 2] = f((j / seg) * 2 - 1);
    }
  }
  const idx = new Uint32Array(seg * seg * 6);
  let p = 0;
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      idx[p++] = a;
      idx[p++] = c;
      idx[p++] = b;
      idx[p++] = b;
      idx[p++] = c;
      idx[p++] = d;
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setIndex(new BufferAttribute(idx, 1));
  return g;
}

export class TideWorld implements World {
  readonly id = 'tide';
  readonly title = 'World 01 — TIDE';

  private renderer!: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(50, 1, 0.1, 12000);
  private composer!: EffectComposer;
  private bloom!: UnrealBloomPass;
  private finish!: ShaderPass;
  private disposables: { dispose(): void }[] = [];
  private unsubs: (() => void)[] = [];

  private palette = createPalette();
  private U: Record<string, IUniform> = {};

  private ripA: Vector4[] = [];
  private ripB: Vector4[] = [];
  private ripC: Vector4[] = [];
  private nextDripSlot = NOTE_RIPPLES;

  private orbs: Orb[] = [];
  private orbPos: Vector4[] = [];
  private orbCol: Vector4[] = [];
  private orbGeo!: InstancedBufferGeometry;
  private orbAttrPos!: InstancedBufferAttribute;
  private orbAttrCol!: InstancedBufferAttribute;
  private orbAttrSize!: InstancedBufferAttribute;

  private echoes: PendingEcho[] = [];
  private water!: Mesh;
  private sky!: Mesh;
  private mists: Mesh[] = [];
  private particles!: Points;
  private particleU!: Record<string, IUniform>;

  private rtime = 0; // real seconds
  private wtime = 0; // world seconds (scaled by MOTION)
  private waveTime = 0;
  private particleOffset = new Vector3();
  private mistOffset = new Vector2();
  private windAngle = -0.4;
  /** wind gust from pad 4: the target jumps, the gust itself always glides (no visual jerk) */
  private gust = 0;
  private gustTarget = 0;
  private pressure = 0;
  /** mod strip, smoothed: shimmer on water, brighter light, a lift of mist */
  private mod = 0;
  private modTarget = 0;
  /** light limiter factor, smoothed so a burst of notes never makes everything flicker */
  private limitSmooth = 1;
  /** Diagnostics for smoothness checks: visible events that had to be cut short. */
  readonly stats = { ripplesCut: 0, ripplesSkipped: 0, orbsCut: 0 };
  /** ~notes in the last two seconds; dense playing gets proportionally softer light */
  private noteRate = 0;
  /** summed echo intensity of the previous frame, for the light limiter */
  private lightSum = 0;
  private reveal = 0;
  private macros: Macros | null = null;
  private height = 1;

  private camPos = new Vector3();
  private camTarget = new Vector3();
  private fwd = new Vector3();
  private right = new Vector3();
  private tmpV = new Vector3();
  private raycaster = new Raycaster();
  private ground = new Plane(new Vector3(0, 1, 0), 0);

  mount(renderer: WebGLRenderer): void {
    this.renderer = renderer;
    renderer.toneMapping = AgXToneMapping;
    renderer.toneMappingExposure = 1.0;

    const cloudTex = createCloudNoise(256);
    const detailTex = createWaterDetail(256);
    this.disposables.push(cloudTex, detailTex);

    for (let i = 0; i < RIPPLES; i++) {
      this.ripA.push(new Vector4(0, 0, -100, 0));
      this.ripB.push(new Vector4(1, 4, 2, 0.4));
      this.ripC.push(new Vector4(0, 0, 0, 0));
    }
    for (let i = 0; i < ORBS; i++) {
      this.orbPos.push(new Vector4(0, -100, 0, 1));
      this.orbCol.push(new Vector4(0, 0, 0, 0));
      this.orbs.push({
        x: 0, y: 0, z: 0, vx: 0, vz: 0, rise: 0, size: 1, color: new Color(), peak: 0,
        intensity: 0, age: 0, held: false, releasedAge: 0, noteId: '', alive: false,
      });
    }
    for (let i = 0; i < 48; i++) this.echoes.push({ at: 0, x: 0, z: 0, note: 60, vel: 0, active: false });

    // Shared uniform objects: updated once per frame, read by every material.
    this.U = {
      uZenith: { value: new Color() },
      uHorizon: { value: new Color() },
      uSunColor: { value: new Color() },
      uFogColor: { value: new Color() },
      uSunDir: { value: new Vector3(0, 0.1, -1).normalize() },
      uSunSize: { value: 0.9996 },
      uNight: { value: 0 },
      uCloud: { value: 0.2 },
      uHazeAmt: { value: 0.8 },
      uHazeK: { value: 45 },
      uLandColor: { value: new Color() },
      uLights: { value: 0 },
      uGlow: { value: 1 },
      uDiscGain: { value: 3 },
      uTime: { value: 0 },
      uCloudTex: { value: cloudTex },
      uRipA: { value: this.ripA },
      uRipB: { value: this.ripB },
      uRipC: { value: this.ripC },
      uRTime: { value: 0 },
      uOrbPos: { value: this.orbPos },
      uOrbCol: { value: this.orbCol },
      uSwell: { value: 0.2 },
      uWaveTime: { value: 0 },
      uWind: { value: new Vector2(0.3, -1).normalize() },
    };
    const U = this.U;

    // ---- sky
    const skyMat = new ShaderMaterial({
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      uniforms: U,
      side: BackSide,
      depthWrite: false,
      depthTest: false,
    });
    this.sky = new Mesh(new SphereGeometry(4000, 48, 24), skyMat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    // ---- water
    const waterMat = new ShaderMaterial({
      vertexShader: waterVertex,
      fragmentShader: waterFragment,
      uniforms: {
        ...U,
        uDetailTex: { value: detailTex },
        uDetail: { value: 0.5 },
        uRain: { value: 0 },
        uGloss: { value: 900 },
        uFogDensity: { value: 0.004 },
        uWaterColor: { value: new Color() },
        uAccent: { value: new Color() },
        uMetal: { value: 0.1 },
        uFoam: { value: 0 },
        uShimmer: { value: 0 },
      },
    });
    this.water = new Mesh(makeWaterGeometry(256, 3200), waterMat);
    this.water.frustumCulled = false;
    this.scene.add(this.water);

    // ---- mist sheets
    const mistGeo = new PlaneGeometry(1200, 1200, 1, 1).rotateX(-Math.PI / 2);
    MIST_LAYERS.forEach((y, i) => {
      const m = new ShaderMaterial({
        vertexShader: mistVertex,
        fragmentShader: mistFragment,
        uniforms: {
          ...U,
          uDensity: { value: 0.2 },
          uLayer: { value: i },
          uMistOffset: { value: this.mistOffset },
          uMistScale: { value: 0.0045 },
        },
        transparent: true,
        depthWrite: false,
        blending: NormalBlending,
      });
      const mesh = new Mesh(mistGeo, m);
      mesh.position.y = y;
      mesh.renderOrder = 2 + i;
      mesh.frustumCulled = false;
      this.mists.push(mesh);
      this.scene.add(mesh);
    });
    this.disposables.push(mistGeo);

    // ---- particles
    const pGeo = new BufferGeometry();
    const seeds = new Float32Array(PARTICLES * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    pGeo.setAttribute('aSeed', new BufferAttribute(seeds, 4));
    pGeo.setAttribute('position', new BufferAttribute(new Float32Array(PARTICLES * 3), 3));
    this.particleU = {
      ...U,
      uCenter: { value: new Vector3() },
      uBox: { value: new Vector3(140, 7, 140) },
      uOffset: { value: this.particleOffset },
      uDensity: { value: 0.5 },
      uPixelScale: { value: 400 },
      uJitter: { value: 0.4 },
      uStreak: { value: 1 },
      uTint: { value: new Color() },
      uShimmer: { value: 0 },
    };
    const pMat = new ShaderMaterial({
      vertexShader: particleVertex,
      fragmentShader: particleFragment,
      uniforms: this.particleU,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.particles = new Points(pGeo, pMat);
    this.particles.frustumCulled = false;
    this.particles.renderOrder = 5;
    this.scene.add(this.particles);

    // ---- light echoes (instanced billboards)
    const quad = new PlaneGeometry(1, 1);
    this.orbGeo = new InstancedBufferGeometry();
    this.orbGeo.index = quad.index;
    this.orbGeo.setAttribute('position', quad.getAttribute('position'));
    this.orbGeo.setAttribute('uv', quad.getAttribute('uv'));
    this.orbAttrPos = new InstancedBufferAttribute(new Float32Array(ORBS * 3), 3);
    this.orbAttrCol = new InstancedBufferAttribute(new Float32Array(ORBS * 4), 4);
    this.orbAttrSize = new InstancedBufferAttribute(new Float32Array(ORBS), 1);
    this.orbGeo.setAttribute('iPos', this.orbAttrPos);
    this.orbGeo.setAttribute('iCol', this.orbAttrCol);
    this.orbGeo.setAttribute('iSize', this.orbAttrSize);
    this.orbGeo.instanceCount = ORBS;
    const orbMat = new ShaderMaterial({
      vertexShader: orbVertex,
      fragmentShader: orbFragment,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const orbMesh = new Mesh(this.orbGeo, orbMat);
    orbMesh.frustumCulled = false;
    orbMesh.renderOrder = 6;
    this.scene.add(orbMesh);
    this.disposables.push(quad);

    // ---- post: bloom + grade + tone mapping
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new Vector2(512, 512), 0.7, 0.75, 0.82);
    this.composer.addPass(this.bloom);
    this.finish = new ShaderPass(finishShader);
    this.composer.addPass(this.finish);
    this.composer.addPass(new OutputPass());

    this.unsubs.push(
      bus.on('note:on', (e) => this.onNote(e)),
      bus.on('note:off', (e) => this.onNoteOff(e.id)),
      bus.on('drip', (e) => this.onDrip(e.note, e.velocity)),
      bus.on('pad', (e) => this.onPad(e.gesture, e.velocity)),
      bus.on('expression', (e) => {
        this.pressure = e.pressure;
        this.modTarget = e.mod;
      }),
    );
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.height = height * pixelRatio;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  setReveal(v: number): void {
    this.reveal = v;
  }

  // -------------------------------------------------------------------- events

  /** Where a note lands: pitch runs left -> right like the keyboard, low notes further away. */
  private notePosition(note: number, out: { x: number; z: number }): void {
    const m = this.macros!;
    const pn = pitchNorm(note);
    const chaos = m.chaos;
    const dist = lerp(34, 13, pn) * lerp(0.85, 1.25, m.space) * (1 + (Math.random() - 0.5) * (0.25 + chaos * 0.5));
    const halfW = Math.tan((this.camera.fov * Math.PI) / 360) * this.camera.aspect * dist;
    const lateral = ((pn - 0.5) * 1.25 + (Math.random() - 0.5) * (0.12 + chaos * 0.6)) * halfW;
    out.x = this.camPos.x + this.fwd.x * dist + this.right.x * lateral;
    out.z = this.camPos.z + this.fwd.z * dist + this.right.z * lateral;
  }

  private tmpPos = { x: 0, z: 0 };

  private onNote(e: NoteOn): void {
    if (!this.macros) return;
    const m = this.macros;
    const pos = this.tmpPos;
    if (e.position) {
      pos.x = e.position.x;
      pos.z = e.position.z;
    } else this.notePosition(e.note, pos);
    const vel = e.velocity;
    const gen = e.source === 'generative' || e.source === 'pad';

    this.noteRate += 1;
    // Played notes may take over a ripple that is still visible; the world's own notes
    // (echoes, pads) only use free slots, so a burst never cuts a living ring short.
    this.spawnRipple(pos.x, pos.z, e.note, vel * (gen ? 0.7 : 1), 1, !gen);
    this.spawnOrb(e.id, pos.x, pos.z, e.note, vel * (gen ? 0.6 : 1), !gen);
    if (gen) return;

    // Visual echoes land on the same beat as the audio delay repeats, decaying by the same feedback.
    const et = echoTime(m);
    const fb = echoFeedback(m);
    let amp = vel;
    for (let k = 1; k <= 3; k++) {
      amp *= fb;
      if (amp < 0.06) break;
      const slot = this.echoes.find((x) => !x.active);
      if (!slot) break;
      const drift = 3 + m.chaos * 6;
      slot.active = true;
      slot.at = this.rtime + et * k;
      slot.x = pos.x + (Math.random() - 0.5) * drift * k;
      slot.z = pos.z + (Math.random() - 0.5) * drift * k;
      slot.note = e.note;
      slot.vel = amp;
    }
  }

  private onNoteOff(id: string): void {
    for (const o of this.orbs) {
      if (o.alive && o.noteId === id && o.held) {
        o.held = false;
        o.releasedAge = o.age;
      }
    }
  }

  private onDrip(note: number, vel: number): void {
    if (!this.macros) return;
    const r = 8 + Math.random() * 45;
    const lat = (Math.random() - 0.5) * r * 1.4;
    const x = this.camPos.x + this.fwd.x * r + this.right.x * lat;
    const z = this.camPos.z + this.fwd.z * r + this.right.z * lat;
    const i = this.nextDripSlot;
    this.nextDripSlot = i + 1 >= RIPPLES ? NOTE_RIPPLES : i + 1;
    const c = this.palette.accent2;
    this.ripA[i].set(x, z, this.rtime, 0.035 * (0.5 + vel));
    this.ripB[i].set(5.5, 2.6, 0.35, 1.3);
    this.ripC[i].set(c.r, c.g, c.b, 0.12 * vel * (0.4 + (1 - this.macros.world) * 0.6));
    void note;
  }

  private onPad(gesture: PadGesture, vel: number): void {
    if (gesture === 'wave') {
      // A big wave rolls in from out at sea, with a gust of wind that builds and eases.
      this.gustTarget = Math.min(1.2, this.gustTarget + 0.55 + vel * 0.45);
      const d = 90;
      this.spawnRippleRaw(this.camPos.x + this.fwd.x * d, this.camPos.z + this.fwd.z * d, 0.55 + vel * 0.35, 0.32, 4.2, 9, 0.18, this.palette.accent2, 0.25, false);
      return;
    }
    // Other gestures emit notes via the Generator; add one broad swell ring from the centre of view.
    const d = 45;
    this.spawnRippleRaw(this.camPos.x + this.fwd.x * d, this.camPos.z + this.fwd.z * d, 0.5 * vel + 0.2, 0.55, 3.2, 5, 0.3, this.palette.accent, 0.3, false);
  }

  private spawnRipple(x: number, z: number, note: number, vel: number, scale: number, mayReplace: boolean): void {
    const m = this.macros!;
    const pn = pitchNorm(note);
    const k = lerp(0.8, 3.0, pn) * lerp(1, 1.35, m.texture);
    const speed = lerp(2.6, 6.2, pn) * lerp(0.75, 1.25, m.motion);
    const width = lerp(3.4, 1.0, pn) * lerp(0.85, 1.3, m.space);
    const decay = lerp(0.2, 0.5, pn) * lerp(1.3, 0.8, m.space);
    const amp = lerp(0.34, 0.13, pn) * Math.pow(vel, 1.15) * scale;
    const light = lerp(0.25, 0.6, pn) * vel * scale * lerp(0.85, 0.65, m.world) * (1 + this.pressure) * this.density();
    const col = this.tmpColor.copy(this.palette.accent).lerp(this.palette.accent2, pn);
    this.spawnRippleRaw(x, z, amp, k, speed, width, decay, col, light, mayReplace);
  }

  private tmpColor = new Color();

  /** 1 for sparse playing; eases toward ~0.5 for fast runs and big chords so light never floods. */
  private density(): number {
    return 1 / (1 + Math.max(0, this.noteRate - 3) * 0.12);
  }

  private spawnRippleRaw(x: number, z: number, amp: number, k: number, speed: number, width: number, decay: number, col: Color, light: number, mayReplace: boolean): void {
    // Reuse the ripple that has faded the most.
    let best = 0;
    let bestLeft = Infinity;
    for (let i = 0; i < NOTE_RIPPLES; i++) {
      const A = this.ripA[i];
      const left = A.w <= 0 ? -1 : Math.exp(-(this.rtime - A.z) * this.ripB[i].w) * A.w;
      if (left < bestLeft) {
        bestLeft = left;
        best = i;
      }
    }
    // Low-priority ripples never interrupt a ring that is still visible.
    if (!mayReplace && bestLeft > 0.012) {
      this.stats.ripplesSkipped++;
      return;
    }
    if (bestLeft > 0.012) this.stats.ripplesCut++;
    this.ripA[best].set(x, z, this.rtime, amp);
    this.ripB[best].set(k, speed, width, decay);
    this.ripC[best].set(col.r, col.g, col.b, light);
  }

  private spawnOrb(id: string, x: number, z: number, note: number, vel: number, mayReplace: boolean): void {
    const m = this.macros!;
    let o = this.orbs.find((q) => !q.alive);
    if (!o) {
      o = this.orbs[0];
      for (const q of this.orbs) if (q.intensity < o.intensity) o = q;
      if (o.intensity > 0.05) {
        // the world's own notes never snuff out a visible light; played notes may
        if (!mayReplace) return;
        this.stats.orbsCut++;
      }
    }
    const pn = pitchNorm(note);
    o.alive = true;
    o.noteId = id;
    o.held = true;
    o.age = 0;
    o.releasedAge = 0;
    o.x = x;
    o.z = z;
    o.y = lerp(0.6, 1.4, pn);
    o.rise = lerp(0.35, 1.1, pn) * lerp(0.7, 1.3, m.energy);
    o.vx = (Math.random() - 0.5) * (0.2 + m.chaos * 1.2);
    o.vz = (Math.random() - 0.5) * (0.2 + m.chaos * 1.2);
    o.size = lerp(2.6, 1.1, pn) * lerp(0.85, 1.3, m.space);
    o.peak = lerp(0.55, 1.05, Math.pow(vel, 1.2)) * lerp(1.25, 0.75, m.world) * this.density();
    o.intensity = 0;
    o.color.copy(this.palette.accent).lerp(this.palette.accent2, pn * 0.8 + 0.1);
  }

  // -------------------------------------------------------------------- frame

  frame(dt: number, m: Macros): void {
    this.macros = m;
    const ts = timeScale(m);
    this.rtime += dt;
    this.wtime += dt * ts;
    this.gustTarget = Math.max(0, this.gustTarget - dt * 0.22);
    this.gust += (this.gustTarget - this.gust) * (1 - Math.exp(-dt / 0.7));
    this.mod += (this.modTarget - this.mod) * (1 - Math.exp(-dt / 0.2));
    this.noteRate *= Math.exp(-dt / 2);
    const fog = fogLevel(m);
    const rain = rainLevel(m);
    const e = m.energy;
    const U = this.U;

    // ---- light & colour: COLOR picks the palette, WORLD the hour
    samplePalette(m.color, m.world, this.palette);
    const P = this.palette;
    (U.uZenith.value as Color).copy(P.zenith);
    (U.uHorizon.value as Color).copy(P.horizon);
    (U.uFogColor.value as Color).copy(P.fog);
    const w = m.world;
    const sunI = lerp(0.8, 2.4, smooth(0.2, 0.55, w)) * lerp(1, 0.6, smooth(0.6, 1, m.weather));
    (U.uSunColor.value as Color).copy(P.sun).multiplyScalar(sunI);
    // Plastun looks east: the moon and the sunrise stand over the open sea, a little left of centre;
    // as the day climbs the sun moves right, toward the south shore.
    const elev = w < 0.5 ? lerp(0.2, 0.012, smooth(0.0, 0.5, w)) : lerp(0.012, 0.3, smooth(0.5, 1.0, w));
    const az = (w < 0.5 ? lerp(-12, -7, smooth(0, 0.5, w)) : lerp(-7, 14, smooth(0.5, 1, w))) * (Math.PI / 180);
    (U.uSunDir.value as Vector3).set(Math.sin(az), elev, -Math.cos(az)).normalize();
    // Night: a small crisp moon with a restrained halo. Dawn: a wide warm glow. Day: high and airy.
    U.uSunSize.value = lerp(0.99994, 0.99975, smooth(0.25, 0.6, w)) + smooth(0.7, 1, w) * 0.00009;
    U.uGlow.value = lerp(0.22, 1, smooth(0.15, 0.5, w)) * lerp(1, 0.45, smooth(0.6, 1, w));
    U.uDiscGain.value = lerp(2.2, 4.5, smooth(0.2, 0.55, w));
    U.uNight.value = 1 - smooth(0.12, 0.45, w);
    U.uCloud.value = smooth(0.12, 0.95, m.weather);
    // Horizon haze band: dense and wide in fog, thin and clean on a clear day.
    const clearDay = smooth(0.55, 1, w) * (1 - m.weather);
    U.uHazeAmt.value = Math.min(1, lerp(0.35, 0.95, fog) * lerp(1, 0.6, clearDay));
    U.uHazeK.value = lerp(70, 22, fog) * lerp(1, 1.5, clearDay);
    // Hills: dark forest, a touch of the sky's colour; black silhouettes at night.
    const landB = lerp(0.006, 0.05, smooth(0.05, 0.9, w));
    (U.uLandColor.value as Color).setRGB(0.55 * landB, 0.75 * landB, 0.62 * landB).lerp(P.zenith, 0.18);
    U.uLights.value = (1 - smooth(0.15, 0.42, w)) * lerp(1, 0.55, fog);
    U.uTime.value = this.wtime;
    U.uRTime.value = this.rtime;

    // ---- surface: ENERGY + WEATHER + TEXTURE
    const chaosWob = m.chaos * Math.sin(this.wtime * 0.05) * 0.8;
    this.windAngle = -0.4 + chaosWob + Math.sin(this.wtime * 0.013) * 0.3;
    (U.uWind.value as Vector2).set(Math.sin(this.windAngle), -Math.cos(this.windAngle));
    // ENERGY is the sea state: glassy calm -> a real swell with whitecaps.
    U.uSwell.value = lerp(0.04, 1.15, Math.pow(e, 1.3) * 0.65 + m.weather * 0.35) + this.gust * 0.3;
    this.waveTime += dt * ts * lerp(0.55, 1.5, e);
    U.uWaveTime.value = this.waveTime;
    const wm = this.water.material as ShaderMaterial;
    wm.uniforms.uDetail.value = lerp(0.18, 1.05, m.texture) + m.weather * 0.35 + e * 0.55 + this.gust * 0.4;
    wm.uniforms.uRain.value = rain * 0.85;
    wm.uniforms.uFoam.value = smooth(0.45, 1, e * 0.75 + m.weather * 0.35 + this.gust * 0.3);
    wm.uniforms.uShimmer.value = this.mod;
    wm.uniforms.uGloss.value = lerp(1600, 160, Math.pow(m.texture, 0.8));
    wm.uniforms.uMetal.value = lerp(0.18, 0.0, m.texture) * lerp(1, 0.4, m.world);
    wm.uniforms.uFogDensity.value = lerp(0.0075, 0.0019, m.space) * lerp(0.3, 2.6, fog);
    (wm.uniforms.uWaterColor.value as Color).copy(P.water);
    (wm.uniforms.uAccent.value as Color).copy(P.accent);

    // ---- mist: WEATHER thickens, SPACE spreads it, MOTION drifts it
    const wind = U.uWind.value as Vector2;
    const mistSpeed = dt * ts * 0.006 * (1 + e * 2 + this.gust * 3);
    this.mistOffset.x = (this.mistOffset.x + wind.x * mistSpeed) % 64;
    this.mistOffset.y = (this.mistOffset.y + wind.y * mistSpeed) % 64;
    const mistD = lerp(0.0, 0.42, smooth(0.1, 0.95, fog)) * lerp(1.2, 0.85, m.space) * (1 + this.gust * 0.4 + this.mod * 0.3) * lerp(0.8, 1.1, m.atmos);
    this.mists.forEach((mesh, i) => {
      const mu = (mesh.material as ShaderMaterial).uniforms;
      mu.uDensity.value = mistD * (1 - i * 0.22);
      mu.uMistScale.value = lerp(0.0065, 0.0032, m.space);
      mesh.position.x = this.camPos.x;
      mesh.position.z = this.camPos.z;
    });

    // ---- particles: ENERGY density, WEATHER turns motes into drizzle
    const pu = this.particleU;
    const fall = smooth(0.2, 1, rain);
    // Drift is integrated from a smoothed wind speed (never stepped) and wrapped every 4 boxes,
    // which is seamless for all four particle speed classes.
    const drift = dt * ts * (0.3 + m.weather * 2.5 + e * 2.5 + this.gust * 4);
    const box = pu.uBox.value as Vector3;
    const off = this.particleOffset;
    off.x = (off.x + wind.x * drift) % (box.x * 4);
    off.z = (off.z + wind.y * drift) % (box.z * 4);
    off.y = (off.y - dt * (ts * 0.08 + fall * 9)) % (box.y * 4);
    pu.uDensity.value = lerp(0.18, 0.8, e) * lerp(1, 1.3, fall) * lerp(0.7, 1.15, m.atmos);
    pu.uJitter.value = lerp(0.2, 1.4, m.chaos) * (1 - fall * 0.8) * (1 + e * 0.6);
    pu.uShimmer.value = this.mod;
    pu.uStreak.value = 1 + fall * 5;
    pu.uPixelScale.value = this.height * 0.5;
    (pu.uTint.value as Color).copy(P.accent2).multiplyScalar(lerp(0.35, 0.18, w) * (1 - fall * 0.4));
    (pu.uCenter.value as Vector3).copy(this.camPos);

    // ---- camera: very slow drift; SPACE raises and widens
    // Standing just off the pebble beach at the river mouth, looking out of the bay (-z = bearing 108°):
    // cape Astasheva at the left edge, open sea ahead, the south shore hills on the right.
    // The camera only breathes around that spot; it never travels away from it.
    const t = this.wtime * 0.018;
    const ch = 1 + m.chaos * 0.6;
    const bob = Math.sin(this.wtime * lerp(0.35, 0.9, e)) * lerp(0.03, 0.22, e);
    this.camPos.set(
      Math.sin(t * 0.7) * 2.5 * ch,
      lerp(3.1, 4.6, m.space) + Math.sin(t * 1.9) * 0.18 + bob + this.gust * 0.08,
      Math.cos(t * 0.45) * 1.8,
    );
    const yaw = Math.sin(t * 0.52) * 0.035 * ch;
    this.camTarget.set(this.camPos.x + Math.sin(yaw) * 60, lerp(-0.6, 0.0, m.space) + Math.sin(t * 1.1) * 0.12, this.camPos.z - Math.cos(yaw) * 60);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);
    const fov = lerp(44, 52, m.space);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.fwd.copy(this.camTarget).sub(this.camPos).setY(0).normalize();
    this.right.set(-this.fwd.z, 0, this.fwd.x);
    this.sky.position.copy(this.camPos);
    // the camera stays around the origin, so the water grid stays put (no snapping pops)

    // ---- pending visual echoes
    for (const e of this.echoes) {
      if (e.active && this.rtime >= e.at) {
        e.active = false;
        this.spawnRipple(e.x, e.z, e.note, e.vel, 0.8, false);
      }
    }

    // ---- light echoes: bloom in, hover while held, fade after release.
    // Soft limiter: above a total of ~4 the whole group is scaled down together.
    const LIGHT_BUDGET = 4;
    const limitTarget = this.lightSum > LIGHT_BUDGET ? LIGHT_BUDGET / this.lightSum : 1;
    this.limitSmooth += (limitTarget - this.limitSmooth) * (1 - Math.exp(-dt / 0.35));
    const limit = this.limitSmooth * (1 + this.mod * 0.35);
    this.lightSum = 0;
    for (let i = 0; i < ORBS; i++) {
      const o = this.orbs[i];
      const pos = this.orbPos[i];
      const col = this.orbCol[i];
      if (!o.alive) {
        col.w = 0;
        this.orbAttrCol.setW(i, 0);
        continue;
      }
      o.age += dt;
      // ease-out: visible on the very next frame, still soft at the top
      const attack = Math.min(1, o.age / 0.3);
      let env = 1 - (1 - attack) * (1 - attack);
      if (o.held) env *= lerp(1, 0.55, Math.min(1, o.age / 4));
      else env *= 0.55 * Math.exp(-(o.age - o.releasedAge) * 0.45) + 0.45 * Math.exp(-o.age * 0.6);
      o.intensity = o.peak * env * (1 + this.pressure * 0.8);
      // below ~0.02 an echo is invisible: free its slot for the next note
      if (!o.held && o.intensity < 0.02) {
        o.alive = false;
        col.w = 0;
        this.orbAttrCol.setW(i, 0);
        continue;
      }
      this.lightSum += o.intensity;
      o.y += o.rise * dt * ts * (o.held ? 0.35 : 1);
      o.x += o.vx * dt * ts + wind.x * this.gust * dt * 4;
      o.z += o.vz * dt * ts + wind.y * this.gust * dt * 4;
      const reveal = this.reveal;
      pos.set(o.x, o.y, o.z, o.size);
      const shown = o.intensity * reveal * limit;
      col.set(o.color.r, o.color.g, o.color.b, shown);
      this.orbAttrPos.setXYZ(i, o.x, o.y, o.z);
      this.orbAttrCol.setXYZW(i, o.color.r, o.color.g, o.color.b, shown);
      this.orbAttrSize.setX(i, o.size * 1.8);
    }
    this.orbAttrPos.needsUpdate = true;
    this.orbAttrCol.needsUpdate = true;
    this.orbAttrSize.needsUpdate = true;

    // ---- post
    this.bloom.strength = lerp(0.62, 0.42, w) * (1 + this.pressure * 0.3 + this.mod * 0.25);
    this.bloom.radius = lerp(0.45, 0.7, m.space);
    this.bloom.threshold = lerp(0.88, 0.97, w);
    this.renderer.toneMappingExposure = w < 0.5 ? lerp(1.05, 0.86, smooth(0.2, 0.5, w)) : 0.86;
    this.finish.uniforms.uTime.value = this.rtime;
    this.finish.uniforms.uGrain.value = lerp(0.02, 0.06, m.texture);
    this.finish.uniforms.uVignette.value = lerp(0.45, 0.28, m.space);
    this.finish.uniforms.uFade.value = this.reveal;

    this.composer.render(dt);
  }

  pick(ndcX: number, ndcY: number): { x: number; z: number } | null {
    this.raycaster.setFromCamera(new Vector2(ndcX, ndcY), this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.ground, this.tmpV);
    if (!hit) return null;
    if (hit.distanceTo(this.camPos) > 400) return null;
    return { x: hit.x, z: hit.z };
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.scene.traverse((obj) => {
      const mesh = obj as Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) (mesh.material as ShaderMaterial).dispose();
    });
    for (const d of this.disposables) d.dispose();
    this.composer.dispose();
  }
}
