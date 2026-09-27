import { Mesh, NormalBlending, OrthographicCamera, PlaneGeometry, Scene, ShaderMaterial, Vector2, type WebGLRenderer } from 'three';

/**
 * The cover of ECHOES: an abstract space of slow light — veils of colour folding over each other,
 * defocused motes drifting through, a faint pulse like breathing. It belongs to no world.
 * One fullscreen fragment shader, drawn on top of whatever is behind it while it fades out.
 */
const frag = /* glsl */ `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uFade;
uniform vec2 uMouse;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}

// a soft ribbon of light: a band around a slowly bending curve
float ribbon(vec2 p, float y0, float amp, float freq, float speed, float width, float t) {
  float c = y0 + amp * sin(p.x * freq + t * speed) + 0.35 * amp * sin(p.x * freq * 2.3 - t * speed * 1.3 + 1.7);
  c += (fbm(vec2(p.x * 0.8, t * 0.05)) - 0.5) * amp * 1.4;
  float d = (p.y - c) / width;
  return exp(-d * d);
}

void main() {
  vec2 uv = vUv;
  float asp = uRes.x / uRes.y;
  vec2 p = vec2((uv.x - 0.5) * asp, uv.y - 0.5);
  float t = uTime;
  p += (uMouse - 0.5) * vec2(0.03, 0.02);

  // deep night base, slightly lighter toward the centre
  vec3 col = mix(vec3(0.012, 0.014, 0.024), vec3(0.03, 0.035, 0.06), smoothstep(1.1, 0.0, length(p * vec2(0.8, 1.2))));

  // domain-warped veils
  vec2 q = p * 1.4;
  vec2 w = vec2(fbm(q + vec2(0.0, t * 0.03)), fbm(q + vec2(5.2, -t * 0.025)));
  float veil = fbm(q * 1.2 + w * 1.8 + vec2(t * 0.02, 0.0));
  col += vec3(0.10, 0.12, 0.22) * smoothstep(0.35, 0.95, veil) * 0.55;

  // three ribbons of light: cold blue, pale violet, a thin warm thread
  float r1 = ribbon(p, -0.06, 0.09, 1.7, 0.11, 0.07, t);
  float r2 = ribbon(p + vec2(0.4, 0.0), 0.04, 0.12, 1.2, -0.08, 0.11, t + 11.0);
  float r3 = ribbon(p - vec2(0.2, 0.0), -0.01, 0.07, 2.4, 0.14, 0.012, t + 5.0);
  float grain = 0.7 + 0.3 * fbm(p * 6.0 + t * 0.1);
  col += vec3(0.30, 0.46, 0.85) * r1 * 0.42 * grain;
  col += vec3(0.55, 0.42, 0.80) * r2 * 0.28 * grain;
  col += vec3(1.00, 0.72, 0.48) * r3 * 0.35;
  // fine strands inside the main ribbon
  float strands = pow(abs(sin((p.y + 0.3 * sin(p.x * 1.7 + t * 0.11)) * 90.0 + fbm(p * 3.0) * 6.0)), 18.0);
  col += vec3(0.55, 0.70, 1.0) * strands * r1 * 0.18;

  // defocused motes: soft discs of different sizes drifting up and sideways
  for (int i = 0; i < 28; i++) {
    float fi = float(i);
    float h1 = hash(vec2(fi, 1.3)), h2 = hash(vec2(fi, 7.1)), h3 = hash(vec2(fi, 3.7));
    float size = mix(0.004, 0.05, pow(h3, 2.5));
    vec2 c = vec2((h1 - 0.5) * asp * 1.1 + sin(t * 0.05 + fi) * 0.05, fract(h2 + t * mix(0.004, 0.012, h1)) * 1.3 - 0.65);
    float d = length(p - c) / size;
    float disc = smoothstep(1.0, 0.75, d) * (0.55 + 0.45 * smoothstep(0.6, 1.0, d)); // bokeh: brighter rim
    float glow = exp(-d * d * 0.6) * 0.25;
    float tw = 0.6 + 0.4 * sin(t * (0.3 + h1) + fi * 2.0);
    vec3 mc = mix(vec3(0.55, 0.7, 1.0), vec3(1.0, 0.8, 0.6), step(0.8, h2));
    col += mc * (disc * mix(0.35, 0.08, h3) + glow * 0.4) * tw;
  }

  // a slow breath of light across everything
  col *= 0.92 + 0.08 * sin(t * 0.35);
  // vignette + grain
  col *= smoothstep(1.25, 0.25, length(p * vec2(0.85, 1.15)));
  col += (hash(uv * uRes + fract(t) * 91.0) - 0.5) * 0.012;
  gl_FragColor = vec4(max(col, 0.0), uFade);
}
`;

export class IntroScene {
  private scene = new Scene();
  private camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: ShaderMaterial;
  private mesh: Mesh;
  private time = 0;
  private mouse = new Vector2(0.5, 0.5);
  fade = 1;

  constructor() {
    this.mat = new ShaderMaterial({
      uniforms: { uRes: { value: new Vector2(1, 1) }, uTime: { value: 0 }, uFade: { value: 1 }, uMouse: { value: this.mouse } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: frag,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: NormalBlending,
      toneMapped: false,
    });
    this.mesh = new Mesh(new PlaneGeometry(2, 2), this.mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    window.addEventListener('pointermove', this.onMove, { passive: true });
  }

  private onMove = (e: PointerEvent) => {
    this.mouse.set(e.clientX / window.innerWidth, 1 - e.clientY / window.innerHeight);
  };

  /** Draw on top of the current frame (clear = true when nothing is behind). */
  render(renderer: WebGLRenderer, dt: number, clear: boolean): void {
    this.time += dt;
    const size = renderer.getDrawingBufferSize(new Vector2());
    this.mat.uniforms.uRes.value.copy(size);
    this.mat.uniforms.uTime.value = this.time;
    this.mat.uniforms.uFade.value = this.fade;
    const auto = renderer.autoClear;
    const tm = renderer.toneMapping;
    renderer.autoClear = clear;
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
    renderer.autoClear = auto;
    renderer.toneMapping = tm;
  }

  dispose(): void {
    window.removeEventListener('pointermove', this.onMove);
    this.mat.dispose();
    this.mesh.geometry.dispose();
  }
}
