import { atmosphere, orbChunk, rippleChunk, swellChunk } from './common';

export const waterVertex = /* glsl */ `
${rippleChunk}
${swellChunk}
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float dist = length(wp.xz - cameraPosition.xz);
  float near = 1.0 - smoothstep(60.0, 260.0, dist);
  float h = swell(wp.xz).x;
  if (near > 0.0) h += rippleHeight(wp.xz) * near;
  wp.y += h;
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const waterFragment = /* glsl */ `
${atmosphere}
${rippleChunk}
${orbChunk}
${swellChunk}
uniform sampler2D uDetailTex;
uniform float uDetail;
uniform float uRain;
uniform float uGloss;
uniform float uFogDensity;
uniform vec3 uWaterColor;
uniform vec3 uAccent;
uniform float uMetal;
varying vec3 vWorld;

vec2 detailGrad(vec2 p) {
  vec2 w = uWind;
  vec2 uv1 = p * 0.021 + w * uWaveTime * 0.011;
  vec2 uv2 = vec2(p.x * 0.055 - p.y * 0.012, p.y * 0.055 + p.x * 0.012) - vec2(w.y, -w.x) * uWaveTime * 0.017;
  vec2 uv3 = p * 0.14 + w * uWaveTime * 0.03;
  vec4 a = texture2D(uDetailTex, uv1) * 2.0 - 1.0;
  vec4 b = texture2D(uDetailTex, uv2) * 2.0 - 1.0;
  vec4 c = texture2D(uDetailTex, uv3) * 2.0 - 1.0;
  return a.xy * 0.55 + b.zw * 0.35 + c.xy * 0.22 * (0.4 + uDetail);
}

// Rain: tiny rings in a jittered grid, two layers.
vec2 rainGrad(vec2 p, float t) {
  vec2 g = vec2(0.0);
  for (int l = 0; l < 2; l++) {
    float cs = l == 0 ? 1.7 : 2.9;
    vec2 q = p / cs + float(l) * 17.3;
    vec2 id = floor(q);
    float h = hash12(id);
    if (h > uRain) continue;
    vec2 f = fract(q) - 0.5 - (hash22(id) - 0.5) * 0.4;
    float ph = fract(t * (0.7 + h * 0.6) + h * 13.0);
    float r = length(f) * cs;
    float x = r - ph * cs * 0.42;
    float env = exp(-x * x * 90.0) * (1.0 - ph) * (1.0 - ph);
    g += env * cos(x * 45.0) * 1.6 * f / (length(f) + 1e-3);
  }
  return g;
}

void main() {
  vec3 P = vWorld;
  vec3 toCam = cameraPosition - P;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec2 p = P.xz;

  vec3 ringLight = vec3(0.0);
  vec3 sw = swell(p);
  vec3 rp = ripples(p, ringLight);
  float fade = exp(-dist * 0.011);
  vec2 g = sw.yz + rp.yz;
  g += detailGrad(p) * uDetail * (0.25 + 0.75 * fade);
  if (uRain > 0.001) g += rainGrad(p, uTime * 1.3) * uRain * exp(-dist * 0.06);
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
  N = normalize(mix(N, vec3(0.0, 1.0, 0.0), smoothstep(120.0, 900.0, dist) * 0.8));

  vec3 R = reflect(-V, N);
  R.y = abs(R.y) + 0.002;
  float ndv = max(dot(N, V), 0.0);
  float fres = 0.025 + 0.975 * pow(1.0 - ndv, 5.0);
  fres = mix(fres, 0.55 + 0.45 * fres, uMetal);

  vec3 refl = skyWithClouds(R) * 0.82;
  float sdot = max(dot(R, uSunDir), 0.0);
  // energy-capped glitter: a mirror-smooth surface must not feed the bloom a white-hot sheet
  vec3 spec = uSunColor * (pow(sdot, uGloss) * min(uGloss * 0.006, 3.2) + pow(sdot, uGloss * 0.08) * 0.3);

  // body of the water: deep colour, lifted on crests and by the light above it
  float crest = clamp(sw.x * 0.6 + rp.x * 1.5, -1.0, 1.0);
  vec3 body = uWaterColor * (0.75 + 0.35 * crest) + uAccent * max(rp.x, 0.0) * 0.18;
  body += uFogColor * 0.06;

  vec3 col = mix(body, refl, fres) + spec * (0.3 + 0.7 * fres);

  // light echoes: reflected in the rippled surface + soft pools of light beneath them
  for (int i = 0; i < ORBS; i++) {
    vec4 C = uOrbCol[i];
    if (C.a <= 0.001) continue;
    vec4 O = uOrbPos[i];
    vec3 op = O.xyz - P;
    float t = max(dot(op, R), 0.0);
    vec3 cp = P + R * t - O.xyz;
    float rr = O.w * (1.0 + t * 0.018);
    float refl2 = exp(-dot(cp, cp) / (rr * rr));
    col += C.rgb * C.a * refl2 * (0.45 + fres) * 1.4;
    float hd = dot(op.xz, op.xz);
    col += C.rgb * C.a * 0.07 / (1.0 + hd / (O.w * O.w * 1.5 + O.y * O.y * 0.5));
  }

  col += ringLight * (0.6 + 0.4 * fres);

  // atmosphere: fog takes the colour of the sky right above the horizon, including the sun glow
  float fog = 1.0 - exp(-dist * uFogDensity);
  vec3 fogDir = normalize(vec3(-V.x, 0.012, -V.z));
  vec3 fogCol = skyGradient(fogDir);
  col = mix(col, fogCol, clamp(fog, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}
`;
