import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NormalBlending,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  PointLight,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  AgXToneMapping,
  type IUniform,
  type WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { sanitizeShader } from '../../post/sanitize';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { bus, type NoteOn, type PadGesture } from '../../core/events';
import type { Macros } from '../../core/ParameterStore';
import { lerp, pitchNorm, smooth } from '../../core/derive';
import type { ParamLabels, World } from '../World';
import { finishShader } from '../tide/shaders/atmos';
import { CatRig } from './CatRig';
import { DreamLayers } from './dreamLayers';
import { catFragment, catVertex } from './catShader';
import { createPalette, paletteName, samplePalette } from './palettes';
import { oakFloor } from './textures';
import { buildFibaChair } from './chair';

// ---------------------------------------------------------------- layout (metres)
const SEAT_TOP = 0.535;
const CAT_SCALE = 0.84;
const LAMP_POS = new Vector3(-1.05, 0.22, -0.35);
const LAMP_COLOR = new Color('#ffb372'); // fixed: COLOR never recolours the lamp or Fiba
const MOON_COLOR = new Color('#aebbd8');
const MOON_FROM = new Vector3(1.9, 2.6, -1.6); // where the moonlight comes from (a window off frame)
const FOCUS = new Vector3(0.0, 0.68, 0.03);
const Y_AXIS = new Vector3(0, 1, 0);
const DUST = 2600;
const BOKEH = 36;
const MOTES = 240;

const MOTE_ORB = 0;
const MOTE_GLINT = 1;
const MOTE_PETAL = 2;
const MOTE_STREAK = 3;
const MOTE_HALO = 4; // a thin ring of light that slowly opens (middle register)
const MOTE_BLOOM = 5; // a big, dim, warm cloud of light low in the air (low register)
const MOTE_SPARK = 6; // a tiny sharp spark with a short tail (high register)

interface Mote {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  age: number; life: number;
  size: number; intensity: number;
  shape: number; spin: number; rot: number;
  col: Color;
}

// ---------------------------------------------------------------- shaders
const backdropFrag = /* glsl */ `
uniform float uTime;
uniform vec3 uDeep; uniform vec3 uRoom; uniform vec3 uGlow; uniform vec3 uMist;
uniform vec3 uDream; uniform vec3 uDream2; uniform vec3 uLamp;
uniform float uBright; uniform float uMoon; uniform float uMistAmt; uniform float uLampI;
uniform float uLift; uniform float uReveal; uniform float uFloat;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.02 + 7.3; a *= 0.5; } return v; }
float softBox(vec2 p, vec2 c, vec2 hs, float blur) { vec2 d = abs(p - c) - hs; float o = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); return 1.0 - smoothstep(-blur, blur, o); }
void main() {
  vec2 uv = vUv;
  float t = uTime;
  // the wall in the dark, the floor melting into it (everything out of focus)
  float floorZone = smoothstep(0.34, 0.2, uv.y);
  vec3 col = mix(uDeep, uRoom, smoothstep(1.0, 0.25, uv.y) * smoothstep(0.0, 0.5, 1.0 - abs(uv.x - 0.45) * 1.3));
  col = mix(col, uRoom * 0.8 + uLamp * 0.06 * uLampI, floorZone * 0.8);
  col *= uBright;
  // a window somewhere to the right: only its glow, blurred by the dream
  float win = softBox(uv, vec2(0.83, 0.74), vec2(0.075, 0.13), 0.06);
  float mull = 1.0 - 0.35 * softBox(uv, vec2(0.83, 0.74), vec2(0.004, 0.13), 0.01) - 0.35 * softBox(uv, vec2(0.83, 0.74), vec2(0.075, 0.004), 0.01);
  col += uGlow * win * mull * (0.12 + 0.9 * uMoon) * (0.6 + 0.4 * uBright);
  col += uGlow * exp(-pow(length((uv - vec2(0.83, 0.72)) * vec2(1.0, 0.8)) / 0.3, 2.0)) * 0.12 * (0.2 + uMoon);
  // the lamp on the floor, far out of focus: a warm bokeh with a halo
  vec2 lp = (uv - vec2(0.13, 0.2)) * vec2(1.6, 1.0);
  float ld = length(lp);
  col += uLamp * uLampI * (smoothstep(0.07, 0.05, ld) * 0.45 + exp(-ld * ld * 22.0) * 0.5 + exp(-ld * 5.0) * 0.12);
  // monstera leaves, blurred into soft shapes against the wall
  float leaves = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    vec2 c = vec2(0.92 + 0.05 * sin(fi * 2.1), 0.3 + fi * 0.085);
    c.x += sin(t * 0.2 + fi) * 0.003;
    float e = length((uv - c) * vec2(1.0, 1.5) * mat2(cos(fi), -sin(fi), sin(fi), cos(fi)));
    leaves = max(leaves, smoothstep(0.075, 0.03, e));
  }
  col *= 1.0 - leaves * 0.45;
  // dream mist: slow folding veils
  vec2 q = uv * vec2(2.2, 1.4);
  vec2 w = vec2(fbm(q + t * 0.012 * uFloat), fbm(q + 4.0 - t * 0.01 * uFloat));
  float mist = smoothstep(0.35, 0.9, fbm(q * 1.3 + w * 1.6 + vec2(t * 0.02 * uFloat, 0.0)));
  col = mix(col, uMist * (0.35 + 0.5 * uBright), mist * uMistAmt * 0.55);
  // far bokeh: soft discs drifting through the dark
  for (int i = 0; i < 18; i++) {
    float fi = float(i);
    float h1 = hash(vec2(fi, 2.0)), h2 = hash(vec2(fi, 5.0)), h3 = hash(vec2(fi, 9.0));
    vec2 c = vec2(fract(h1 + t * 0.003 * (0.5 + h3)), fract(h2 + t * 0.006 * (0.4 + h1)));
    float r = mix(0.008, 0.026, h3);
    float d = length((uv - c) * vec2(1.6, 1.0)) / r;
    float disc = smoothstep(1.0, 0.8, d) * (0.6 + 0.4 * smoothstep(0.5, 1.0, d));
    vec3 bc = mix(uDream, uDream2, h2);
    col += bc * disc * mix(0.06, 0.02, h3) * (0.6 + 0.4 * sin(t * (0.2 + h1) + fi));
  }
  // slow clouds of light high in the dream, thin rays falling from the window through them
  vec2 cq = uv * vec2(1.8, 1.0) + vec2(t * 0.004 * uFloat, 0.0);
  float lc = smoothstep(0.55, 0.95, fbm(cq * 1.7 + fbm(cq * 2.3 - t * 0.006) * 0.8)) * smoothstep(0.35, 0.9, uv.y);
  col += mix(uGlow, uDream, 0.4) * lc * 0.09 * (0.4 + uBright * 0.6);
  vec2 rp = uv - vec2(0.86, 0.9);
  float ang = atan(rp.y, rp.x);
  float rays = pow(noise(vec2(ang * 22.0, t * 0.03)), 5.0) * smoothstep(0.0, 0.4, length(rp)) * smoothstep(1.2, 0.3, length(rp)) * step(rp.y, 0.0);
  col += uGlow * rays * 0.12 * (0.2 + uMoon);
  col += uGlow * uLift * 0.25;
  float vig = smoothstep(1.1, 0.35, length((uv - vec2(0.48, 0.52)) * vec2(1.1, 1.3)));
  col *= mix(0.55, 1.0, vig);
  gl_FragColor = vec4(col * uReveal, 1.0);
}
`;

const beamFrag = /* glsl */ `
uniform vec3 uCol; uniform float uI; uniform float uTime; uniform float uReveal;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
void main() {
  float across = (vUv.x - 0.5) * 2.0;
  float soft = exp(-across * across * 3.0);
  float along = vUv.y; // 0 at the chair, 1 up toward the window
  // it lives in the air: gone by the time it reaches the chair (and never lays light on Fiba)
  float fade = smoothstep(0.16, 0.5, along) * smoothstep(1.0, 0.55, along);
  float n = 0.75 + 0.25 * noise(vec2(across * 3.0 + uTime * 0.05, along * 6.0 - uTime * 0.08));
  // very thin shafts inside the beam, slowly sliding sideways (light through a dusty window)
  float shafts = pow(noise(vec2(across * 14.0 + uTime * 0.03, 0.5)), 4.0) * 1.6 + pow(noise(vec2(across * 31.0 - uTime * 0.02, 3.5)), 6.0) * 1.2;
  gl_FragColor = vec4(uCol * soft * fade * (n + shafts * smoothstep(0.1, 0.5, along)) * uI * uReveal * 0.09, 1.0);
}
`;

const moteVert = /* glsl */ `
attribute vec3 iPos; attribute vec4 iCol; attribute vec4 iMisc; // size, shape, rotation, stretch
varying vec2 vUv; varying vec4 vCol; varying float vShape;
void main() {
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float c = cos(iMisc.z), s = sin(iMisc.z);
  vec2 q = vec2(position.x * iMisc.w, position.y);
  q = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
  vec3 wp = iPos + (right * q.x + up * q.y) * iMisc.x;
  vUv = uv; vCol = iCol; vShape = iMisc.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;
const moteFrag = /* glsl */ `
varying vec2 vUv; varying vec4 vCol; varying float vShape;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r2 = dot(p, p);
  float a;
  if (vShape < 0.5) {            // orb: bright core, soft halo
    a = exp(-r2 * 30.0) * 1.6 + exp(-r2 * 5.0) * 0.35;
  } else if (vShape < 1.5) {     // glint: a four-pointed twinkle
    float crs = exp(-abs(p.x) * 26.0) * exp(-p.y * p.y * 3.0) + exp(-abs(p.y) * 26.0) * exp(-p.x * p.x * 3.0);
    a = crs * 0.9 + exp(-r2 * 45.0) * 1.5 + exp(-r2 * 6.0) * 0.15;
  } else if (vShape < 2.5) {     // petal: a soft translucent leaf of light
    float d = length(p * vec2(1.0, 2.2));
    a = (smoothstep(1.0, 0.35, d) * 0.6 + exp(-r2 * 25.0) * 0.6) * 0.8;
  } else if (vShape < 3.5) {     // streak: a thin line of passing light
    a = exp(-p.y * p.y * 90.0) * smoothstep(1.0, 0.2, abs(p.x)) * (0.5 + 0.5 * p.x) * 1.4;
  } else if (vShape < 4.5) {     // halo: a fine ring with a faint iridescent film inside
    float r = sqrt(r2);
    a = exp(-pow((r - 0.72) * 7.0, 2.0)) * 0.55 + smoothstep(0.8, 0.0, r) * 0.05;
  } else if (vShape < 5.5) {     // bloom: a big soft cloud of light, no core at all
    a = exp(-r2 * 2.6) * 0.5 * smoothstep(1.0, 0.6, sqrt(r2));
  } else {                       // spark: a tiny bright point with a short fading tail
    a = exp(-r2 * 160.0) * 2.0 + exp(-p.y * p.y * 300.0) * smoothstep(0.05, -0.8, p.x) * (1.0 + p.x) * 0.5;
  }
  a *= vCol.a;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vCol.rgb * a, a);
}
`;

export class FibaWorld implements World {
  readonly id = 'fiba' as const;
  readonly title = 'World 02 — FIBA';
  readonly pads: PadGesture[] = ['swell', 'dust', 'purr', 'wake', 'bloom', 'pulse', 'stretch', 'lift'];
  readonly labels: ParamLabels = {
    world: { label: 'Hour', lo: 'deep night', hi: 'first light' },
    weather: { label: 'Mist', lo: 'clear dream', hi: 'misty dream' },
    energy: { label: 'Restless', lo: 'deep sleep', hi: 'restless' },
    space: { label: 'Distance', lo: 'close-up', hi: 'wide dream' },
    texture: { label: 'Sparkle', lo: 'soft glow', hi: 'glittering' },
    motion: { label: 'Float', lo: 'still', hi: 'floating' },
    color: { label: 'Palette', lo: 'moon linen', hi: 'amber night' },
    chaos: { label: 'Wonder', lo: 'calm', hi: 'whimsical' },
    atmos: { label: 'Lullaby', lo: 'silent', hi: 'music box' },
    rain: { label: 'Dust', lo: 'clean air', hi: 'dusty light' },
    fog: { label: 'Moonbeam', lo: 'no moon', hi: 'bright moon' },
    drone: { label: 'Purr', lo: 'silent', hi: 'deep purr' },
  };

  private renderer!: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(13.7, 1, 0.1, 30);
  private composer!: EffectComposer;
  private bloom!: UnrealBloomPass;
  private finish!: ShaderPass;
  private disposables: { dispose(): void }[] = [];
  private unsubs: (() => void)[] = [];
  private pal = createPalette();
  private macros: Macros | null = null;
  private reveal = 0;
  private compiled = false;

  get ready(): boolean {
    return this.compiled;
  }
  /** real seconds (kept for scheduling); shader clocks are wrapped separately */
  private time = 0;
  private ftime = 0;
  private height = 1;

  private rig = new CatRig();
  private catGroup = new Group();
  private catMat!: ShaderMaterial;
  private whiskers!: LineSegments;
  private whiskerBase: Vector3[] = [];
  private contact!: Mesh;
  private lamp!: PointLight;
  private moon!: DirectionalLight;
  private hemi!: HemisphereLight;
  private backdrop!: ShaderMaterial;
  private beam!: Mesh;
  private beamMat!: ShaderMaterial;
  private floorMat!: MeshStandardMaterial;
  private dustU!: Record<string, IUniform>;
  private bokehU!: Record<string, IUniform>;
  private motes: Mote[] = [];
  private mPos!: InstancedBufferAttribute;
  private mCol!: InstancedBufferAttribute;
  private mMisc!: InstancedBufferAttribute;
  private drift = 0;
  private lampPulse = 0;
  private moonPulse = 0;
  /** pulse targets: the light swells toward them (a pad never switches the exposure in one frame) */
  private lampPulseT = 0;
  private moonPulseT = 0;
  private lift = 0;
  private liftTarget = 0;
  private liftMid = 0;
  private lampPulseM = 0;
  private moonPulseM = 0;
  private purrGlow = 0;
  private dustKick = 0;
  private mod = 0;
  private modTarget = 0;
  private nextStreak = 8;
  private layers!: DreamLayers;
  /** a short swell of the whole dream air after chords and big pads */
  private airPulse = 0;
  /** recent note-on times, to recognise chords (several keys within a few ms) */
  private recent: { t: number; pn: number; vel: number }[] = [];
  private nextChordEvent = 0;
  private chordFlip = 0;
  /** Test hook: a fixed camera. */
  debugView: { pos: number[]; target: number[] } | null = null;
  private tmpM = new Matrix4();
  private tmpV = new Vector3();
  private tmpV2 = new Vector3();
  private tmpV3 = new Vector3();
  private tmpC = new Color();
  private tmpC2 = new Color();
  private inv = new Matrix4();
  private headWorld = new Vector3();

  // ------------------------------------------------------------------ build

  mount(renderer: WebGLRenderer): void {
    this.renderer = renderer;
    renderer.toneMapping = AgXToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    const pmrem = new PMREMGenerator(renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = env;
    this.scene.environmentIntensity = 0.05;
    this.disposables.push(env, pmrem);

    this.buildDreamRoom();
    this.buildChair();
    this.buildCat();
    this.buildAir();

    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new ShaderPass(sanitizeShader));
    this.bloom = new UnrealBloomPass(new Vector2(512, 512), 0.45, 0.8, 0.82);
    this.composer.addPass(this.bloom);
    this.finish = new ShaderPass(finishShader);
    this.composer.addPass(this.finish);
    this.composer.addPass(new OutputPass());

    // Compile every program in the background while the intro is still showing. The raymarched cat
    // takes ~6 s to compile on D3D; compiled on first use it froze the page right after Enter.
    // The scene is drawn by RenderPass into the composer's target (no tone mapping there), so the
    // programs must be compiled against that target to be the ones actually used.
    renderer.setRenderTarget(this.composer.readBuffer);
    renderer
      .compileAsync(this.scene, this.camera)
      .catch(() => undefined)
      .then(() => (this.compiled = true));
    renderer.setRenderTarget(null);

    this.unsubs.push(
      bus.on('note:on', (e) => this.onNote(e)),
      bus.on('pad', (e) => this.onPad(e.gesture, e.velocity)),
      bus.on('lullaby', (e) => this.onLullaby(e.note, e.velocity)),
      bus.on('drip', () => (this.dustKick = Math.max(this.dustKick, 0.15))),
      bus.on('cat:move', (e) => (this.dustKick = Math.max(this.dustKick, e.strength))),
      bus.on('expression', (e) => (this.modTarget = e.mod)),
    );
  }

  private std(opts: ConstructorParameters<typeof MeshStandardMaterial>[0]): MeshStandardMaterial {
    const m = new MeshStandardMaterial(opts);
    this.disposables.push(m);
    return m;
  }

  private keep<T extends { dispose(): void }>(x: T): T {
    this.disposables.push(x);
    return x;
  }

  /** Not a room: a soft dream of one. A blurred backdrop, a pool of floor, a moonbeam. */
  private buildDreamRoom(): void {
    this.backdrop = this.keep(
      new ShaderMaterial({
        uniforms: {
          uTime: { value: 0 }, uDeep: { value: new Color() }, uRoom: { value: new Color() }, uGlow: { value: new Color() },
          uMist: { value: new Color() }, uDream: { value: new Color() }, uDream2: { value: new Color() }, uLamp: { value: LAMP_COLOR.clone() },
          uBright: { value: 1 }, uMoon: { value: 0.5 }, uMistAmt: { value: 0.3 }, uLampI: { value: 1 }, uLift: { value: 0 },
          uReveal: { value: 0 }, uFloat: { value: 1 },
        },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: backdropFrag,
        depthWrite: false,
      }),
    );
    const back = new Mesh(this.keep(new PlaneGeometry(6.4, 3.6)), this.backdrop);
    back.position.set(-0.2, 1.1, -1.9);
    back.renderOrder = -10;
    this.scene.add(back);

    // a small pool of floor under the chair, fading into the dream
    const floorTex = this.keep(oakFloor());
    this.floorMat = this.std({ map: floorTex, roughness: 0.7, transparent: true });
    this.floorMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vFloorPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFloorPos = position;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vFloorPos;')
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>
          gl_FragColor.a *= smoothstep(1.35, 0.35, length(vFloorPos.xz * vec2(0.85, 1.1)));`);
    };
    const floor = new Mesh(this.keep(new PlaneGeometry(3, 3).rotateX(-Math.PI / 2)), this.floorMat);
    floor.position.set(0, 0, -0.1);
    floor.receiveShadow = true;
    floor.renderOrder = -5;
    this.scene.add(floor);

    // lights: the lamp (warm, fixed), the moon (cool, the Moonbeam fader), a quiet ambient
    this.lamp = new PointLight(LAMP_COLOR, 1, 8, 2);
    this.lamp.position.copy(LAMP_POS);
    this.lamp.castShadow = true;
    this.lamp.shadow.mapSize.set(1024, 1024);
    this.lamp.shadow.bias = -0.002;
    // soft penumbra: the low lamp throws the arm supports onto the back cushion; hard edges read as
    // jagged teeth there
    this.lamp.shadow.radius = 5;
    this.lamp.shadow.radius = 3;
    this.scene.add(this.lamp);
    this.moon = new DirectionalLight(MOON_COLOR, 0.6);
    this.moon.position.copy(MOON_FROM);
    this.moon.target.position.set(0, SEAT_TOP, 0);
    this.moon.castShadow = true;
    this.moon.shadow.mapSize.set(1024, 1024);
    const sc = this.moon.shadow.camera;
    sc.left = -1.5; sc.right = 1.5; sc.top = 1.5; sc.bottom = -1.5; sc.near = 0.5; sc.far = 8;
    this.moon.shadow.bias = -0.001;
    this.moon.shadow.radius = 3;
    this.moon.shadow.radius = 3;
    this.scene.add(this.moon, this.moon.target);
    this.hemi = new HemisphereLight(0x8090a8, 0x2a2420, 0.2);
    this.scene.add(this.hemi);

    // the moonbeam itself: a soft ribbon of light from high on the right down onto the chair
    this.beamMat = this.keep(
      new ShaderMaterial({
        uniforms: { uCol: { value: MOON_COLOR.clone() }, uI: { value: 0.5 }, uTime: { value: 0 }, uReveal: { value: 0 } },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: beamFrag,
        transparent: true,
        depthWrite: false,
        // no depth test: the ribbon passes through the chair back, and a depth-tested plane showed that
        // intersection as hard jagged edges; as faint air-light it may overlay the back
        depthTest: false,
        blending: AdditiveBlending,
        side: DoubleSide,
      }),
    );
    const base = FOCUS.clone().setY(SEAT_TOP + 0.05);
    const beamLen = MOON_FROM.distanceTo(base) * 0.9;
    this.beam = new Mesh(this.keep(new PlaneGeometry(0.75, beamLen).translate(0, beamLen / 2, 0)), this.beamMat);
    this.beam.position.copy(base);
    this.beam.matrixAutoUpdate = false;
    this.beam.renderOrder = 9;
    this.scene.add(this.beam);
  }

  private buildChair(): void {
    this.scene.add(buildFibaChair(SEAT_TOP, this.disposables));
  }

  private buildCat(): void {
    const rig = this.rig;
    this.catGroup.position.set(-0.005, SEAT_TOP, 0.005);
    this.catGroup.rotation.y = -0.20;
    this.catGroup.scale.setScalar(CAT_SCALE);
    this.scene.add(this.catGroup);
    const boxMin = new Vector3(-0.66, -0.22, -0.34);
    const boxMax = new Vector3(0.48, 0.32, 0.34);
    this.catMat = this.keep(
      new ShaderMaterial({
        vertexShader: catVertex,
        fragmentShader: catFragment,
        uniforms: {
          uPart: { value: rig.part }, uPartR: { value: rig.partR },
          uLimbA: { value: rig.limbA }, uLimbM: { value: rig.limbM }, uLimbB: { value: rig.limbB },
          uTail: { value: rig.tail }, uHeadPos: { value: rig.headPos }, uHeadRot: { value: rig.headRot },
          uEars: { value: rig.ears }, uEyes: { value: rig.eyes }, uStretch: { value: 0 },
          uCamLocal: { value: new Vector3() }, uBoxMin: { value: boxMin }, uBoxMax: { value: boxMax },
          uKeyPos: { value: new Vector3() }, uKeyColor: { value: new Color() },
          uFillDir: { value: new Vector3() }, uFillColor: { value: new Color() },
          uAmbient: { value: new Color() }, uGround: { value: new Color() }, uRimColor: { value: new Color() },
          uReveal: { value: 0 }, uFogColor: { value: new Color() }, uFog: { value: 0 }, uClip: { value: new Matrix4() },
        },
        transparent: true, // for the soft fur fringe
        blending: NormalBlending,
      }),
    );
    const size = boxMax.clone().sub(boxMin);
    const proxy = this.keep(new BoxGeometry(size.x, size.y, size.z));
    proxy.translate((boxMin.x + boxMax.x) / 2, (boxMin.y + boxMax.y) / 2, (boxMin.z + boxMax.z) / 2);
    const catMesh = new Mesh(proxy, this.catMat);
    catMesh.renderOrder = 5;
    this.catGroup.add(catMesh);

    const wpos: number[] = [];
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const base = new Vector3(side * 0.016, -0.025 - i * 0.0025, 0.053);
        const tip = base.clone().add(new Vector3(side * 0.046, 0.007 - i * 0.009, 0.008 - i * 0.002));
        base.multiplyScalar(1.08); tip.multiplyScalar(1.08);
        this.whiskerBase.push(base, tip);
        wpos.push(0, 0, 0, 0, 0, 0);
      }
    }
    const wg = this.keep(new BufferGeometry());
    wg.setAttribute('position', new BufferAttribute(new Float32Array(wpos), 3));
    this.whiskers = new LineSegments(wg, this.keep(new LineBasicMaterial({ color: 0xe8e0d4, transparent: true, opacity: 0.22, depthWrite: false })));
    this.whiskers.renderOrder = 6;
    this.catGroup.add(this.whiskers);

    this.contact = new Mesh(
      this.keep(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2)),
      this.keep(new ShaderMaterial({
        uniforms: {
          uHip: { value: rig.part[0] }, uRib: { value: rig.part[1] },
          uPaw0: { value: rig.limbB[0] }, uPaw1: { value: rig.limbB[1] },
          uHead: { value: rig.headPos },
        },
        vertexShader: `varying vec2 vSeat; void main(){ vSeat=position.xz; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
        fragmentShader: `
          varying vec2 vSeat;
          uniform vec4 uHip,uRib,uPaw0,uPaw1;
          uniform vec3 uHead;
          float contactSpot(vec2 centre,vec2 radius) { vec2 q=(vSeat-centre)/radius; return exp(-dot(q,q)*2.4); }
          void main(){
            float a=contactSpot(uHip.xz,vec2(0.14,0.11))*0.36;
            a+=contactSpot(uRib.xz,vec2(0.13,0.10))*0.27;
            a+=contactSpot(uHead.xz,vec2(0.06,0.052))*max(0.08,0.60-uHead.y*3.0);
            a+=contactSpot(uPaw0.xz,vec2(0.038,0.041))*max(0.0,0.50-uPaw0.y*6.0);
            a+=contactSpot(uPaw1.xz,vec2(0.034,0.039))*max(0.0,0.50-uPaw1.y*6.0);
            gl_FragColor=vec4(0.025,0.018,0.014,min(a,0.65));
          }`,
        transparent: true,
        depthWrite: false,
      })),
    );
    this.contact.position.set(0, 0.001, 0);
    this.contact.scale.set(1, 1, 1);
    this.contact.renderOrder = 4;
    this.catGroup.add(this.contact);
  }

  private buildAir(): void {
    // ---- dust: many motes of different size and softness; out-of-focus ones grow into bokeh
    const seeds = new Float32Array(DUST * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    const g = this.keep(new BufferGeometry());
    g.setAttribute('position', new BufferAttribute(new Float32Array(DUST * 3), 3));
    g.setAttribute('aSeed', new BufferAttribute(seeds, 4));
    this.dustU = {
      uTime: { value: 0 }, uDrift: { value: 0 }, uKick: { value: 0 }, uAmount: { value: 0.5 },
      uMoonCol: { value: MOON_COLOR.clone() }, uMoonI: { value: 0.5 }, uMoonFrom: { value: MOON_FROM }, uFocus: { value: FOCUS },
      uLampPos: { value: LAMP_POS }, uLampCol: { value: LAMP_COLOR.clone() }, uBase: { value: new Color() }, uTint: { value: new Color() },
      uPixel: { value: 400 }, uReveal: { value: 0 }, uCamDist: { value: 3.8 },
    };
    const dust = new Points(g, this.keep(new ShaderMaterial({
      uniforms: this.dustU,
      vertexShader: /* glsl */ `
        attribute vec4 aSeed;
        uniform float uTime; uniform float uDrift; uniform float uKick; uniform float uAmount;
        uniform vec3 uMoonCol; uniform float uMoonI; uniform vec3 uMoonFrom; uniform vec3 uFocus;
        uniform vec3 uLampPos; uniform vec3 uLampCol; uniform vec3 uBase; uniform vec3 uTint;
        uniform float uPixel; uniform float uCamDist;
        varying vec3 vCol; varying float vA; varying float vSoft;
        void main() {
          vec3 box = vec3(2.6, 1.7, 2.2);
          vec3 p = fract(aSeed.xyz + vec3(uDrift * 0.011, uDrift * 0.006 * (aSeed.w - 0.25), uDrift * 0.007)) * box + vec3(-1.3, 0.05, -1.1);
          float ph = aSeed.w * 6.2831;
          p += vec3(sin(uTime * 0.21 + ph), sin(uTime * 0.17 + ph * 1.3), cos(uTime * 0.19 + ph)) * 0.04;
          vec3 dc = p - uFocus;
          p += normalize(dc + 1e-4) * uKick * 0.1 * exp(-dot(dc, dc) * 3.0);
          vec3 axis = normalize(uFocus - uMoonFrom);
          vec3 rel = p - uMoonFrom;
          vec3 perp = rel - axis * dot(rel, axis);
          float inBeam = exp(-dot(perp, perp) / 0.07);
          vec3 dl = p - uLampPos;
          float nearLamp = 0.35 / (1.0 + dot(dl, dl) * 4.0);
          float size01 = pow(fract(aSeed.w * 13.1), 3.0);
          float bright = 0.3 + 0.7 * fract(aSeed.w * 7.7);
          vCol = (uBase * 0.35 + uTint * 0.25 + uMoonCol * uMoonI * inBeam * 2.2 + uLampCol * nearLamp) * bright;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          float depth = max(-mv.z, 0.2);
          float coc = abs(depth - uCamDist) * 0.9;
          vSoft = clamp(coc * 1.4, 0.0, 1.0);
          float visible = clamp((uAmount - fract(aSeed.w * 3.3)) / 0.08, 0.0, 1.0);
          vA = visible * (0.55 + 0.45 * sin(uTime * (0.4 + aSeed.w) + ph * 3.0)) / (1.0 + coc * coc * 3.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(((0.8 + size01 * 3.5) * 0.004 + coc * 0.02) * uPixel / depth * 3.8, 1.0, 40.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uReveal; varying vec3 vCol; varying float vA; varying float vSoft;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float sharp = exp(-d * d * 9.0);
          float disc = smoothstep(1.0, 0.8, d) * (0.5 + 0.5 * d);
          float a = mix(sharp, disc * 0.6, vSoft) * vA * uReveal;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vCol * a, a);
        }`,
      transparent: true, depthWrite: false, blending: AdditiveBlending,
    })));
    dust.frustumCulled = false;
    dust.renderOrder = 8;
    this.scene.add(dust);

    // ---- foreground bokeh: a few large soft lights between us and her, far out of focus
    const bs = new Float32Array(BOKEH * 4);
    for (let i = 0; i < bs.length; i++) bs[i] = Math.random();
    const bg = this.keep(new BufferGeometry());
    bg.setAttribute('position', new BufferAttribute(new Float32Array(BOKEH * 3), 3));
    bg.setAttribute('aSeed', new BufferAttribute(bs, 4));
    this.bokehU = { uTime: { value: 0 }, uCol: { value: new Color() }, uCol2: { value: new Color() }, uPixel: { value: 400 }, uReveal: { value: 0 }, uAmt: { value: 0.5 } };
    const bokeh = new Points(bg, this.keep(new ShaderMaterial({
      uniforms: this.bokehU,
      vertexShader: /* glsl */ `
        attribute vec4 aSeed; uniform float uTime; uniform float uPixel; uniform vec3 uCol; uniform vec3 uCol2;
        varying vec3 vCol; varying float vA;
        void main() {
          vec3 p = vec3((aSeed.x - 0.5) * 1.6, 0.2 + aSeed.y * 1.2, 1.2 + aSeed.z * 1.6);
          p.x += sin(uTime * 0.05 + aSeed.w * 6.28) * 0.08;
          p.y += fract(aSeed.w + uTime * 0.004) * 0.3;
          vCol = mix(uCol, uCol2, aSeed.w);
          vA = 0.5 + 0.5 * sin(uTime * (0.1 + aSeed.w * 0.2) + aSeed.x * 9.0);
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp((0.025 + aSeed.w * 0.05) * uPixel / max(-mv.z, 0.2), 4.0, 140.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uReveal; uniform float uAmt; varying vec3 vCol; varying float vA;
        void main() { float d = length(gl_PointCoord - 0.5) * 2.0; float disc = smoothstep(1.0, 0.85, d) * (0.55 + 0.45 * d);
          float a = disc * vA * 0.012 * uAmt * uReveal; if (a < 0.002) discard; gl_FragColor = vec4(vCol * a, a); }`,
      transparent: true, depthWrite: false, blending: AdditiveBlending,
    })));
    bokeh.frustumCulled = false;
    bokeh.renderOrder = 12;
    this.scene.add(bokeh);

    this.layers = new DreamLayers(this.scene);
    this.disposables.push(this.layers);

    // ---- dream motes: the note reactions, floating in the air around and above her
    for (let i = 0; i < MOTES; i++) {
      this.motes.push({ x: 0, y: -9, z: 0, vx: 0, vy: 0, vz: 0, age: 9, life: 1, size: 0.02, intensity: 0, shape: 0, spin: 0, rot: 0, col: new Color() });
    }
    const quad = this.keep(new PlaneGeometry(1, 1));
    const geo = this.keep(new InstancedBufferGeometry());
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    this.mPos = new InstancedBufferAttribute(new Float32Array(MOTES * 3), 3);
    this.mCol = new InstancedBufferAttribute(new Float32Array(MOTES * 4), 4);
    this.mMisc = new InstancedBufferAttribute(new Float32Array(MOTES * 4), 4);
    geo.setAttribute('iPos', this.mPos);
    geo.setAttribute('iCol', this.mCol);
    geo.setAttribute('iMisc', this.mMisc);
    geo.instanceCount = MOTES;
    const motes = new Mesh(geo, this.keep(new ShaderMaterial({
      vertexShader: moteVert, fragmentShader: moteFrag, transparent: true, depthWrite: false, blending: AdditiveBlending,
    })));
    motes.frustumCulled = false;
    motes.renderOrder = 11;
    this.scene.add(motes);
  }

  // ------------------------------------------------------------------ note reactions

  /** SPARKLE (texture) turns soft orbs into petals and glints. */
  private pickShape(m: Macros): number {
    const sp = m.texture;
    const r = Math.random();
    if (r < lerp(0.75, 0.15, sp)) return MOTE_ORB;
    if (r < lerp(0.9, 0.55, sp)) return MOTE_PETAL;
    return MOTE_GLINT;
  }

  private spawnMote(x: number, y: number, z: number, o: { size: number; intensity: number; life: number; shape: number; col: Color; vy?: number; vx?: number; vz?: number }): void {
    let s = this.motes[0];
    let worst = -1;
    for (const q of this.motes) {
      const used = q.age / q.life;
      if (used >= 1) { s = q; break; }
      if (used > worst) { worst = used; s = q; }
    }
    const m = this.macros!;
    const float = lerp(0.3, 1.6, m.motion);
    s.x = x; s.y = y; s.z = z;
    s.vx = o.vx ?? (Math.random() - 0.5) * 0.03 * (1 + m.chaos * 2);
    s.vy = (o.vy ?? 0.012 + Math.random() * 0.018) * float;
    s.vz = o.vz ?? (Math.random() - 0.5) * 0.02;
    s.age = 0;
    s.life = o.life * lerp(1.2, 0.8, m.motion);
    s.size = o.size;
    s.intensity = o.intensity;
    s.shape = o.shape;
    s.rot = Math.random() * Math.PI * 2;
    s.spin = (Math.random() - 0.5) * (s.shape === MOTE_PETAL ? 0.8 : 0.3);
    s.col.copy(o.col);
  }

  private onNote(e: NoteOn): void {
    const m = this.macros;
    if (!m) return;
    const pn = pitchNorm(e.note);
    const vel = e.velocity;
    const played = e.source !== 'generative' && e.source !== 'pad';
    this.rig.onNote(pn, vel, played);
    this.dustKick = Math.max(this.dustKick, vel * 0.25);
    // Every note leaves something in the air — never on her. What it leaves depends on the
    // register: low notes bloom big, slow, warm and low; the middle floats orbs, halos and petals;
    // high notes throw quick sparks and glints near her head. Velocity sets size and count,
    // WONDER the spread, SPARKLE the shapes. Several keys at once make a rarer composite event.
    const head = this.headWorld;
    const P = this.pal;
    const spread = lerp(0.18, 0.42, m.chaos) * lerp(1.3, 0.8, pn);
    const hue = (j: number) => Math.min(1, Math.max(0, pn + (j - 0.5) * m.chaos * 0.9));
    if (pn < 0.36) {
      const low = 1 - pn / 0.36;
      const n = vel > 0.6 && played ? 2 : 1;
      for (let i = 0; i < n; i++) {
        this.spawnMote(lerp(-0.25, 0.2, Math.random()), SEAT_TOP + 0.05 + Math.random() * 0.12, (Math.random() - 0.5) * 0.35 - 0.05, {
          size: lerp(0.16, 0.3, low) * lerp(0.75, 1.15, vel),
          intensity: lerp(0.2, 0.4, vel) * (played ? 1 : 0.6),
          life: lerp(6, 9, low),
          shape: MOTE_BLOOM,
          col: this.tmpC.copy(P.dream).lerp(LAMP_COLOR, 0.45 * low).lerp(P.dream2, hue(Math.random()) * 0.3),
          vy: 0.006, vx: (Math.random() - 0.5) * 0.02, vz: 0,
        });
      }
      // and a slow orb rising out of it
      if (vel > 0.35) this.spawnMote(lerp(-0.15, 0.1, Math.random()), SEAT_TOP + 0.12, 0.05, { size: 0.06, intensity: 0.35 * vel, life: 6, shape: MOTE_ORB, col: this.tmpC.copy(P.dream).lerp(LAMP_COLOR, 0.3), vy: 0.01 });
    } else if (pn < 0.68) {
      const n = 1 + Math.round(vel * (played ? 2.2 : 1.0));
      for (let i = 0; i < n; i++) {
        const y = SEAT_TOP + lerp(0.16, 0.3, pn) + Math.random() * 0.08;
        const x = lerp(-0.08, head.x, pn) + (Math.random() - 0.5) * spread * 1.4;
        const z = 0.03 + (Math.random() - 0.5) * spread;
        const shape = i === 0 && Math.random() < lerp(0.12, 0.3, vel) ? MOTE_HALO : this.pickShape(m);
        this.spawnMote(x, y, z, {
          size: shape === MOTE_HALO ? lerp(0.07, 0.11, vel) : lerp(0.06, 0.035, pn) * lerp(0.7, 1.2, vel),
          intensity: (shape === MOTE_HALO ? 0.28 : lerp(0.35, 0.75, vel)) * (played ? 1 : 0.6),
          life: shape === MOTE_HALO ? 4.5 : lerp(5, 3.5, pn),
          shape,
          col: this.tmpC.copy(P.dream).lerp(P.dream2, hue(Math.random())),
        });
      }
    } else {
      const hi = (pn - 0.68) / 0.32;
      const n = 2 + Math.round(vel * (played ? 3 : 1.5));
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = lerp(0.05, 0.12, vel) * lerp(0.8, 1.3, hi);
        const spark = Math.random() < lerp(0.4, 0.7, m.texture);
        this.spawnMote(head.x + (Math.random() - 0.5) * 0.2, head.y + 0.1 + Math.random() * 0.1, head.z + (Math.random() - 0.5) * 0.12, {
          size: spark ? lerp(0.03, 0.045, vel) : lerp(0.022, 0.035, vel),
          intensity: lerp(0.5, 0.9, vel) * (played ? 1 : 0.6),
          life: lerp(2.2, 1.4, hi) + Math.random() * 0.6,
          shape: spark ? MOTE_SPARK : MOTE_GLINT,
          col: this.tmpC.copy(P.dream2).lerp(P.dream, Math.random() * 0.4).lerp(this.tmpC2.setRGB(1, 1, 1), 0.25),
          vx: Math.cos(a) * sp, vy: Math.abs(Math.sin(a)) * sp * 0.8 + 0.02, vz: (Math.random() - 0.5) * sp * 0.4,
        });
      }
    }
    if (played) this.chordCheck(pn, vel);
  }

  /** Several keys pressed together (within 60 ms) now and then open a composite event. */
  private chordCheck(pn: number, vel: number): void {
    const now = this.time;
    this.recent = this.recent.filter((r) => now - r.t < 0.06);
    this.recent.push({ t: now, pn, vel });
    if (this.recent.length < 3 || now < this.nextChordEvent) return;
    const notes = this.recent;
    const lo = Math.min(...notes.map((r) => r.pn));
    const hi = Math.max(...notes.map((r) => r.pn));
    const v = notes.reduce((a, r) => a + r.vel, 0) / notes.length;
    this.recent = [];
    this.nextChordEvent = now + lerp(3.5, 2, this.macros!.chaos);
    this.airPulse = Math.min(1, this.airPulse + 0.4 + v * 0.4);
    const P = this.pal;
    const head = this.headWorld;
    const kind = this.chordFlip++ % 3;
    if (kind === 0) {
      // a constellation: an arc of stars over her, joined by faint threads of light
      const n = Math.min(9, 4 + notes.length);
      const cx = lerp(-0.1, head.x, 0.5);
      const cy = SEAT_TOP + 0.36 + (lo + hi) * 0.1;
      let px = 0;
      let py = 0;
      for (let i = 0; i < n; i++) {
        const a = Math.PI * (0.15 + 0.7 * (i / (n - 1)));
        const x = cx + Math.cos(a) * 0.3 * (1 + (hi - lo) * 0.4);
        const y = cy + Math.sin(a) * 0.1 + (Math.random() - 0.5) * 0.03;
        this.spawnMote(x, y, 0.02, { size: 0.035, intensity: 0.8 * v, life: 5, shape: MOTE_GLINT, col: this.tmpC.copy(P.dream2).lerp(P.dream, i / n), vx: 0, vy: 0.004, vz: 0 });
        if (i > 0) {
          // the thread: a streak laid between the two stars (its direction comes from the velocity)
          const len = Math.hypot(x - px, y - py);
          this.spawnMote((x + px) / 2, (y + py) / 2, 0.02, { size: len * 0.2, intensity: 0.22 * v, life: 4.5, shape: MOTE_STREAK, col: this.tmpC.copy(P.dream), vx: (x - px) * 1e-3, vy: (y - py) * 1e-3, vz: 0 });
        }
        px = x;
        py = y;
      }
    } else if (kind === 1) {
      // a great slow halo opening above her, with smaller ones inside
      for (let i = 0; i < 3; i++) {
        this.spawnMote(head.x - 0.05, SEAT_TOP + 0.3, 0.03, { size: 0.16 + i * 0.09, intensity: 0.3 * v * (1 - i * 0.2), life: 5 + i, shape: MOTE_HALO, col: this.tmpC.copy(P.dream).lerp(P.dream2, i / 2), vx: 0, vy: 0.008, vz: 0 });
      }
    } else {
      // a slow spiral of petals and orbs rising from the seat around her
      const n = 10 + notes.length * 2;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 4;
        const r = 0.12 + (i / n) * 0.2;
        this.spawnMote(-0.02 + Math.cos(a) * r, SEAT_TOP + 0.1 + (i / n) * 0.3, 0.03 + Math.sin(a) * r * 0.5, { size: 0.045, intensity: 0.5 * v, life: 5.5, shape: i % 3 ? MOTE_PETAL : MOTE_ORB, col: this.tmpC.copy(P.dream).lerp(P.dream2, i / n), vx: -Math.sin(a) * 0.03, vy: 0.02, vz: Math.cos(a) * 0.02 });
      }
    }
  }

  private onLullaby(note: number, vel: number): void {
    if (!this.macros) return;
    const pn = pitchNorm(note);
    const head = this.headWorld;
    this.spawnMote(head.x + (Math.random() - 0.5) * 0.5, SEAT_TOP + 0.3 + pn * 0.35, 0.03 + (Math.random() - 0.5) * 0.3, {
      size: 0.028, intensity: 0.35 + vel * 0.4, life: 2.6, shape: MOTE_GLINT, col: this.tmpC.copy(this.pal.dream2),
    });
  }

  private onPad(g: PadGesture, vel: number): void {
    if (!this.macros) return;
    this.rig.onPad(g, vel);
    const head = this.headWorld;
    const P = this.pal;
    const v = 0.5 + vel * 0.5;
    switch (g) {
      case 'swell': // an arc of warm orbs rising over her
        for (let i = 0; i < 10; i++) {
          const a = (i / 9) * Math.PI;
          this.spawnMote(Math.cos(a) * 0.32, SEAT_TOP + 0.12 + Math.sin(a) * 0.22, 0.05, { size: 0.06, intensity: 0.7 * v, life: 5, shape: MOTE_ORB, col: this.tmpC.copy(P.dream), vy: 0.025 });
        }
        break;
      case 'dust': // stardust: a spiral of glints falling round her from above
        for (let i = 0; i < 36; i++) {
          const a = i * 0.55;
          const r = 0.12 + i * 0.007;
          this.spawnMote(head.x - 0.08 + Math.cos(a) * r, SEAT_TOP + 0.7 - i * 0.012, 0.03 + Math.sin(a) * r * 0.6, {
            size: 0.03 + Math.random() * 0.03, intensity: 0.9 * v, life: 3.5 + Math.random() * 1.5, shape: MOTE_GLINT,
            col: this.tmpC.copy(P.dream2).lerp(P.dream, Math.random() * 0.5), vy: -0.04, vx: -Math.sin(a) * 0.03, vz: Math.cos(a) * 0.02,
          });
        }
        this.dustKick = 1;
        break;
      case 'purr': // contentment: the lamp warms, a few orbs circle slowly
        this.purrGlow = Math.min(1, this.purrGlow + 0.8);
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          this.spawnMote(head.x - 0.1 + Math.cos(a) * 0.22, SEAT_TOP + 0.2, 0.03 + Math.sin(a) * 0.14, { size: 0.05, intensity: 0.45 * v, life: 6, shape: MOTE_ORB, col: this.tmpC.copy(P.dream), vy: 0.012, vx: -Math.sin(a) * 0.04, vz: Math.cos(a) * 0.03 });
        }
        break;
      case 'wake':
        for (let i = 0; i < 4; i++) this.spawnMote(head.x + (Math.random() - 0.5) * 0.15, head.y + 0.1 + Math.random() * 0.1, head.z, { size: 0.03, intensity: 0.6 * v, life: 3, shape: MOTE_GLINT, col: this.tmpC.copy(P.dream2) });
        break;
      case 'bloom': // petals of light opening outward above her
        for (let i = 0; i < 14; i++) {
          const a = (i / 14) * Math.PI * 2;
          this.spawnMote(-0.02, SEAT_TOP + 0.4, 0.03, { size: 0.07, intensity: 0.6 * v, life: 5, shape: MOTE_PETAL, col: this.tmpC.copy(P.dream).lerp(P.dream2, i / 14), vx: Math.cos(a) * 0.09, vy: Math.sin(a) * 0.05 + 0.02, vz: Math.sin(a) * 0.03 });
        }
        break;
      case 'pulse': // the room breathes: lamp and moon swell once
        this.lampPulseT = 1;
        this.moonPulseT = 1;
        break;
      case 'stretch':
        this.dustKick = 1;
        break;
      case 'lift': // a moment of first light and a scatter of glints
        this.liftTarget = 1; // the light swells in over ~a second (never a jump in exposure)
        for (let i = 0; i < 12; i++) this.spawnMote((Math.random() - 0.5) * 0.9, SEAT_TOP + 0.2 + Math.random() * 0.5, (Math.random() - 0.5) * 0.4, { size: 0.03, intensity: 0.7, life: 3, shape: MOTE_GLINT, col: this.tmpC.copy(P.dream2) });
        break;
    }
  }

  // ------------------------------------------------------------------ frame

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

  paletteName(color: number): string {
    return paletteName(color);
  }

  frame(dt: number, m: Macros): void {
    this.macros = m;
    // until the shaders are ready nothing is drawn: a draw would block the page while they finish
    if (!this.compiled) return;
    const float = lerp(0.25, 1.8, m.motion);
    this.time += dt;
    // every shader clock is wrapped, so precision stays perfect however long the world runs
    this.ftime = (this.ftime + dt * float) % 3600;
    const st = this.time % 3600;
    const P = samplePalette(m.color, m.world, this.pal);
    this.mod += (this.modTarget - this.mod) * (1 - Math.exp(-dt / 0.2));
    const k = (tau: number) => Math.exp(-dt / tau);
    this.lampPulseT *= k(1.4);
    this.moonPulseT *= k(1.8);
    this.lampPulseM += (this.lampPulseT - this.lampPulseM) * (1 - k(0.2));
    this.moonPulseM += (this.moonPulseT - this.moonPulseM) * (1 - k(0.2));
    this.lampPulse += (this.lampPulseM - this.lampPulse) * (1 - k(0.2));
    this.moonPulse += (this.moonPulseM - this.moonPulse) * (1 - k(0.2));
    this.liftTarget *= k(2.5);
    // two cascaded smoothers: the swell starts with zero slope, so no frame ever jumps
    this.liftMid += (this.liftTarget - this.liftMid) * (1 - k(0.3));
    this.lift += (this.liftMid - this.lift) * (1 - k(0.3));
    this.purrGlow *= k(4);
    this.dustKick *= k(1.5);
    const rev = this.reveal;
    const hour = m.world;
    const morning = smooth(0.25, 1, hour);

    // ---- light: lamp (fixed warm), moon (Moonbeam fader), ambient (Hour)
    const lampI = lerp(1.0, 0.45, smooth(0.35, 1, hour)) * (1 + this.lampPulse * 0.7 + this.purrGlow * 0.3 + this.mod * 0.3) * (0.96 + 0.04 * Math.sin(st * 0.9));
    this.lamp.intensity = lampI * 2.4 * rev;
    const moonI = Math.pow(m.fog, 1.1) * 2.2 * (1 + this.moonPulse * 0.5);
    this.moon.intensity = moonI * rev;
    // the palette tints the light of the dream (chair, floor, air) — Fiba keeps her own neutral light
    this.moon.color.copy(MOON_COLOR).lerp(P.glow, 0.45);
    this.hemi.color.copy(P.glow).lerp(P.room, 0.35);
    this.hemi.groundColor.copy(P.room).multiplyScalar(0.6);
    this.hemi.intensity = (lerp(0.35, 1.3, morning) + this.lift * 0.6) * rev;
    this.scene.environmentIntensity = lerp(0.03, 0.2, morning);
    this.floorMat.color.setScalar(lerp(0.55, 1, morning));

    const bu = this.backdrop.uniforms;
    bu.uTime.value = this.ftime;
    bu.uDeep.value.copy(P.deep);
    bu.uRoom.value.copy(P.room);
    bu.uGlow.value.copy(P.glow);
    bu.uMist.value.copy(P.mist);
    bu.uDream.value.copy(P.dream);
    bu.uDream2.value.copy(P.dream2);
    bu.uBright.value = P.bright * (1 + this.lift * 0.5);
    bu.uMoon.value = m.fog * (1 + this.moonPulse * 0.4);
    bu.uMistAmt.value = lerp(0.05, 1, m.weather);
    bu.uLampI.value = lampI;
    bu.uLift.value = this.lift;
    bu.uReveal.value = rev;
    bu.uFloat.value = float;

    // ---- camera: ~100 mm portrait lens; DISTANCE steps back into a wider dream
    const t = this.ftime * 0.05;
    const dist = lerp(1.9, 4.4, m.space);
    const fov = lerp(16, 22, m.space);
    const dir = this.tmpV2.set(0.26, 0.26, 1).normalize();
    this.camera.position.copy(FOCUS).addScaledVector(dir, dist);
    this.camera.position.x += Math.sin(t * 0.7) * 0.04;
    this.camera.position.y += Math.sin(t * 1.1) * 0.02;
    this.camera.lookAt(FOCUS.x - 0.02, FOCUS.y + lerp(0.0, 0.16, m.space), FOCUS.z);
    if (this.debugView) {
      this.camera.position.fromArray(this.debugView.pos);
      this.camera.lookAt(this.tmpV2.fromArray(this.debugView.target));
    }
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();

    // moonbeam: a ribbon from the chair toward the moon, turned to face the camera
    const axis = this.tmpV.copy(MOON_FROM).sub(this.beam.position).normalize();
    const toCam = this.tmpV2.copy(this.camera.position).sub(this.beam.position);
    const side = this.tmpV3.crossVectors(axis, toCam).normalize();
    const face = toCam.crossVectors(side, axis).normalize();
    this.beam.matrix.makeBasis(side, axis, face).setPosition(this.beam.position);
    this.beam.matrixWorldNeedsUpdate = true;
    this.beamMat.uniforms.uI.value = m.fog * lerp(0.6, 1.4, m.weather) * (1 + this.moonPulse * 0.6);
    this.beamMat.uniforms.uTime.value = this.ftime;
    this.beamMat.uniforms.uReveal.value = rev;
    void Y_AXIS;

    // ---- Fiba: lit by the lamp and the moon, never by the palette (only a faint rim of it)
    this.rig.update(dt, m, float * 0.8);
    const cu = this.catMat.uniforms;
    this.catGroup.updateMatrixWorld();
    this.inv.copy(this.catGroup.matrixWorld).invert();
    cu.uCamLocal.value.copy(this.camera.position).applyMatrix4(this.inv);
    cu.uKeyPos.value.copy(LAMP_POS).applyMatrix4(this.inv);
    cu.uKeyColor.value.copy(LAMP_COLOR).multiplyScalar(lampI * 0.28);
    cu.uFillDir.value.copy(MOON_FROM).sub(this.catGroup.position).normalize().transformDirection(this.inv);
    cu.uFillColor.value.copy(MOON_COLOR).multiplyScalar(0.04 + moonI * 0.3);
    const ambI = lerp(0.20, 0.74, morning) + this.lift * 0.3;
    cu.uAmbient.value.setRGB(0.74, 0.72, 0.68).multiplyScalar(ambI);
    cu.uGround.value.setRGB(0.3, 0.27, 0.25).multiplyScalar(ambI);
    cu.uRimColor.value.copy(P.rim).lerp(this.tmpC.setRGB(0.7, 0.7, 0.72), 0.6).multiplyScalar(0.09 + 0.16 * m.fog);
    cu.uStretch.value = this.rig.stretch;
    cu.uReveal.value = rev;
    cu.uFogColor.value.copy(P.mist).multiplyScalar(0.3 * P.bright);
    cu.uFog.value = m.weather * 0.12;
    (cu.uClip.value as Matrix4).multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).multiply(this.catGroup.matrixWorld);
    this.headWorld.copy(this.rig.headPos);
    this.catGroup.localToWorld(this.headWorld);

    const hm = this.rig.headMatrix(this.tmpM);
    const wp = this.whiskers.geometry.getAttribute('position') as BufferAttribute;
    for (let i = 0; i < this.whiskerBase.length; i++) {
      const v = this.tmpV.copy(this.whiskerBase[i]).applyMatrix4(hm);
      wp.setXYZ(i, v.x, v.y, v.z);
    }
    wp.needsUpdate = true;
    (this.whiskers.material as LineBasicMaterial).opacity = 0.22 * rev;

    // ---- air
    this.drift = (this.drift + dt * float * (0.6 + m.energy * 0.8)) % 1000;
    const du = this.dustU;
    du.uTime.value = this.ftime;
    du.uDrift.value = this.drift;
    du.uKick.value = this.dustKick;
    du.uAmount.value = lerp(0.12, 1, m.rain);
    du.uMoonI.value = 0.15 + moonI * 0.8;
    du.uLampCol.value.copy(LAMP_COLOR).multiplyScalar(lampI);
    du.uBase.value.copy(P.mist).multiplyScalar(0.5 * P.bright);
    du.uTint.value.copy(P.dream);
    du.uPixel.value = this.height;
    du.uReveal.value = rev;
    du.uCamDist.value = this.camera.position.distanceTo(FOCUS);
    const bk = this.bokehU;
    bk.uTime.value = this.ftime;
    bk.uCol.value.copy(P.dream);
    bk.uCol2.value.copy(P.glow);
    bk.uPixel.value = this.height;
    bk.uReveal.value = rev;
    bk.uAmt.value = 0.4 + m.rain * 0.6 + m.weather * 0.4;

    // WONDER: now and then a shooting streak of light crosses the dream
    if (m.chaos > 0.35 && this.time > this.nextStreak) {
      const dx = Math.random() < 0.5 ? -1 : 1;
      this.spawnMote(-dx * 0.8, SEAT_TOP + 0.55 + Math.random() * 0.3, -0.3, { size: 0.18, intensity: 0.5, life: 1.6, shape: MOTE_STREAK, col: this.tmpC.copy(P.dream2), vx: dx * 0.9, vy: -0.12, vz: 0 });
      this.nextStreak = this.time + lerp(18, 4, (m.chaos - 0.35) / 0.65) * (0.5 + Math.random());
    }

    this.airPulse *= k(2.5);
    this.layers.update({
      time: this.ftime, reveal: rev, mist: m.weather, float, wonder: m.chaos, moon: m.fog, bright: P.bright,
      pixel: this.height, pulse: this.airPulse + this.lift * 0.5, dream: P.dream, dream2: P.dream2, glow: P.glow, mistCol: P.mist,
    });

    // dream motes: bloom in, drift and rise, fade out
    for (let i = 0; i < MOTES; i++) {
      const s = this.motes[i];
      s.age += dt;
      const x = s.age / s.life;
      if (x >= 1) {
        this.mCol.setW(i, 0);
        continue;
      }
      s.x += s.vx * dt + Math.sin(st * 0.8 + i) * 0.004 * dt * float;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      s.vx *= Math.exp(-dt * 0.3);
      s.vz *= Math.exp(-dt * 0.3);
      s.rot += s.spin * dt;
      const env = Math.min(1, s.age / 0.35) * Math.pow(1 - x, 1.6);
      const twinkle = s.shape === MOTE_GLINT ? 0.75 + 0.25 * Math.sin(st * 7 + i * 3) : 1;
      this.mPos.setXYZ(i, s.x, s.y, s.z);
      this.mCol.setXYZW(i, s.col.r, s.col.g, s.col.b, s.intensity * env * twinkle * rev);
      const streak = s.shape === MOTE_STREAK || s.shape === MOTE_SPARK;
      let size = s.size * (s.shape === MOTE_PETAL ? 1 : 0.9 + 0.2 * env);
      if (s.shape === MOTE_HALO) size = s.size * (0.5 + 1.1 * Math.sqrt(x)); // the ring slowly opens
      if (s.shape === MOTE_BLOOM) size = s.size * (0.7 + 0.5 * x);
      if (s.shape === MOTE_SPARK) { s.vy -= dt * 0.03; s.vx *= Math.exp(-dt * 1.2); s.vz *= Math.exp(-dt * 1.2); }
      this.mMisc.setXYZW(i, size, s.shape, streak ? Math.atan2(s.vy, s.vx) : s.rot, s.shape === MOTE_STREAK ? 5 : s.shape === MOTE_SPARK ? 3 : 1);
    }
    this.mPos.needsUpdate = true;
    this.mCol.needsUpdate = true;
    this.mMisc.needsUpdate = true;

    // ---- post
    this.bloom.strength = lerp(0.35, 0.6, m.fog) * (1 + this.mod * 0.25);
    this.bloom.radius = 0.75;
    this.bloom.threshold = 0.82;
    this.renderer.toneMappingExposure = lerp(1.05, 0.95, hour) * (1 + this.lift * 0.15);
    this.finish.uniforms.uTime.value = st;
    this.finish.uniforms.uGrain.value = 0.012;
    this.finish.uniforms.uVignette.value = lerp(0.8, 0.55, m.space);
    this.finish.uniforms.uFade.value = rev;
    this.composer.render(dt);
  }

  pick(): { x: number; z: number } | null {
    return null;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.renderer.shadowMap.enabled = false;
    this.lamp.dispose();
    this.moon.dispose();
    for (const d of this.disposables) d.dispose();
    this.composer.dispose();
  }
}
