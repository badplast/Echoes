import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  FogExp2,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  PointLight,
  Points,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  Vector4,
  AgXToneMapping,
  type IUniform,
  type Material,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { bus, type NoteOn, type PadGesture } from '../../core/events';
import type { Macros } from '../../core/ParameterStore';
import { lerp, pitchNorm, smooth, timeScale } from '../../core/derive';
import type { ParamLabels, World } from '../World';
import { finishShader } from '../tide/shaders/atmos';
import { CatRig } from './CatRig';
import { catFragment, catVertex } from './catShader';
import { createLight, paletteName, sampleLight } from './palettes';
import { fabric, monsteraLeaf, oakFloor, poster, wallPaint, windowView } from './textures';

// ---------------------------------------------------------------- room layout (metres)
const SEAT_TOP = 0.535;
const WALL_Z = -0.6;
const LAMP_POS = new Vector3(-1.05, 0.16, -0.32);
const WIN_MIN = new Vector2(0.72, 0.95); // window on the back wall, x/y
const WIN_MAX = new Vector2(1.46, 2.05);
const WIN_CENTER = new Vector3((WIN_MIN.x + WIN_MAX.x) / 2, (WIN_MIN.y + WIN_MAX.y) / 2, WALL_Z + 0.01);
/** direction the window light travels into the room */
const LIGHT_DIR = new Vector3(0, SEAT_TOP, 0.05).sub(WIN_CENTER).normalize();
const WAVES = 8;
const SPARKS = 40;
const RINGS = 6;
const DUST = 900;

const floorOverlayFrag = /* glsl */ `
#define WAVES ${WAVES}
uniform vec4 uWave[WAVES];   // start, amp, speed, width
uniform vec3 uWaveCol[WAVES];
uniform float uTime;
uniform vec2 uCenter;
uniform sampler2D uWin;
uniform vec3 uWinCol;
uniform float uWinI;
uniform vec3 uLightDir;
uniform vec2 uWinMin;
uniform vec2 uWinMax;
uniform float uWallZ;
uniform float uReveal;
uniform float uIsWall;
varying vec3 vW;
void main() {
  vec3 col = vec3(0.0);
  // soft light waves spreading from the chair
  vec2 rel = uIsWall > 0.5 ? vec2(vW.x - uCenter.x, (vW.y - 0.1) * 1.2) : vW.xz - uCenter;
  float d = length(rel);
  for (int i = 0; i < WAVES; i++) {
    vec4 W = uWave[i];
    if (W.y <= 0.0) continue;
    float age = uTime - W.x;
    if (age < 0.0 || age > 9.0) continue;
    float r = age * W.z;
    float x = (d - r) / (W.w * (1.0 + age * 0.25));
    col += uWaveCol[i] * W.y * exp(-x * x) * exp(-age * 0.55) * smoothstep(0.0, 0.3, age) / (1.0 + d * 0.8);
  }
  // the window's light on the floor, railing and frame included
  if (uIsWall < 0.5) {
    float t = (uWallZ - vW.z) / (-uLightDir.z);
    vec3 q = vW - uLightDir * t;
    vec2 uv = (q.xy - uWinMin) / (uWinMax - uWinMin);
    if (t > 0.0 && uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
      float edge = smoothstep(0.0, 0.06, uv.x) * smoothstep(1.0, 0.94, uv.x) * smoothstep(0.0, 0.06, uv.y) * smoothstep(1.0, 0.94, uv.y);
      float light = texture2D(uWin, uv).r;
      col += uWinCol * uWinI * light * edge * 0.28 / (1.0 + t * 0.35);
    }
  }
  gl_FragColor = vec4(col * uReveal, 1.0);
}
`;

const overlayVert = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export class FibaWorld implements World {
  readonly id = 'fiba' as const;
  readonly title = 'World 02 — FIBA';
  readonly pads: PadGesture[] = ['swell', 'dust', 'purr', 'wake', 'bloom', 'pulse', 'stretch', 'lift'];
  readonly labels: ParamLabels = {
    world: { label: 'Hour', lo: 'deep night', hi: 'first light' },
    weather: { label: 'Air', lo: 'clear', hi: 'dusty dream' },
    energy: { label: 'Energy', lo: 'fast asleep', hi: 'awake-ish' },
    space: { label: 'Space', lo: 'close', hi: 'dream-room' },
    texture: { label: 'Texture', lo: 'hush', hi: 'soft grain' },
    motion: { label: 'Motion', lo: 'still', hi: 'breathing' },
    color: { label: 'Color', lo: 'linen', hi: 'early blue' },
    chaos: { label: 'Chaos', lo: 'calm', hi: 'dreamy' },
    atmos: { label: 'Ambience', lo: 'silent room', hi: 'full' },
    rain: { label: 'Dream dust', lo: 'none', hi: 'drifting' },
    fog: { label: 'Haze', lo: 'crisp', hi: 'soft glow' },
    drone: { label: 'Drone / purr', lo: 'silent', hi: 'deep' },
  };

  private renderer!: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(34, 1, 0.05, 40);
  private composer!: EffectComposer;
  private bloom!: UnrealBloomPass;
  private finish!: ShaderPass;
  private disposables: { dispose(): void }[] = [];
  private unsubs: (() => void)[] = [];
  private light = createLight();
  private macros: Macros | null = null;
  private reveal = 0;
  private time = 0;
  private wtime = 0;
  private height = 1;

  private rig = new CatRig();
  private catGroup = new Group();
  private catMat!: ShaderMaterial;
  private catMesh!: Mesh;
  private whiskers!: LineSegments;
  private whiskerBase: Vector3[] = [];
  private contact!: Mesh;
  private lamp!: PointLight;
  private lampGlobe!: ShaderMaterial;
  private moon!: DirectionalLight;
  private hemi!: HemisphereLight;
  private windowMat!: ShaderMaterial;
  private shaftMat!: ShaderMaterial;
  private floorOver!: ShaderMaterial;
  private wallOver!: ShaderMaterial;
  private wallMat!: MeshStandardMaterial;
  private leaves: Mesh[] = [];
  private dust!: Points;
  private dustU!: Record<string, IUniform>;
  private sparks!: Points;
  private sparkState: { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; age: number; size: number }[] = [];
  private rings: { mesh: Mesh; age: number; amp: number; speed: number }[] = [];
  private wave = Array.from({ length: WAVES }, () => new Vector4(0, 0, 1, 0.3));
  private waveCol = Array.from({ length: WAVES }, () => new Vector3());
  private nextWave = 0;
  private glow = 0;
  private lampBoost = 0;
  private liftBoost = 0;
  private purrGlow = 0;
  private whiskerGlow = 0;
  private dustKick = 0;
  private mod = 0;
  private modTarget = 0;
  /** Test hook: a fixed close-up camera. */
  debugView: { pos: number[]; target: number[] } | null = null;
  private tmpM = new Matrix4();
  private tmpV = new Vector3();
  private inv = new Matrix4();

  // ------------------------------------------------------------------ build

  mount(renderer: WebGLRenderer): void {
    this.renderer = renderer;
    renderer.toneMapping = AgXToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    const scene = this.scene;
    scene.fog = new FogExp2(0x000000, 0.08);
    const pmrem = new PMREMGenerator(renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.12;
    this.disposables.push(env, pmrem);

    this.buildRoom();
    this.buildChair();
    this.buildCat();
    this.buildAir();

    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, this.camera));
    this.bloom = new UnrealBloomPass(new Vector2(512, 512), 0.5, 0.8, 0.85);
    this.composer.addPass(this.bloom);
    this.finish = new ShaderPass(finishShader);
    this.composer.addPass(this.finish);
    this.composer.addPass(new OutputPass());

    this.unsubs.push(
      bus.on('note:on', (e) => this.onNote(e)),
      bus.on('pad', (e) => this.onPad(e.gesture, e.velocity)),
      bus.on('drip', () => this.spark(0.25, true)),
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

  private buildRoom(): void {
    const scene = this.scene;
    // floor
    const floorTex = this.keep(oakFloor());
    const floor = new Mesh(this.keep(new PlaneGeometry(9, 9).rotateX(-Math.PI / 2)), this.std({ map: floorTex, roughness: 0.62, metalness: 0 }));
    floor.receiveShadow = true;
    scene.add(floor);
    // walls: back wall with the window, a side wall on the left fading into the dark
    this.wallMat = this.std({ color: 0xd9d4cc, roughness: 0.95, map: this.keep(wallPaint()) });
    const back = new Mesh(this.keep(new PlaneGeometry(9, 4)), this.wallMat);
    back.position.set(0, 2, WALL_Z);
    back.receiveShadow = true;
    scene.add(back);
    const side = new Mesh(this.keep(new PlaneGeometry(6, 4)), this.wallMat);
    side.rotation.y = Math.PI / 2;
    side.position.set(-2.4, 2, 2.4);
    side.receiveShadow = true;
    scene.add(side);
    // skirting board
    const skirt = new Mesh(this.keep(new BoxGeometry(9, 0.07, 0.015)), this.std({ color: 0xe8e3db, roughness: 0.8 }));
    skirt.position.set(0, 0.035, WALL_Z + 0.008);
    scene.add(skirt);

    // the window: night sky behind a balcony railing
    const winTex = this.keep(windowView());
    this.windowMat = this.keep(
      new ShaderMaterial({
        uniforms: { uTex: { value: winTex }, uCol: { value: new Color() }, uI: { value: 1 }, uReveal: { value: 0 } },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `uniform sampler2D uTex; uniform vec3 uCol; uniform float uI; uniform float uReveal; varying vec2 vUv;
          void main(){ float v = texture2D(uTex, vUv).r; vec3 c = uCol * uI * (0.25 + 0.75 * v) * v; gl_FragColor = vec4(c * uReveal, 1.0); }`,
      }),
    );
    const win = new Mesh(this.keep(new PlaneGeometry(WIN_MAX.x - WIN_MIN.x, WIN_MAX.y - WIN_MIN.y)), this.windowMat);
    win.position.copy(WIN_CENTER);
    scene.add(win);
    const frameMat = this.std({ color: 0xeeeae4, roughness: 0.7 });
    const fw = WIN_MAX.x - WIN_MIN.x;
    const fh = WIN_MAX.y - WIN_MIN.y;
    for (const [w, h, x, y] of [
      [fw + 0.1, 0.05, WIN_CENTER.x, WIN_MIN.y - 0.025],
      [fw + 0.1, 0.05, WIN_CENTER.x, WIN_MAX.y + 0.025],
      [0.05, fh, WIN_MIN.x - 0.025, WIN_CENTER.y],
      [0.05, fh, WIN_MAX.x + 0.025, WIN_CENTER.y],
    ]) {
      const f = new Mesh(this.keep(new BoxGeometry(w, h, 0.06)), frameMat);
      f.position.set(x, y, WALL_Z + 0.03);
      scene.add(f);
    }
    // sill
    const sill = new Mesh(this.keep(new BoxGeometry(fw + 0.2, 0.03, 0.16)), frameMat);
    sill.position.set(WIN_CENTER.x, WIN_MIN.y - 0.06, WALL_Z + 0.08);
    sill.castShadow = sill.receiveShadow = true;
    scene.add(sill);

    // the shaft of window light, a soft additive volume from the window to the floor
    const corners = [
      new Vector3(WIN_MIN.x, WIN_MIN.y, WIN_CENTER.z),
      new Vector3(WIN_MAX.x, WIN_MIN.y, WIN_CENTER.z),
      new Vector3(WIN_MAX.x, WIN_MAX.y, WIN_CENTER.z),
      new Vector3(WIN_MIN.x, WIN_MAX.y, WIN_CENTER.z),
    ];
    const floorPts = corners.map((c) => c.clone().addScaledVector(LIGHT_DIR, -c.y / LIGHT_DIR.y));
    const pos: number[] = [];
    const along: number[] = [];
    const quad = (a: Vector3, b: Vector3, c: Vector3, d: Vector3, ta: number, tb: number, tc: number, td: number) => {
      for (const [v, t] of [[a, ta], [b, tb], [c, tc], [a, ta], [c, tc], [d, td]] as [Vector3, number][]) {
        pos.push(v.x, v.y, v.z);
        along.push(t);
      }
    };
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      quad(corners[i], corners[j], floorPts[j], floorPts[i], 0, 0, 1, 1);
    }
    const shaftGeo = this.keep(new BufferGeometry());
    shaftGeo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    shaftGeo.setAttribute('along', new BufferAttribute(new Float32Array(along), 1));
    this.shaftMat = this.keep(
      new ShaderMaterial({
        uniforms: { uCol: { value: new Color() }, uI: { value: 0.3 }, uTime: { value: 0 }, uReveal: { value: 0 }, uWinC: { value: WIN_CENTER }, uDir: { value: LIGHT_DIR }, uHalf: { value: new Vector2((WIN_MAX.x - WIN_MIN.x) / 2, (WIN_MAX.y - WIN_MIN.y) / 2) } },
        vertexShader: `attribute float along; varying float vA; varying vec3 vW; void main(){ vA = along; vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
        fragmentShader: `uniform vec3 uCol; uniform float uI; uniform float uTime; uniform float uReveal; uniform vec3 uWinC; uniform vec3 uDir; uniform vec2 uHalf; varying float vA; varying vec3 vW;
          void main(){
            // soft cross-section: fade toward the sides of the beam so it has no hard edges
            vec3 rel = vW - uWinC;
            float along = dot(rel, uDir);
            vec3 perp = rel - uDir * along;
            float side = length(perp / vec3(uHalf.x, uHalf.y, uHalf.x)) ;
            float soft = smoothstep(1.15, 0.2, side);
            float n = 0.8 + 0.2 * sin(vW.x*9.0 + vW.y*5.0 + uTime*0.3) * sin(vW.z*7.0 - uTime*0.2);
            float a = uI * (1.0 - vA * 0.7) * smoothstep(0.0, 0.1, vA) * n * soft;
            gl_FragColor = vec4(uCol * a * uReveal * 0.07, 1.0); }`,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        side: DoubleSide,
      }),
    );
    const shaft = new Mesh(shaftGeo, this.shaftMat);
    shaft.renderOrder = 8;
    scene.add(shaft);

    // overlays: light waves on the floor and wall, window light on the floor
    const overlayUniforms = (isWall: number) => ({
      uWave: { value: this.wave },
      uWaveCol: { value: this.waveCol },
      uTime: { value: 0 },
      uCenter: { value: new Vector2(0, isWall ? 0 : 0) },
      uWin: { value: winTex },
      uWinCol: { value: new Color() },
      uWinI: { value: 1 },
      uLightDir: { value: LIGHT_DIR },
      uWinMin: { value: WIN_MIN },
      uWinMax: { value: WIN_MAX },
      uWallZ: { value: WIN_CENTER.z },
      uReveal: { value: 0 },
      uIsWall: { value: isWall },
    });
    this.floorOver = this.keep(new ShaderMaterial({ uniforms: overlayUniforms(0), vertexShader: overlayVert, fragmentShader: floorOverlayFrag, transparent: true, depthWrite: false, blending: AdditiveBlending }));
    const fo = new Mesh(this.keep(new PlaneGeometry(7, 5).rotateX(-Math.PI / 2)), this.floorOver);
    fo.position.set(0, 0.003, 1.0);
    fo.renderOrder = 3;
    scene.add(fo);
    this.wallOver = this.keep(new ShaderMaterial({ uniforms: overlayUniforms(1), vertexShader: overlayVert, fragmentShader: floorOverlayFrag, transparent: true, depthWrite: false, blending: AdditiveBlending }));
    const wo = new Mesh(this.keep(new PlaneGeometry(7, 3.2)), this.wallOver);
    wo.position.set(0, 1.6, WALL_Z + 0.004);
    wo.renderOrder = 3;
    scene.add(wo);

    // the globe lamp on the floor (a sunrise lamp: a warm half-dome on a dark base)
    this.lampGlobe = this.keep(
      new ShaderMaterial({
        uniforms: { uCol: { value: new Color() }, uI: { value: 1 }, uReveal: { value: 0 } },
        vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vN = normalize(mat3(modelMatrix)*normal); vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix*viewMatrix*w; }`,
        fragmentShader: `uniform vec3 uCol; uniform float uI; uniform float uReveal; varying vec3 vN; varying vec3 vV;
          void main(){ float f = pow(max(dot(vN, vV), 0.0), 0.6); vec3 c = uCol * uI * (0.6 + 1.2 * f); gl_FragColor = vec4(c * uReveal, 1.0); }`,
      }),
    );
    const globe = new Mesh(this.keep(new SphereGeometry(0.13, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2)), this.lampGlobe);
    globe.position.set(LAMP_POS.x, 0.055, LAMP_POS.z);
    scene.add(globe);
    const base = new Mesh(this.keep(new CylinderGeometry(0.135, 0.14, 0.055, 40)), this.std({ color: 0x1c1c1f, roughness: 0.5 }));
    base.position.set(LAMP_POS.x, 0.0275, LAMP_POS.z);
    base.castShadow = true;
    scene.add(base);
    this.lamp = new PointLight(0xffaa66, 1, 7, 2);
    this.lamp.position.copy(LAMP_POS);
    this.lamp.castShadow = true;
    this.lamp.shadow.mapSize.set(512, 512);
    this.lamp.shadow.radius = 6;
    this.lamp.shadow.bias = -0.002;
    scene.add(this.lamp);

    this.moon = new DirectionalLight(0x99aacc, 0.5);
    this.moon.position.copy(new Vector3(0, SEAT_TOP, 0).addScaledVector(LIGHT_DIR, -4));
    this.moon.target.position.set(0, SEAT_TOP, 0);
    this.moon.castShadow = true;
    this.moon.shadow.mapSize.set(1024, 1024);
    const sc = this.moon.shadow.camera;
    sc.left = -2;
    sc.right = 2;
    sc.top = 2;
    sc.bottom = -2;
    sc.near = 0.5;
    sc.far = 9;
    this.moon.shadow.radius = 4;
    this.moon.shadow.bias = -0.001;
    scene.add(this.moon, this.moon.target);
    this.hemi = new HemisphereLight(0x445066, 0x221c18, 0.3);
    scene.add(this.hemi);

    // posters leaning on the wall
    const addPoster = (kind: 'red' | 'green', w: number, h: number, x: number) => {
      const t = this.keep(poster(kind));
      const p = new Mesh(this.keep(new BoxGeometry(w, h, 0.012)), [
        this.std({ color: 0xdcdcdc }), this.std({ color: 0xdcdcdc }), this.std({ color: 0xdcdcdc }),
        this.std({ color: 0xdcdcdc }), this.std({ map: t, roughness: 0.8 }), this.std({ color: 0xdcdcdc }),
      ]);
      p.position.set(x, h / 2 + 0.005, WALL_Z + 0.07);
      p.rotation.x = -0.12;
      p.castShadow = p.receiveShadow = true;
      this.scene.add(p);
    };
    addPoster('red', 0.44, 0.58, -0.62);
    addPoster('green', 0.36, 0.47, 0.66);

    // monstera in its pot, on the right
    const pot = new Mesh(this.keep(new CylinderGeometry(0.16, 0.13, 0.3, 32)), this.std({ color: 0xd8d4cc, roughness: 0.9 }));
    pot.position.set(1.32, 0.15, -0.26);
    pot.castShadow = pot.receiveShadow = true;
    this.scene.add(pot);
    const leafTex = this.keep(monsteraLeaf());
    const leafMat = this.std({ map: leafTex, alphaTest: 0.5, side: DoubleSide, roughness: 0.7, color: 0x8a9a88 });
    const stemMat = this.std({ color: 0x3f5a38, roughness: 0.8 });
    const leafSpots: [number, number, number, number, number][] = [
      [1.16, 0.95, -0.2, 0.5, 0.36], [1.48, 1.1, -0.3, -0.6, 0.42], [1.3, 1.35, -0.18, 0.1, 0.4],
      [1.06, 1.3, -0.12, 0.9, 0.3], [1.55, 0.75, -0.1, -1.0, 0.32], [1.38, 1.62, -0.28, -0.3, 0.34],
    ];
    for (const [x, y, z, rot, s] of leafSpots) {
      const stem = new Mesh(this.keep(new CylinderGeometry(0.008, 0.01, y - 0.3, 6)), stemMat);
      stem.position.set((x + 1.32) / 2, (y + 0.3) / 2, (z - 0.26) / 2);
      stem.lookAt(x, y, z);
      stem.rotateX(Math.PI / 2);
      this.scene.add(stem);
      const leaf = new Mesh(this.keep(new PlaneGeometry(s, s)), leafMat);
      leaf.position.set(x, y, z);
      leaf.rotation.set(-0.5, rot, 0.2);
      leaf.castShadow = true;
      leaf.userData.base = leaf.rotation.clone();
      this.leaves.push(leaf);
      this.scene.add(leaf);
    }
  }

  private buildChair(): void {
    const chair = new Group();
    const seatFab = fabric('tufted', 3);
    const backFab = fabric('channels', 5);
    const plainFab = fabric('plain', 9);
    this.disposables.push(seatFab.map, seatFab.bump, backFab.map, backFab.bump, plainFab.map, plainFab.bump);
    const mat = (f: { map: Texture; bump: Texture }) => this.std({ map: f.map, bumpMap: f.bump, bumpScale: 1.4, roughness: 0.96, color: 0xd4d7dc });
    const seatMat = mat(seatFab);
    const backMat = mat(backFab);
    const padMat = mat(plainFab);
    const black = this.std({ color: 0x141416, roughness: 0.55 });
    const chrome = this.std({ color: 0xd8dadd, roughness: 0.22, metalness: 1 });
    const box = (w: number, h: number, d: number, r: number, m: Material, x: number, y: number, z: number, rx = 0) => {
      const mesh = new Mesh(this.keep(new RoundedBoxGeometry(w, h, d, 4, r)), m);
      mesh.position.set(x, y, z);
      mesh.rotation.x = rx;
      mesh.castShadow = mesh.receiveShadow = true;
      chair.add(mesh);
      return mesh;
    };
    box(0.6, 0.14, 0.56, 0.05, seatMat, 0, SEAT_TOP - 0.07, 0.02);
    box(0.56, 0.78, 0.13, 0.05, backMat, 0, 0.95, -0.26, -0.11);
    box(0.34, 0.17, 0.085, 0.05, padMat, 0, 1.2, -0.215, -0.11);
    for (const s of [-1, 1]) {
      box(0.1, 0.075, 0.38, 0.035, padMat, s * 0.345, 0.715, 0.03);
      box(0.045, 0.2, 0.06, 0.012, black, s * 0.345, 0.585, -0.03);
      box(0.045, 0.03, 0.26, 0.01, black, s * 0.3, 0.47, -0.02);
    }
    box(0.34, 0.06, 0.34, 0.02, black, 0, 0.37, 0.0);
    const cyl = (rt: number, rb: number, h: number, m: Material, y: number) => {
      const c = new Mesh(this.keep(new CylinderGeometry(rt, rb, h, 24)), m);
      c.position.set(0, y, 0);
      c.castShadow = true;
      chair.add(c);
    };
    cyl(0.028, 0.028, 0.14, chrome, 0.28);
    cyl(0.04, 0.045, 0.13, black, 0.15);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.3;
      const leg = new Mesh(this.keep(new BoxGeometry(0.33, 0.035, 0.05)), chrome);
      leg.position.set(Math.cos(a) * 0.165, 0.075, Math.sin(a) * 0.165);
      leg.rotation.y = -a;
      leg.rotation.z = 0.12;
      leg.castShadow = true;
      chair.add(leg);
      const caster = new Mesh(this.keep(new SphereGeometry(0.03, 16, 12)), black);
      caster.position.set(Math.cos(a) * 0.32, 0.03, Math.sin(a) * 0.32);
      caster.castShadow = true;
      chair.add(caster);
    }
    this.scene.add(chair);
  }

  private buildCat(): void {
    const rig = this.rig;
    // she lies with her head toward the right armrest, facing us a little
    this.catGroup.position.set(0.0, SEAT_TOP, 0.03);
    this.catGroup.rotation.y = -0.42;
    this.scene.add(this.catGroup);
    const boxMin = new Vector3(-0.55, -0.01, -0.34);
    const boxMax = new Vector3(0.48, 0.32, 0.34);
    this.catMat = this.keep(
      new ShaderMaterial({
        vertexShader: catVertex,
        fragmentShader: catFragment,
        uniforms: {
          uPart: { value: rig.part },
          uPartR: { value: rig.partR },
          uTail: { value: rig.tail },
          uHeadPos: { value: rig.headPos },
          uHeadRot: { value: rig.headRot },
          uEars: { value: rig.ears },
          uEyes: { value: rig.eyes },
          uStretch: { value: 0 },
          uCamLocal: { value: new Vector3() },
          uBoxMin: { value: boxMin },
          uBoxMax: { value: boxMax },
          uLampPos: { value: new Vector3() },
          uLampColor: { value: new Color() },
          uMoonDir: { value: new Vector3() },
          uMoonColor: { value: new Color() },
          uAmbient: { value: new Color() },
          uGround: { value: new Color() },
          uGlowColor: { value: new Color() },
          uGlow: { value: 0 },
          uWhiskerGlow: { value: 0 },
          uReveal: { value: 0 },
          uFogColor: { value: new Color() },
          uFogDensity: { value: 0.08 },
          uCamDist: { value: 3 },
          uClip: { value: new Matrix4() },
        },
      }),
    );
    const size = boxMax.clone().sub(boxMin);
    const proxy = this.keep(new BoxGeometry(size.x, size.y, size.z));
    proxy.translate((boxMin.x + boxMax.x) / 2, (boxMin.y + boxMax.y) / 2, (boxMin.z + boxMax.z) / 2);
    this.catMesh = new Mesh(proxy, this.catMat);
    this.catMesh.renderOrder = 1;
    this.catGroup.add(this.catMesh);

    // whiskers: thin pale strands in the head frame
    const wpos: number[] = [];
    for (const side of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const base = new Vector3(side * 0.016, -0.026 - i * 0.003, 0.058);
        const tip = base.clone().add(new Vector3(side * 0.05, 0.008 - i * 0.009, 0.014 - i * 0.003));
        this.whiskerBase.push(base, tip);
        wpos.push(0, 0, 0, 0, 0, 0);
      }
    }
    const wg = this.keep(new BufferGeometry());
    wg.setAttribute('position', new BufferAttribute(new Float32Array(wpos), 3));
    this.whiskers = new LineSegments(wg, this.keep(new LineBasicMaterial({ color: 0xe8e0d4, transparent: true, opacity: 0.35, depthWrite: false })));
    this.catGroup.add(this.whiskers);

    // soft contact shadow on the seat
    this.contact = new Mesh(
      this.keep(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2)),
      this.keep(
        new ShaderMaterial({
          uniforms: { uA: { value: 0.55 } },
          vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
          fragmentShader: `uniform float uA; varying vec2 vUv; void main(){ float d = length(vUv - 0.5) * 2.0; float a = uA * smoothstep(1.0, 0.2, d); gl_FragColor = vec4(0.0, 0.0, 0.0, a); }`,
          transparent: true,
          depthWrite: false,
        }),
      ),
    );
    this.contact.position.set(-0.01, 0.002, -0.01);
    this.contact.scale.set(0.5, 1, 0.42);
    this.catGroup.add(this.contact);
  }

  private buildAir(): void {
    // dust motes drifting through the room, bright where the window light or the lamp catches them
    const seeds = new Float32Array(DUST * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    const g = this.keep(new BufferGeometry());
    g.setAttribute('position', new BufferAttribute(new Float32Array(DUST * 3), 3));
    g.setAttribute('aSeed', new BufferAttribute(seeds, 4));
    this.dustU = {
      uTime: { value: 0 },
      uDrift: { value: 0 },
      uKick: { value: 0 },
      uAmount: { value: 0.5 },
      uWinCenter: { value: WIN_CENTER },
      uLightDir: { value: LIGHT_DIR },
      uWinCol: { value: new Color() },
      uLampPos: { value: LAMP_POS },
      uLampCol: { value: new Color() },
      uBase: { value: new Color() },
      uPixel: { value: 400 },
      uReveal: { value: 0 },
      uChair: { value: new Vector3(0, SEAT_TOP + 0.15, 0) },
    };
    const mat = this.keep(
      new ShaderMaterial({
        uniforms: this.dustU,
        vertexShader: /* glsl */ `
          attribute vec4 aSeed;
          uniform float uTime; uniform float uDrift; uniform float uKick; uniform float uAmount;
          uniform vec3 uWinCenter; uniform vec3 uLightDir; uniform vec3 uWinCol; uniform vec3 uLampPos; uniform vec3 uLampCol;
          uniform vec3 uBase; uniform float uPixel; uniform vec3 uChair;
          varying vec3 vCol; varying float vA;
          void main() {
            vec3 box = vec3(4.4, 2.5, 2.6);
            vec3 p = fract(aSeed.xyz + vec3(uDrift * 0.013, uDrift * 0.004 * (aSeed.w - 0.3), uDrift * 0.009)) * box + vec3(-2.3, 0.02, -0.55);
            float ph = aSeed.w * 6.2831;
            p += vec3(sin(uTime * 0.21 + ph), sin(uTime * 0.17 + ph * 1.3), cos(uTime * 0.19 + ph)) * 0.05;
            // a stir near the chair when Fiba moves or music swells
            vec3 dc = p - uChair;
            p += normalize(dc + 1e-4) * uKick * 0.12 * exp(-dot(dc, dc) * 2.5);
            // light: inside the window shaft, near the lamp
            vec3 rel = p - uWinCenter;
            float along = dot(rel, uLightDir);
            vec3 perp = rel - uLightDir * along;
            float inShaft = along > 0.0 ? exp(-dot(perp, perp) / 0.12) : 0.0;
            vec3 dl = p - uLampPos;
            float nearLamp = 0.3 / (1.0 + dot(dl, dl) * 3.0);
            vCol = uBase * 0.25 + uWinCol * inShaft * 1.6 + uLampCol * nearLamp;
            float visible = clamp((uAmount - aSeed.w) / 0.1, 0.0, 1.0);
            vA = visible * (0.35 + 0.65 * fract(aSeed.w * 13.1)) * (0.6 + 0.4 * sin(uTime * (0.5 + aSeed.w) + ph * 3.0));
            vec4 mv = viewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = clamp((0.6 + fract(aSeed.w * 7.7)) * uPixel * 0.006 / -mv.z, 0.0, 10.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform float uReveal; varying vec3 vCol; varying float vA;
          void main(){ vec2 q = gl_PointCoord - 0.5; float a = exp(-dot(q,q) * 16.0) * vA * uReveal; if (a < 0.004) discard; gl_FragColor = vec4(vCol * a, a); }`,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );
    this.dust = new Points(g, mat);
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 9;
    this.scene.add(this.dust);

    // sparkles: tiny lights that rise from around her head on high notes
    for (let i = 0; i < SPARKS; i++) this.sparkState.push({ x: 0, y: -10, z: 0, vx: 0, vy: 0, vz: 0, life: 1, age: 9, size: 1 });
    const sg = this.keep(new BufferGeometry());
    sg.setAttribute('position', new BufferAttribute(new Float32Array(SPARKS * 3), 3));
    sg.setAttribute('aA', new BufferAttribute(new Float32Array(SPARKS), 1));
    this.sparks = new Points(
      sg,
      this.keep(
        new ShaderMaterial({
          uniforms: { uCol: { value: new Color() }, uPixel: { value: 400 } },
          vertexShader: `attribute float aA; uniform float uPixel; varying float vA; void main(){ vA = aA; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_Position = projectionMatrix*mv; gl_PointSize = clamp(uPixel*0.012/-mv.z, 0.0, 14.0); }`,
          fragmentShader: `uniform vec3 uCol; varying float vA; void main(){ vec2 q = gl_PointCoord-0.5; float a = exp(-dot(q,q)*22.0)*vA; if (a<0.004) discard; gl_FragColor = vec4(uCol*a*2.0, a); }`,
          transparent: true,
          depthWrite: false,
          blending: AdditiveBlending,
        }),
      ),
    );
    this.sparks.frustumCulled = false;
    this.sparks.renderOrder = 10;
    this.scene.add(this.sparks);

    // rings of light that breathe outward through the air around the chair
    const ringGeo = this.keep(new PlaneGeometry(1, 1));
    for (let i = 0; i < RINGS; i++) {
      const m = this.keep(
        new ShaderMaterial({
          uniforms: { uCol: { value: new Color() }, uA: { value: 0 }, uR: { value: 0.3 } },
          vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
          fragmentShader: `uniform vec3 uCol; uniform float uA; uniform float uR; varying vec2 vUv;
            void main(){ float d = length(vUv - 0.5) * 2.0; float x = (d - uR) / 0.07; float a = exp(-x*x) * uA * smoothstep(1.0, 0.85, d); gl_FragColor = vec4(uCol * a, a); }`,
          transparent: true,
          depthWrite: false,
          blending: AdditiveBlending,
        }),
      );
      const mesh = new Mesh(ringGeo, m);
      mesh.renderOrder = 11;
      mesh.visible = false;
      this.scene.add(mesh);
      this.rings.push({ mesh, age: 99, amp: 0, speed: 1 });
    }
  }

  // ------------------------------------------------------------------ events

  private onNote(e: NoteOn): void {
    const m = this.macros;
    if (!m) return;
    const pn = pitchNorm(e.note);
    const vel = e.velocity;
    const played = e.source !== 'generative' && e.source !== 'pad';
    this.rig.onNote(pn, vel, played);
    // every note breathes a little light into her fur
    this.glow = Math.min(1.2, this.glow + vel * lerp(0.35, 0.18, pn));
    this.dustKick = Math.max(this.dustKick, vel * 0.3);
    // low notes: a soft wave through the room from the chair
    if (pn < 0.5) this.addWave(lerp(0.9, 0.5, pn) * vel, lerp(0.45, 0.8, pn), lerp(0.45, 0.25, pn), this.light.accent);
    // high notes: sparkles around her head and whiskers
    if (pn > 0.5) {
      const n = 1 + Math.round(vel * 3);
      for (let i = 0; i < n; i++) this.spark(vel, false);
      this.whiskerGlow = Math.min(1, this.whiskerGlow + vel * 0.5);
    }
    // middle and strong notes: a ring of light in the air
    if (vel > 0.5 && pn > 0.3 && pn < 0.75 && Math.random() < 0.6) this.addRing(vel * 0.5, lerp(0.35, 0.6, m.space));
  }

  private onPad(g: PadGesture, vel: number): void {
    this.rig.onPad(g, vel);
    const acc = this.light.accent;
    switch (g) {
      case 'swell':
        this.addWave(0.9 * vel + 0.3, 0.4, 0.5, acc);
        this.addRing(0.6, 0.35);
        this.lampBoost = Math.max(this.lampBoost, 0.4);
        break;
      case 'dust':
        for (let i = 0; i < 14; i++) this.spark(0.5 + vel * 0.4, true);
        this.dustKick = 1;
        break;
      case 'purr':
        this.purrGlow = Math.min(1, this.purrGlow + 0.7);
        break;
      case 'wake':
        this.lampBoost = Math.max(this.lampBoost, 0.3);
        break;
      case 'bloom':
        this.addRing(0.8, 0.5);
        this.addRing(0.5, 0.3);
        this.glow = Math.min(1.2, this.glow + 0.6);
        break;
      case 'pulse':
        this.lampBoost = Math.max(this.lampBoost, 1);
        this.addWave(0.7, 0.55, 0.35, this.light.lamp);
        break;
      case 'stretch':
        this.dustKick = 1;
        break;
      case 'lift':
        this.liftBoost = Math.max(this.liftBoost, 1);
        break;
    }
  }

  private addWave(amp: number, speed: number, width: number, col: Color): void {
    const i = this.nextWave;
    this.nextWave = (i + 1) % WAVES;
    this.wave[i].set(this.time, amp * 0.5, speed, width);
    this.waveCol[i].set(col.r, col.g, col.b);
  }

  private addRing(amp: number, speed: number): void {
    let r = this.rings[0];
    for (const x of this.rings) if (x.age > r.age) r = x;
    r.age = 0;
    r.amp = amp;
    r.speed = speed;
  }

  private spark(vel: number, anywhere: boolean): void {
    let s = this.sparkState[0];
    for (const x of this.sparkState) if (x.age / x.life > s.age / s.life) s = x;
    const hp = this.tmpV.copy(this.rig.headPos);
    this.catGroup.localToWorld(hp);
    if (anywhere) {
      s.x = hp.x + (Math.random() - 0.5) * 1.2;
      s.y = hp.y + Math.random() * 0.6;
      s.z = hp.z + (Math.random() - 0.5) * 0.8;
    } else {
      s.x = hp.x + (Math.random() - 0.5) * 0.14;
      s.y = hp.y + 0.02 + Math.random() * 0.06;
      s.z = hp.z + (Math.random() - 0.5) * 0.12;
    }
    s.vx = (Math.random() - 0.5) * 0.04;
    s.vy = 0.03 + Math.random() * 0.05;
    s.vz = (Math.random() - 0.5) * 0.04;
    s.life = 2.5 + Math.random() * 2.5;
    s.age = 0;
    s.size = 0.4 + vel * 0.8;
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
    const ts = timeScale(m) * 0.7;
    this.time += dt;
    this.wtime += dt * ts;
    const L = sampleLight(m.color, m.world, this.light);
    this.mod += (this.modTarget - this.mod) * (1 - Math.exp(-dt / 0.2));
    const k = (tau: number) => Math.exp(-dt / tau);
    this.glow *= k(1.6);
    this.lampBoost *= k(1.8);
    this.liftBoost *= k(3.5);
    this.purrGlow *= k(4);
    this.whiskerGlow *= k(1.2);
    this.dustKick *= k(1.5);
    const rev = this.reveal;
    const haze = lerp(0.2, 1.4, m.fog) * lerp(0.8, 1.6, m.weather);

    // ---- light: lamp (warm), window (moon -> dawn), ambient; mod warms the lamp
    const lampI = L.lampI * (1 + this.lampBoost * 0.6 + this.mod * 0.35 + this.purrGlow * 0.2) * (0.94 + 0.06 * Math.sin(this.time * 0.9));
    this.lamp.color.copy(L.lamp);
    this.lamp.intensity = lampI * 0.55 * rev;
    this.lampGlobe.uniforms.uCol.value.copy(L.lamp);
    this.lampGlobe.uniforms.uI.value = lampI;
    this.lampGlobe.uniforms.uReveal.value = rev;
    const winI = L.windowI * (1 + this.liftBoost * 0.5);
    this.moon.color.copy(L.window);
    this.moon.intensity = winI * 0.9 * rev;
    this.windowMat.uniforms.uCol.value.copy(L.window);
    this.windowMat.uniforms.uI.value = winI * 1.4;
    this.windowMat.uniforms.uReveal.value = rev;
    this.shaftMat.uniforms.uCol.value.copy(L.window);
    this.shaftMat.uniforms.uI.value = winI * lerp(0.4, 1.3, m.weather) * lerp(0.7, 1.2, m.fog);
    this.shaftMat.uniforms.uTime.value = this.wtime;
    this.shaftMat.uniforms.uReveal.value = rev;
    this.hemi.color.copy(L.ambient);
    this.hemi.groundColor.copy(L.ground);
    // the night holds for a long time; fill light only arrives with the morning
    const morning = smooth(0.4, 1, m.world);
    this.hemi.intensity = (lerp(0.03, 0.8, morning) + this.liftBoost * 0.4) * rev;
    this.wallMat.color.copy(L.wall).multiplyScalar(lerp(0.55, 1, smooth(0.3, 1, m.world)));
    (this.scene.fog as FogExp2).color.copy(L.fog).multiplyScalar(rev);
    (this.scene.fog as FogExp2).density = 0.012 * haze + lerp(0.0, 0.03, 1 - m.space);
    this.scene.environmentIntensity = 0.012 + morning * 0.22;

    for (const mat of [this.floorOver, this.wallOver]) {
      mat.uniforms.uTime.value = this.time;
      mat.uniforms.uWinCol.value.copy(L.window);
      mat.uniforms.uWinI.value = winI;
      mat.uniforms.uReveal.value = rev;
    }

    // ---- camera: sitting a few steps away, breathing slowly; SPACE steps back into a dream-room
    const t = this.wtime * 0.05;
    const dist = lerp(2.25, 3.35, m.space);
    const camX = 0.42 + Math.sin(t * 0.7) * 0.06 * (1 + m.chaos);
    const camY = lerp(0.95, 1.1, m.space) + Math.sin(t * 1.1) * 0.02;
    this.camera.position.set(camX, camY, dist);
    this.camera.lookAt(-0.04 + Math.sin(t * 0.5) * 0.02, 0.64, -0.05);
    if (this.debugView) {
      this.camera.position.fromArray(this.debugView.pos);
      this.camera.lookAt(new Vector3().fromArray(this.debugView.target));
    }
    const fov = lerp(33, 38, m.space);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    // ---- Fiba
    this.rig.update(dt, m, ts);
    const cu = this.catMat.uniforms;
    this.catGroup.updateMatrixWorld();
    this.inv.copy(this.catGroup.matrixWorld).invert();
    cu.uCamLocal.value.copy(this.camera.position).applyMatrix4(this.inv);
    cu.uLampPos.value.copy(LAMP_POS).applyMatrix4(this.inv);
    cu.uLampColor.value.copy(L.lamp).multiplyScalar(lampI * 0.2);
    cu.uMoonDir.value.copy(LIGHT_DIR).negate().transformDirection(this.inv);
    cu.uMoonColor.value.copy(L.window).multiplyScalar(winI * 0.22);
    cu.uAmbient.value.copy(L.ambient).multiplyScalar(0.3 + this.liftBoost * 0.3);
    cu.uGround.value.copy(L.ground).multiplyScalar(0.5);
    cu.uGlowColor.value.copy(L.accent);
    cu.uGlow.value = (this.glow * 0.35 + this.purrGlow * (0.25 + 0.1 * Math.sin(this.time * 2.2)) + this.mod * 0.15) * lerp(0.6, 1, m.energy);
    cu.uStretch.value = this.rig.stretch;
    cu.uReveal.value = rev;
    cu.uFogColor.value.copy((this.scene.fog as FogExp2).color);
    cu.uFogDensity.value = (this.scene.fog as FogExp2).density;
    cu.uCamDist.value = this.camera.position.distanceTo(this.catGroup.position);
    this.camera.updateMatrixWorld();
    (cu.uClip.value as Matrix4).multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).multiply(this.catGroup.matrixWorld);
    this.contact.scale.set(lerp(0.5, 0.75, this.rig.stretch), 1, lerp(0.42, 0.3, this.rig.stretch));

    // whiskers follow the head
    const hm = this.rig.headMatrix(this.tmpM);
    const wp = this.whiskers.geometry.getAttribute('position') as BufferAttribute;
    const quiver = Math.sin(this.time * 7) * 0.002 * this.whiskerGlow;
    for (let i = 0; i < this.whiskerBase.length; i++) {
      const v = this.tmpV.copy(this.whiskerBase[i]);
      if (i % 2 === 1) v.y += quiver;
      v.applyMatrix4(hm);
      wp.setXYZ(i, v.x, v.y, v.z);
    }
    wp.needsUpdate = true;
    (this.whiskers.material as LineBasicMaterial).opacity = (0.14 + this.whiskerGlow * 0.4) * rev;

    // ---- air: dust, sparkles, rings, plant
    const du = this.dustU;
    du.uTime.value = this.wtime;
    du.uDrift.value = (du.uDrift.value as number) + dt * ts * (0.5 + m.energy * 1.2 + m.chaos * 0.6);
    du.uKick.value = this.dustKick;
    du.uAmount.value = Math.min(1, lerp(0.15, 0.55, m.weather) + m.rain * 0.45);
    du.uWinCol.value.copy(L.window).multiplyScalar(winI * 0.6);
    du.uLampCol.value.copy(L.lamp).multiplyScalar(lampI);
    du.uBase.value.copy(L.fog);
    du.uPixel.value = this.height;
    du.uReveal.value = rev;

    const sp = this.sparks.geometry.getAttribute('position') as BufferAttribute;
    const sa = this.sparks.geometry.getAttribute('aA') as BufferAttribute;
    for (let i = 0; i < SPARKS; i++) {
      const s = this.sparkState[i];
      s.age += dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      const x = s.age / s.life;
      const a = x >= 1 ? 0 : Math.min(1, s.age * 3) * (1 - x) * (1 - x) * s.size;
      sp.setXYZ(i, s.x, s.y, s.z);
      sa.setX(i, a * rev);
    }
    sp.needsUpdate = true;
    sa.needsUpdate = true;
    (this.sparks.material as ShaderMaterial).uniforms.uCol.value.copy(L.accent2);
    (this.sparks.material as ShaderMaterial).uniforms.uPixel.value = this.height;

    const center = this.tmpV.set(0, SEAT_TOP + 0.12, 0.02);
    for (const r of this.rings) {
      r.age += dt;
      const life = 5;
      r.mesh.visible = r.age < life;
      if (!r.mesh.visible) continue;
      const u = (r.mesh.material as ShaderMaterial).uniforms;
      const size = 0.4 + r.age * r.speed * 0.8;
      r.mesh.position.copy(center);
      r.mesh.scale.setScalar(size * 2);
      r.mesh.quaternion.copy(this.camera.quaternion);
      u.uR.value = 0.9;
      u.uA.value = r.amp * Math.min(1, r.age * 2) * Math.pow(1 - r.age / life, 2) * 0.35 * rev;
      u.uCol.value.copy(L.accent);
    }

    for (let i = 0; i < this.leaves.length; i++) {
      const leaf = this.leaves[i];
      const b = leaf.userData.base;
      leaf.rotation.x = b.x + Math.sin(this.wtime * 0.4 + i * 1.7) * 0.015 * (1 + m.motion);
      leaf.rotation.z = b.z + Math.sin(this.wtime * 0.33 + i) * 0.01 * (1 + m.motion);
    }

    // ---- post: soft bloom, grain from TEXTURE, a vignette that closes in when SPACE is small
    this.bloom.strength = lerp(0.22, 0.55, m.fog) * (1 + this.mod * 0.3);
    this.bloom.radius = lerp(0.45, 0.85, m.fog);
    this.bloom.threshold = lerp(0.95, 0.8, m.fog);
    this.renderer.toneMappingExposure = L.exposure * (1 + this.liftBoost * 0.18);
    this.finish.uniforms.uTime.value = this.time;
    this.finish.uniforms.uGrain.value = lerp(0.015, 0.06, m.texture);
    this.finish.uniforms.uVignette.value = lerp(0.75, 0.45, m.space);
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
