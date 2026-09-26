/** Pool sizes shared by JS and GLSL. */
export const RIPPLES = 36; // 0..27 note ripples, 28..35 drips
export const NOTE_RIPPLES = 28;
export const ORBS = 24;

/* Atmosphere shared by sky, water reflections and mist so that light agrees everywhere.
 * The shores of Plastun bay live here too, as a function of view direction: they are kilometres
 * away, so parallax is negligible, and being part of "the sky" they reflect in the water and
 * tint the haze at the horizon for free. */
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
uniform float uGlow;
uniform float uDiscGain;
uniform float uHazeAmt;   // strength of the horizon haze band
uniform float uHazeK;     // sharpness of the band (higher = thinner, clearer air)
uniform vec3 uLandColor;  // hills, before aerial perspective
uniform float uLights;    // harbour lights + lighthouse (night)
uniform sampler2D uCloudTex;

#define DEG 0.01745329

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

/* 0 = straight out to sea (bearing ~108 deg, ESE), positive = right (south shore). */
float azim(vec3 d) { return atan(d.x, -d.z); }

float bump(float x, float c, float w) { float t = (x - c) / w; return exp(-t * t); }

/* Elevation (radians) of the shore silhouette at azimuth a, or -1 over open sea.
 * far: 0 near .. 1 far, for aerial perspective. */
float ridge(float a, out float far, bool detail) {
  float x = a / DEG;
  far = 0.0;
  float h = -1.0;
  // South shore: cape Yakubovskogo at +17 deg, forested hills rising toward the right edge.
  if (x > 13.0) {
    float t = x - 17.0;
    float cape = smoothstep(-0.8, 2.2, t);
    float hills = 1.7 + max(t, 0.0) * 0.1
      + 1.2 * bump(x, 22.5, 3.2) + 2.2 * bump(x, 31.0, 5.0) + 3.1 * bump(x, 44.0, 7.5) + 2.8 * bump(x, 62.0, 10.0);
    hills += (textureLod(uCloudTex, vec2(x * 0.011, 0.37), 0.0).r - 0.5) * 1.0;
    if (detail) hills += (textureLod(uCloudTex, vec2(x * 0.09, 0.61), 0.0).g - 0.5) * 0.16; // tree crowns
    h = hills * cape;
    if (detail) {
      // kekurs: sea stacks standing off the cape
      float s1 = pow(max(0.0, 1.0 - abs(x - 15.2) / 0.24), 1.6) * 0.95;
      float s2 = pow(max(0.0, 1.0 - abs(x - 14.3) / 0.17), 1.6) * 0.55;
      h = max(h, max(s1, s2));
    }
    far = mix(0.7, 0.32, smoothstep(17.0, 58.0, x));
  }
  // Harbour breakwater: a thin low line at the foot of the hills.
  if (detail && x > 5.0 && x < 16.5) {
    float bw = 0.12 * smoothstep(5.0, 6.2, x);
    if (bw > h) { h = bw; far = 0.64; }
  }
  // North shore: cape Astasheva at -30 deg.
  if (x < -27.5) {
    float t = -30.0 - x;
    float cape = smoothstep(-1.4, 1.6, t);
    float hills = 1.3 + max(t, 0.0) * 0.05 + 1.0 * bump(x, -35.5, 3.5) + 1.7 * bump(x, -49.0, 8.0);
    hills += (textureLod(uCloudTex, vec2(x * 0.011, 0.71), 0.0).r - 0.5) * 0.6;
    if (detail) hills += (textureLod(uCloudTex, vec2(x * 0.09, 0.23), 0.0).g - 0.5) * 0.12;
    float nh = hills * cape;
    if (nh > h) { h = nh; far = 0.66; }
  }
  return h < 0.0 ? -1.0 : h * DEG;
}

/* Sky without the sun disc: gradient and the glow around the luminary. */
vec3 skyGradient(vec3 dir) {
  float h = max(dir.y, 0.0);
  float up = pow(clamp(h * 2.4, 0.0, 1.0), 0.6);
  vec3 col = mix(uHorizon, uZenith, up);
  float sd = max(dot(dir, uSunDir), 0.0);
  float band = exp(-abs(h - uSunDir.y * 0.35) * 11.0);
  col += uSunColor * (pow(sd, 9.0) * 0.08 * uGlow + pow(sd, 48.0) * 0.2 * uGlow + pow(sd, 400.0) * 0.45) * (0.6 + 0.4 * band);
  col += uSunColor * band * pow(sd, 2.5) * 0.05 * uGlow;
  return col;
}

/* The colour everything melts into at the horizon, in this direction. */
vec3 horizonTint(vec3 dir) {
  vec3 flatDir = normalize(vec3(dir.x, 0.0, dir.z));
  return mix(skyGradient(flatDir), uFogColor, 0.35);
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
    vec3 cloudCol = mix(uFogColor * 1.1 + uZenith * 0.2, uHorizon * 0.9, 0.35);
    cloudCol += uSunColor * (pow(sd, 6.0) * 0.5 + pow(sd, 40.0) * 0.7); // silver lining toward the light
    col = mix(col, cloudCol, c * 0.85);
  }
  return col;
}

/* Hills: dark forest under aerial perspective, mist pooled at their feet, a rim of light on crests. */
vec3 landColor(vec3 dir, float top, float far) {
  float v = clamp(dir.y / max(top, 1e-4), 0.0, 1.0);
  vec3 T = horizonTint(dir);
  float a = azim(dir);
  float tex = textureLod(uCloudTex, vec2(a * 3.0, dir.y * 9.0), 0.0).b - 0.5; // patches of forest
  vec3 col = uLandColor * (1.0 + tex * 0.35);
  col = mix(col, T, far);
  col = mix(col, T, (1.0 - v) * (1.0 - v) * 0.35 * (0.4 + far));
  vec3 fl = normalize(vec3(dir.x, 0.0, dir.z));
  vec3 sl = normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + 1e-4);
  float sunSide = max(dot(fl, sl), 0.0);
  col += uSunColor * pow(v, 5.0) * pow(sunSide, 6.0) * 0.07 * (1.0 - far * 0.5);
  return col;
}

/* Harbour lights on the breakwater and the lighthouse on cape Yakubovskogo (night only). */
vec3 shoreLights(vec3 dir) {
  if (uLights <= 0.001) return vec3(0.0);
  float x = azim(dir) / DEG;
  float y = dir.y / DEG;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float lx = 7.0 + fi * 1.55 + sin(fi * 7.1) * 0.3;
    float dx = (x - lx) / 0.07;
    float dy = (y - 0.16) / 0.05;
    acc += vec3(1.0, 0.72, 0.42) * exp(-(dx * dx + dy * dy)) * (0.8 + 0.2 * sin(uTime * 0.7 + fi * 3.0));
  }
  // lighthouse: a slow pulse on the crest above the cape
  float blink = pow(max(0.0, sin(uTime * 0.9)), 10.0);
  float lhx = (x - 19.2) / 0.09;
  float lhy = (y - 2.35) / 0.07;
  acc += vec3(1.0, 0.9, 0.75) * exp(-(lhx * lhx + lhy * lhy)) * (0.25 + blink * 2.5);
  return acc * uLights * 1.6;
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

/* Everything seen in a direction: sky (with clouds; stars and disc when looked at directly)
 * or the shore in front of it, with an antialiased silhouette. */
vec3 scene(vec3 dir, bool direct) {
  float far = 0.0;
  float top = ridge(azim(dir), far, true);
  float px = 0.0009;
  float land = top > 0.0 ? smoothstep(top + px, top - px, dir.y) : 0.0;
  vec3 sky = vec3(0.0);
  if (land < 1.0) {
    sky = skyWithClouds(dir);
    if (direct) {
      float c = cloudCover(dir);
      sky += (stars(dir) + luminaryDisc(dir)) * (1.0 - c * 0.85);
    }
  }
  vec3 col = sky;
  if (land > 0.0) col = mix(sky, landColor(dir, top, far), land);
  return col + shoreLights(dir);
}

/* The colour at the very horizon line in this direction: shore foot if there is one, else sky. */
vec3 horizonTarget(vec3 dir) {
  vec3 flatDir = normalize(vec3(dir.x, 0.0005, dir.z));
  float far = 0.0;
  // smooth profile only: stacks and the breakwater must not streak the haze
  float top = ridge(azim(flatDir), far, false);
  vec3 res = horizonTint(flatDir);
  // weight by the height of the shore so the target never jumps where a cape begins
  float presence = smoothstep(0.0, 0.9 * DEG, top);
  if (presence > 0.0) res = mix(res, mix(landColor(flatDir, top, far), res, 0.3), presence);
  return res;
}

/* Symmetric haze band around the horizon: sky and water converge to the same colour. */
vec3 applyHaze(vec3 col, vec3 dir) {
  float band = uHazeAmt * exp(-abs(dir.y) * uHazeK);
  return mix(col, horizonTarget(dir), clamp(band, 0.0, 1.0));
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
    float wl = w * 0.2;
    // light fades twice as fast as the wave itself, so old rings never linger as bands
    float crest = exp(-x * x / (wl * wl)) * fall * fall * min(age * 4.0, 1.0) / sqrt(1.0 + r * 0.1);
    vec4 C = uRipC[i];
    lightOut += C.rgb * (C.a * (crest * 2.2 + env * fall * 0.15 * max(c, 0.0)));
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
