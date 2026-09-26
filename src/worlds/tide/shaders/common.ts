/** Pool sizes shared by JS and GLSL. */
export const RIPPLES = 32; // 0..23 note ripples, 24..31 drips
export const NOTE_RIPPLES = 24;
export const ORBS = 16;

/* Atmosphere shared by sky, water reflections and mist so that light agrees everywhere. */
export const atmosphere = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform vec3 uFogColor;
uniform vec3 uSunDir;
uniform float uSunSize;
uniform float uNight;
uniform float uCloud;
uniform float uTime;
uniform float uHaze;
uniform float uGlow;
uniform float uDiscGain;
uniform sampler2D uCloudTex;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

/* Sky without the sun disc: gradient, horizon haze and the wide glow around the luminary. */
vec3 skyGradient(vec3 dir) {
  float h = dir.y;
  float up = pow(clamp(h * 2.4, 0.0, 1.0), 0.6);
  vec3 col = mix(uHorizon, uZenith, up);
  // a thin brighter band just above the horizon gives depth to the distance
  col += uHorizon * 0.35 * exp(-max(h, 0.0) * 28.0) * uHaze;
  col = mix(col, uFogColor, smoothstep(0.015, -0.08, h));
  float sd = max(dot(dir, uSunDir), 0.0);
  float band = exp(-abs(h - uSunDir.y * 0.35) * 11.0);
  col += uSunColor * (pow(sd, 9.0) * 0.08 * uGlow + pow(sd, 48.0) * 0.2 * uGlow + pow(sd, 400.0) * 0.45) * (0.6 + 0.4 * band);
  col += uSunColor * band * pow(sd, 2.5) * 0.05 * uGlow;
  return col;
}

float cloudCover(vec3 dir) {
  if (dir.y < 0.005) return 0.0;
  vec2 uv = dir.xz / (dir.y + 0.06);
  uv *= vec2(0.035, 0.09);
  uv += vec2(uTime * 0.0018, uTime * 0.0006);
  float n = texture2D(uCloudTex, uv).r * 0.55 + texture2D(uCloudTex, uv * 2.9 + 0.37).g * 0.3 + texture2D(uCloudTex, uv * 7.3 + 0.71).b * 0.15;
  float c = smoothstep(0.62 - uCloud * 0.4, 0.98 - uCloud * 0.25, n);
  return c * smoothstep(0.005, 0.16, dir.y) * (0.06 + 0.94 * uCloud);
}

vec3 skyWithClouds(vec3 dir) {
  vec3 col = skyGradient(dir);
  float c = cloudCover(dir);
  if (c > 0.0) {
    float sd = max(dot(dir, uSunDir), 0.0);
    vec3 cloudCol = mix(uFogColor * 1.15 + uZenith * 0.2, uHorizon * 0.9, 0.35);
    cloudCol += uSunColor * (pow(sd, 6.0) * 0.55 + pow(sd, 40.0) * 0.8); // silver lining toward the light
    col = mix(col, cloudCol, c * 0.85);
  }
  return col;
}

vec3 stars(vec3 dir) {
  if (uNight <= 0.001 || dir.y <= 0.0) return vec3(0.0);
  vec2 uv = vec2(atan(dir.x, dir.z), asin(clamp(dir.y, -1.0, 1.0))) * 150.0;
  vec2 id = floor(uv);
  vec2 f = fract(uv) - 0.5;
  float h = hash12(id);
  if (h < 0.982) return vec3(0.0);
  vec2 off = (hash22(id) - 0.5) * 0.5;
  float s = smoothstep(0.26, 0.0, length(f - off));
  float mag = pow((h - 0.982) / 0.018, 3.0);
  float tw = 0.65 + 0.35 * sin(uTime * (1.5 + h * 3.0) + h * 91.0);
  return vec3(0.8, 0.87, 1.0) * s * mag * tw * uNight * smoothstep(0.02, 0.3, dir.y) * 2.2;
}

vec3 luminaryDisc(vec3 dir) {
  float sd = dot(dir, uSunDir);
  float disc = smoothstep(uSunSize, uSunSize + 0.00002 + (1.0 - uSunSize) * 0.12, sd);
  return uSunColor * disc * uDiscGain;
}
`;

/* Radial wave packets for note ripples, shared by the water vertex + fragment shaders. */
export const rippleChunk = /* glsl */ `
#define RIPPLES ${RIPPLES}
uniform vec4 uRipA[RIPPLES]; // x, z, startTime, amplitude
uniform vec4 uRipB[RIPPLES]; // wavenumber, speed, width, decay
uniform vec4 uRipC[RIPPLES]; // rgb, light
uniform float uRTime;

// returns (height, dh/dx, dh/dz); lightOut accumulates the luminous ring
vec3 ripples(vec2 p, inout vec3 lightOut) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < RIPPLES; i++) {
    vec4 A = uRipA[i];
    if (A.w <= 0.0) continue;
    float age = uRTime - A.z;
    if (age < 0.0) continue;
    vec4 B = uRipB[i];
    float fall = exp(-age * B.w);
    if (fall < 0.004) continue;
    vec2 d = p - A.xy;
    float r = length(d) + 1e-3;
    float x = r - B.y * age;
    float w = B.z * (1.0 + age * 0.3);
    float g = exp(-x * x / (w * w));
    float env = g * fall * min(age * 5.0, 1.0) / sqrt(1.0 + r * 0.12);
    float ph = B.x * x;
    float s = sin(ph);
    float c = cos(ph);
    acc.x += A.w * env * s;
    float dh = A.w * env * (B.x * c - 2.0 * x / (w * w) * s);
    acc.yz += dh * d / r;
    // the luminous crest: a thin bright line riding the wave front
    float wl = w * 0.35;
    // light fades twice as fast as the wave itself, so old rings never linger as bands
    float crest = exp(-x * x / (wl * wl)) * fall * fall * min(age * 4.0, 1.0) / sqrt(1.0 + r * 0.1);
    vec4 C = uRipC[i];
    lightOut += C.rgb * (C.a * (crest * 2.6 + env * fall * 0.3 * max(c, 0.0)));
  }
  return acc;
}

float rippleHeight(vec2 p) {
  float h = 0.0;
  for (int i = 0; i < RIPPLES; i++) {
    vec4 A = uRipA[i];
    if (A.w <= 0.0) continue;
    float age = uRTime - A.z;
    if (age < 0.0) continue;
    vec4 B = uRipB[i];
    float fall = exp(-age * B.w);
    if (fall < 0.004) continue;
    float r = length(p - A.xy) + 1e-3;
    float x = r - B.y * age;
    float w = B.z * (1.0 + age * 0.3);
    h += A.w * exp(-x * x / (w * w)) * fall * min(age * 5.0, 1.0) / sqrt(1.0 + r * 0.12) * sin(B.x * x);
  }
  return h;
}
`;

/* Light echoes: rising luminous seeds. Read by water (reflection + light pools), mist, particles. */
export const orbChunk = /* glsl */ `
#define ORBS ${ORBS}
uniform vec4 uOrbPos[ORBS]; // xyz, radius
uniform vec4 uOrbCol[ORBS]; // rgb, intensity
`;

/* Long swell: a few directional waves with analytic gradients. */
export const swellChunk = /* glsl */ `
uniform float uSwell;
uniform float uWaveTime;
uniform vec2 uWind;

vec3 swell(vec2 p) {
  vec3 acc = vec3(0.0);
  vec2 dirs[4];
  dirs[0] = uWind;
  dirs[1] = normalize(uWind + vec2(0.55, 0.3));
  dirs[2] = normalize(uWind + vec2(-0.45, 0.4));
  dirs[3] = normalize(vec2(-uWind.y, uWind.x) * 0.6 + uWind);
  float ks[4];
  ks[0] = 0.045; ks[1] = 0.09; ks[2] = 0.16; ks[3] = 0.27;
  float as[4];
  as[0] = 1.0; as[1] = 0.55; as[2] = 0.3; as[3] = 0.16;
  for (int i = 0; i < 4; i++) {
    float k = ks[i];
    float w = sqrt(9.8 * k);
    float ph = k * dot(dirs[i], p) - w * uWaveTime + float(i) * 1.7;
    float a = as[i] * uSwell;
    acc.x += a * sin(ph);
    acc.yz += a * k * cos(ph) * dirs[i];
  }
  return acc;
}
`;
