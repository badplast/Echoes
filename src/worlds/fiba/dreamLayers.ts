import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Mesh,
  PlaneGeometry,
  Points,
  ShaderMaterial,
  type IUniform,
  type Scene,
} from 'three';

/**
 * The air of the dream, in depth layers behind, around and in front of the chair:
 * - veils: slow luminous fog clouds at three depths (the room seen through a dream);
 * - threads: a few very thin, drifting filaments of light with a soft iridescence;
 * - deep lights: rare distant lights far behind, and a handful of large translucent
 *   "dream seeds" drifting slowly through the middle distance.
 * Everything is additive and faint; nothing is ever drawn onto Fiba herself as light.
 */
const NOISE = /* glsl */ `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 5.1; a *= 0.5; } return v; }
vec3 irid(float t) { return 0.5 + 0.5 * cos(6.2831 * (t + vec3(0.0, 0.33, 0.67))); }
`;

const THREADS = 7;
const DEEP = 110;

export interface DreamParams {
  time: number;
  reveal: number;
  mist: number; // weather
  float: number; // motion multiplier
  wonder: number; // chaos
  moon: number; // moonbeam fader
  bright: number; // palette brightness
  pixel: number; // drawing buffer height
  pulse: number; // a short swell from chords / pads, 0..1
  dream: Color;
  dream2: Color;
  glow: Color;
  mistCol: Color;
}

export class DreamLayers {
  private veilU: Record<string, IUniform>[] = [];
  private threadU: Record<string, IUniform>;
  private deepU: Record<string, IUniform>;
  private owned: { dispose(): void }[] = [];

  constructor(scene: Scene) {
    // ---- veils: large planes at three depths, each an fbm cloud lit from the window side
    const veilDefs = [
      { z: -1.45, y: 1.05, w: 5.2, h: 2.8, amt: 1.0, seed: 1.0 },
      { z: -0.75, y: 0.95, w: 3.8, h: 2.2, amt: 0.7, seed: 7.0 },
      { z: 0.55, y: 0.28, w: 3.2, h: 0.7, amt: 0.45, seed: 13.0 }, // low ground mist in front of the seat
    ];
    for (const d of veilDefs) {
      const u: Record<string, IUniform> = {
        uTime: { value: 0 }, uReveal: { value: 0 }, uAmt: { value: 0 }, uSeed: { value: d.seed },
        uCol: { value: new Color() }, uCol2: { value: new Color() }, uFloat: { value: 1 }, uLow: { value: d.z > 0 ? 1 : 0 },
      };
      this.veilU.push(u);
      const mat = new ShaderMaterial({
        uniforms: u,
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: /* glsl */ `
          uniform float uTime; uniform float uReveal; uniform float uAmt; uniform float uSeed; uniform float uFloat; uniform float uLow;
          uniform vec3 uCol; uniform vec3 uCol2;
          varying vec2 vUv;
          ${NOISE}
          void main() {
            vec2 q = vUv * vec2(3.0, 1.6) + uSeed;
            float t = uTime * 0.018 * uFloat;
            vec2 w = vec2(fbm(q + vec2(t, 0.0)), fbm(q + vec2(3.1, -t * 0.7)));
            float c = fbm(q * 0.9 + w * 1.4 + vec2(t * 0.6, t * 0.2));
            float cloud = smoothstep(0.42, 0.85, c);
            // soft edges so no plane border ever shows
            float edge = smoothstep(0.0, 0.25, vUv.x) * smoothstep(1.0, 0.75, vUv.x) * smoothstep(0.0, 0.3, vUv.y) * smoothstep(1.0, 0.6, vUv.y);
            if (uLow > 0.5) edge *= smoothstep(1.0, 0.2, vUv.y);
            // a faint thin-film shimmer at the rims of the clouds
            float rim = smoothstep(0.5, 0.62, c) * smoothstep(0.78, 0.62, c);
            vec3 col = mix(uCol, uCol2, w.x) + irid(c * 2.0 + t) * rim * 0.12;
            float a = cloud * edge * uAmt * uReveal;
            gl_FragColor = vec4(col * a, a);
          }`,
        transparent: true, depthWrite: false, blending: AdditiveBlending,
      });
      const m = new Mesh(new PlaneGeometry(d.w, d.h), mat);
      m.position.set(0.1, d.y, d.z);
      m.renderOrder = d.z > 0 ? 13 : -8;
      scene.add(m);
      this.owned.push(m.geometry, mat);
    }

    // ---- threads: thin filaments of light, each a ribbon bent by slow waves
    const tg = new BufferGeometry();
    const SEG = 96;
    const pos: number[] = [];
    const uv: number[] = [];
    const seed: number[] = [];
    const idx: number[] = [];
    for (let k = 0; k < THREADS; k++) {
      const base = pos.length / 3;
      const s = Math.random();
      for (let i = 0; i <= SEG; i++) {
        for (const side of [-1, 1]) {
          pos.push(i / SEG, side, 0);
          uv.push(i / SEG, side * 0.5 + 0.5);
          seed.push(k + s * 0.999);
        }
      }
      for (let i = 0; i < SEG; i++) {
        const a = base + i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    tg.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    tg.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
    tg.setAttribute('aSeed', new BufferAttribute(new Float32Array(seed), 1));
    tg.setIndex(idx);
    this.threadU = {
      uTime: { value: 0 }, uReveal: { value: 0 }, uAmt: { value: 0 }, uFloat: { value: 1 },
      uCol: { value: new Color() }, uCol2: { value: new Color() },
    };
    const tm = new ShaderMaterial({
      uniforms: this.threadU,
      vertexShader: /* glsl */ `
        attribute float aSeed; uniform float uTime; uniform float uFloat;
        varying vec2 vUv; varying float vSeed; varying float vDepth;
        void main() {
          float k = floor(aSeed); float s = fract(aSeed);
          float x = position.x;
          float t = uTime * 0.04 * uFloat + s * 40.0;
          // each thread lives at its own depth, sweeping in a long gentle arc across the air
          vec3 p = vec3(mix(-1.6, 1.6, x), 0.55 + s * 1.1, mix(-1.3, 0.2, fract(s * 7.3)));
          p.y += sin(x * 3.1 + t) * 0.12 + sin(x * 7.3 - t * 1.7 + k) * 0.035;
          p.z += sin(x * 2.3 + t * 0.8 + k) * 0.25;
          p.x += sin(t * 0.3 + k) * 0.3;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          // constant thin width on screen: offset in view space, scaled by depth
          float w = 0.0018 * max(-mv.z, 0.5);
          vec3 tangent = normalize(vec3(3.2, cos(x * 3.1 + t) * 0.37 + cos(x * 7.3 - t * 1.7 + k) * 0.25, cos(x * 2.3 + t * 0.8 + k) * 0.58));
          vec3 tv = normalize((viewMatrix * vec4(tangent, 0.0)).xyz);
          vec3 nv = cross(tv, vec3(0.0, 0.0, 1.0));
          nv = length(nv) > 1e-3 ? normalize(nv) : vec3(0.0, 1.0, 0.0);
          mv.xyz += nv * position.y * w;
          vUv = uv; vSeed = aSeed; vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uReveal; uniform float uAmt; uniform vec3 uCol; uniform vec3 uCol2;
        varying vec2 vUv; varying float vSeed; varying float vDepth;
        vec3 irid(float t) { return 0.5 + 0.5 * cos(6.2831 * (t + vec3(0.0, 0.33, 0.67))); }
        void main() {
          float across = abs(vUv.y - 0.5) * 2.0;
          float core = exp(-across * across * 5.0);
          float s = fract(vSeed);
          // light travels along the thread in slow soft pulses; ends fade to nothing
          float along = smoothstep(0.0, 0.2, vUv.x) * smoothstep(1.0, 0.8, vUv.x);
          float travel = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(vUv.x * 9.0 - uTime * 0.35 + s * 30.0), 3.0);
          float life = 0.5 + 0.5 * sin(uTime * 0.05 + s * 17.0); // threads come and go
          vec3 col = mix(uCol, uCol2, s) * 0.8 + irid(vUv.x * 1.5 + uTime * 0.02 + s) * 0.25;
          float a = core * along * travel * smoothstep(0.2, 0.7, life) * uAmt * uReveal * 0.35;
          gl_FragColor = vec4(col * a, a);
        }`,
      transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide,
    });
    const threads = new Mesh(tg, tm);
    threads.frustumCulled = false;
    threads.renderOrder = 10;
    scene.add(threads);
    this.owned.push(tg, tm);

    // ---- deep lights: distant twinkles far behind + a few large translucent dream seeds
    const dg = new BufferGeometry();
    const ds = new Float32Array(DEEP * 4);
    for (let i = 0; i < ds.length; i++) ds[i] = Math.random();
    dg.setAttribute('position', new BufferAttribute(new Float32Array(DEEP * 3), 3));
    dg.setAttribute('aSeed', new BufferAttribute(ds, 4));
    this.deepU = {
      uTime: { value: 0 }, uReveal: { value: 0 }, uPixel: { value: 400 }, uFloat: { value: 1 }, uAmt: { value: 1 },
      uCol: { value: new Color() }, uCol2: { value: new Color() }, uWarm: { value: new Color('#ffcf9a') },
    };
    const dm = new ShaderMaterial({
      uniforms: this.deepU,
      vertexShader: /* glsl */ `
        attribute vec4 aSeed; uniform float uTime; uniform float uPixel; uniform float uFloat;
        uniform vec3 uCol; uniform vec3 uCol2; uniform vec3 uWarm;
        varying vec3 vCol; varying float vA; varying float vKind;
        void main() {
          // 88% far lights, 12% large seeds in the middle distance
          float seedKind = step(0.88, aSeed.w);
          vec3 p;
          float t = uTime * uFloat;
          if (seedKind < 0.5) {
            p = vec3((aSeed.x - 0.5) * 6.0, 0.25 + aSeed.y * 2.4, -1.75 - aSeed.z * 0.1);
            p.y += sin(t * 0.03 + aSeed.x * 20.0) * 0.03;
            // a few of them drift like far lanterns
            p.x += step(0.8, aSeed.z) * sin(t * 0.02 + aSeed.y * 9.0) * 0.4;
            float tw = 0.5 + 0.5 * sin(uTime * (0.15 + aSeed.z * 0.5) + aSeed.x * 40.0);
            vA = pow(tw, 3.0) * mix(0.25, 1.0, fract(aSeed.w * 17.0)) * 0.55;
            vCol = mix(mix(uCol, uCol2, aSeed.y), uWarm, step(0.7, fract(aSeed.x * 13.0)) * 0.7);
          } else {
            p = vec3((aSeed.x - 0.5) * 2.4, 0.5 + aSeed.y * 1.2, -0.3 - aSeed.z * 1.0);
            p.x += sin(t * 0.021 + aSeed.y * 11.0) * 0.25;
            p.y += fract(aSeed.z + t * 0.004) * 0.25;
            vA = (0.5 + 0.5 * sin(uTime * 0.07 + aSeed.x * 9.0)) * 0.1;
            vCol = mix(uCol, uCol2, aSeed.z) * 0.9;
          }
          vKind = seedKind;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float sz = seedKind > 0.5 ? (0.05 + aSeed.y * 0.06) : (0.004 + fract(aSeed.w * 29.0) * 0.006);
          gl_PointSize = clamp(sz * uPixel / max(-mv.z, 0.2) * 2.2, 1.5, 120.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uReveal; uniform float uAmt; varying vec3 vCol; varying float vA; varying float vKind;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a;
          if (vKind < 0.5) a = exp(-d * d * 10.0) + exp(-d * d * 2.5) * 0.25;
          else a = smoothstep(1.0, 0.75, d) * (0.35 + 0.65 * smoothstep(0.3, 1.0, d)); // a translucent bubble with a brighter rim
          a *= vA * uAmt * uReveal;
          if (a < 0.003) discard;
          gl_FragColor = vec4(vCol * a, a);
        }`,
      transparent: true, depthWrite: false, blending: AdditiveBlending,
    });
    const deep = new Points(dg, dm);
    deep.frustumCulled = false;
    deep.renderOrder = -7;
    scene.add(deep);
    this.owned.push(dg, dm);
  }

  update(p: DreamParams): void {
    const veilAmts = [0.07, 0.05, 0.035];
    this.veilU.forEach((u, i) => {
      u.uTime.value = p.time;
      u.uReveal.value = p.reveal;
      u.uFloat.value = p.float;
      u.uAmt.value = veilAmts[i] * (0.4 + p.mist * 1.2) * (0.7 + 0.5 * p.bright) * (1 + p.pulse * 0.5);
      (u.uCol.value as Color).copy(p.mistCol).lerp(p.glow, 0.3 + 0.3 * p.moon);
      (u.uCol2.value as Color).copy(p.dream).lerp(p.mistCol, 0.5);
    });
    const t = this.threadU;
    t.uTime.value = p.time;
    t.uReveal.value = p.reveal;
    t.uFloat.value = p.float;
    t.uAmt.value = (0.35 + p.wonder * 0.9 + p.pulse * 0.8) * (0.7 + 0.4 * p.moon);
    (t.uCol.value as Color).copy(p.dream);
    (t.uCol2.value as Color).copy(p.dream2);
    const d = this.deepU;
    d.uTime.value = p.time;
    d.uReveal.value = p.reveal;
    d.uPixel.value = p.pixel;
    d.uFloat.value = p.float;
    d.uAmt.value = 0.7 + p.wonder * 0.6 + p.pulse * 0.4;
    (d.uCol.value as Color).copy(p.dream);
    (d.uCol2.value as Color).copy(p.dream2);
  }

  dispose(): void {
    for (const o of this.owned) o.dispose();
    this.owned = [];
  }
}
