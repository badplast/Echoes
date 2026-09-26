import { atmosphere, orbChunk, RIPPLES } from './common';

/* ---------------------------------------------------------------- mist sheets */

export const mistVertex = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const mistFragment = /* glsl */ `
${atmosphere}
${orbChunk}
#define RIPPLES ${RIPPLES}
uniform vec4 uRipA[RIPPLES];
uniform vec4 uRipC[RIPPLES];
uniform float uRTime;
uniform float uDensity;
uniform float uLayer;
uniform vec2 uMistOffset;
uniform float uMistScale;
varying vec3 vWorld;

void main() {
  vec2 p = vWorld.xz;
  vec3 toP = vWorld - cameraPosition;
  float dist = length(toP);
  vec2 uv = p * uMistScale * (1.0 + uLayer * 0.6) + uMistOffset * (1.0 + uLayer * 0.35) + uLayer * 0.31;
  float n = texture2D(uCloudTex, uv).a * 0.6 + texture2D(uCloudTex, uv * 2.6 + vec2(0.3, 0.7)).g * 0.4;
  n = smoothstep(0.32, 0.9, n);

  // notes locally stir the mist: it thickens and glows where a ripple was born
  float stir = 0.0;
  vec3 stirCol = vec3(0.0);
  for (int i = 0; i < 24; i++) {
    vec4 A = uRipA[i];
    if (A.w <= 0.0) continue;
    float age = uRTime - A.z;
    if (age < 0.0 || age > 14.0) continue;
    vec2 d = p - A.xy;
    float R = 5.0 + age * 3.5;
    float e = exp(-dot(d, d) / (R * R)) * exp(-age * 0.32) * smoothstep(0.0, 1.2, age) * A.w * 3.0;
    stir += e;
    stirCol += uRipC[i].rgb * e;
  }

  vec3 lit = vec3(0.0);
  for (int i = 0; i < ORBS; i++) {
    vec4 C = uOrbCol[i];
    if (C.a <= 0.001) continue;
    vec4 O = uOrbPos[i];
    vec3 d = vWorld - O.xyz;
    lit += C.rgb * C.a * 0.35 / (1.0 + dot(d, d) / (O.w * O.w * 3.0));
  }

  float a = n * uDensity * (1.0 + stir * 1.2) + stir * 0.05 * n;
  a *= smoothstep(4.0, 28.0, dist);
  a *= 1.0 - smoothstep(380.0, 560.0, length(p - cameraPosition.xz));

  vec3 V = toP / dist;
  // never show a sheet edge-on: fade where the view grazes the layer
  a *= smoothstep(0.015, 0.09, abs(V.y));
  vec3 col = mix(uFogColor, skyGradient(normalize(vec3(V.x, 0.03, V.z))), 0.55);
  col += lit + stirCol * 0.12;
  gl_FragColor = vec4(col, clamp(a, 0.0, 0.6));
}
`;

/* ---------------------------------------------------------------- particles (motes / drizzle) */

export const particleVertex = /* glsl */ `
${orbChunk}
#define RIPPLES ${RIPPLES}
uniform vec4 uRipA[RIPPLES];
uniform vec4 uRipB[RIPPLES];
uniform float uRTime;
uniform vec3 uCenter;
uniform vec3 uBox;
uniform vec3 uOffset;
uniform float uTime;
uniform float uDensity;
uniform float uPixelScale;
uniform float uJitter;
uniform float uStreak;
uniform vec3 uTint;
attribute vec4 aSeed;
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec3 local = fract(aSeed.xyz + (uOffset * (0.6 + aSeed.w * 0.8) - vec3(uCenter.x, 0.0, uCenter.z)) / uBox);
  vec3 wp = vec3(uCenter.x + (local.x - 0.5) * uBox.x, 0.15 + local.y * uBox.y, uCenter.z + (local.z - 0.5) * uBox.z);
  float ph = aSeed.w * 6.2831;
  wp += vec3(sin(uTime * 0.31 + ph), sin(uTime * 0.23 + ph * 1.7) * 0.5, cos(uTime * 0.27 + ph)) * uJitter;

  float glow = 0.0;
  vec3 lightCol = vec3(0.0);
  for (int i = 0; i < ORBS; i++) {
    vec4 C = uOrbCol[i];
    if (C.a <= 0.001) continue;
    vec4 O = uOrbPos[i];
    vec3 d = wp - O.xyz;
    float r2 = dot(d, d);
    float s = O.w * O.w;
    wp += normalize(d + 1e-4) * C.a * 1.6 * exp(-r2 / (s * 10.0));
    float l = C.a * exp(-r2 / (s * 22.0));
    glow += l;
    lightCol += C.rgb * l;
  }
  // passing ripples lift the motes that hover low above the water
  for (int i = 0; i < 24; i++) {
    vec4 A = uRipA[i];
    if (A.w <= 0.0) continue;
    float age = uRTime - A.z;
    if (age < 0.0 || age > 10.0) continue;
    vec4 B = uRipB[i];
    float x = length(wp.xz - A.xy) - B.y * age;
    wp.y += A.w * 3.0 * exp(-x * x / (B.z * B.z * 4.0)) * exp(-age * B.w) * exp(-wp.y * 0.25);
  }

  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  float visible = step(aSeed.w, uDensity);
  float edge = min(min(local.x, 1.0 - local.x), min(local.z, 1.0 - local.z));
  float dist = -mv.z;
  vAlpha = visible * smoothstep(0.0, 0.08, edge) * smoothstep(2.0, 7.0, dist) * (0.35 + 0.65 * fract(aSeed.w * 7.13));
  vAlpha *= 0.55 + 0.45 * sin(uTime * (0.6 + aSeed.w) + ph * 3.0);
  vColor = uTint * (0.5 + glow * 0.3) + lightCol * 1.2;
  float size = (0.6 + fract(aSeed.w * 13.7) * 1.1) * (1.0 + glow * 0.8) * (1.0 + (uStreak - 1.0) * 0.5);
  gl_PointSize = clamp(size * uPixelScale / dist, 0.0, 28.0);
  if (visible < 0.5) gl_PointSize = 0.0;
}
`;

export const particleFragment = /* glsl */ `
uniform float uStreak;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  q.x *= uStreak;
  float d = length(q) * 2.0;
  float a = exp(-d * d * 4.0) * vAlpha;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor * a, a);
}
`;

/* ---------------------------------------------------------------- light echoes (billboards) */

export const orbVertex = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iCol;
attribute float iSize;
varying vec2 vUv;
varying vec4 vCol;
void main() {
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 wp = iPos + (right * position.x + up * position.y * 1.35) * iSize;
  vUv = uv;
  vCol = iCol;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const orbFragment = /* glsl */ `
varying vec2 vUv;
varying vec4 vCol;
void main() {
  vec2 q = vUv - 0.5;
  float d2 = dot(q, q) * 4.0;
  float core = exp(-d2 * 26.0) * 2.2 + exp(-d2 * 6.0) * 0.45 + exp(-d2 * 2.2) * 0.12;
  float a = core * vCol.a;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vCol.rgb * a, a);
}
`;

/* ---------------------------------------------------------------- final grade */

export const finishShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.35 },
    uGrain: { value: 0.035 },
    uFade: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uFade;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      vec2 q = vUv - 0.5;
      float v = 1.0 - dot(q, q) * uVignette * 2.2;
      col *= clamp(v, 0.0, 1.0);
      float n = hash(vUv * 1000.0 + fract(uTime) * 100.0) - 0.5;
      col += n * uGrain * (0.25 + sqrt(max(col, 0.0)) * 0.5);
      col *= uFade;
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};
