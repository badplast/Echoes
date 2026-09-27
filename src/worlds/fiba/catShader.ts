import { headSculpt } from './headSculpt';

/**
 * Fiba as a soft sculpture: a signed-distance field raymarched inside a proxy box.
 * Torso, head and tail are blended softly; LEGS are separate capsules joined with a small blend
 * and an explicit crease, so they read as legs tucked against the body, not melted into it.
 * Pose and life come from CatRig (JS) through uniforms.
 * Local space: y up, the seat at y = 0, +x toward her head in the curled pose, +z toward camera.
 */
export const PARTS = 8;
export const LIMBS = 4;
export const TAIL = 14;

export const catVertex = /* glsl */ `
varying vec3 vLocal;
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const catFragment = /* glsl */ `
#define PARTS ${PARTS}
#define LIMBS ${LIMBS}
#define TAIL ${TAIL}
uniform vec4 uPart[PARTS];   // torso ellipsoids: xyz centre, w yaw
uniform vec4 uPartR[PARTS];  // xyz radii (0 = off), w blend
uniform vec4 uLimbA[LIMBS];  // upper end: xyz, w radius (0 = off)
uniform vec4 uLimbM[LIMBS];  // knee / elbow: xyz, w radius
uniform vec4 uLimbB[LIMBS];  // paw end: xyz, w radius
uniform vec4 uTail[TAIL];    // xyz, w radius
uniform vec3 uHeadPos;
uniform mat3 uHeadRot;       // head frame -> local
uniform vec4 uEars;          // x,y: flick L/R, z: ears back
uniform vec4 uEyes;          // x,y: openness L/R, z: pupil width
uniform float uStretch;
uniform vec3 uCamLocal;
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
uniform vec3 uKeyPos;        // warm key light (the lamp), local
uniform vec3 uKeyColor;
uniform vec3 uFillDir;       // cool light from the window, local, toward the light
uniform vec3 uFillColor;
uniform vec3 uAmbient;
uniform vec3 uGround;
uniform vec3 uRimColor;      // dreamy back light from the room (light only, never her fur)
uniform float uReveal;
uniform vec3 uFogColor;
uniform float uFog;
uniform mat4 uClip;
varying vec3 vLocal;

bool badf(float x) { return (floatBitsToUint(x) & 0x7F800000u) == 0x7F800000u; }
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

float sdEll(vec3 p, vec3 r) {
  r = max(r, vec3(1e-3)); // never divide by a vanishing radius (float overflow -> d = 0 everywhere)
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-6);
}
float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}
vec3 yaw(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}
float sdCapsule(vec3 p, vec3 a, vec3 b, float ra, float rb) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * h) - mix(ra, rb, h);
}
float sdEarCone(vec3 p, float r1, float r2, float h) {
  vec2 q = vec2(length(p.xz), p.y);
  float b = (r1 - r2) / h;
  float a = sqrt(1.0 - b * b);
  float k = dot(q, vec2(-b, a));
  if (k < 0.0) return length(q) - r1;
  if (k > a * h) return length(q - vec2(0.0, h)) - r2;
  return dot(q, vec2(a, b)) - r1;
}

// Linear albedo matched to the photos: a mid grey-brown coat with near-black-brown stripes and a
// cream muzzle/chest (the earlier values rendered her almost white under the lamp)
const vec3 FUR = vec3(0.265, 0.24, 0.2);
const vec3 STRIPE = vec3(0.055, 0.049, 0.041);
const vec3 CREAM = vec3(0.7, 0.63, 0.515);
const vec3 EARPINK = vec3(0.43, 0.28, 0.23);
const vec3 NOSE = vec3(0.32, 0.15, 0.115);

${headSculpt}

// ---------------------------------------------------------------- body parts
float sdTorso(vec3 p) {
  float d = 1e3;
  for (int i = 0; i < PARTS; i++) {
    vec4 R = uPartR[i];
    if (R.x < 0.003) continue;
    vec4 C = uPart[i];
    d = smin(d, sdEll(yaw(p - C.xyz, C.w), R.xyz), R.w);
  }
  return d;
}

float sdLimb(vec3 p, int i) {
  vec4 A = uLimbA[i], M = uLimbM[i], B = uLimbB[i];
  float d = smin(sdCapsule(p, A.xyz, M.xyz, A.w, M.w), sdCapsule(p, M.xyz, B.xyz, M.w, B.w * 0.8), 0.012);
  // the paw: a soft oval, flatter underneath, two shallow grooves between the toes
  vec3 dir = normalize(B.xyz - M.xyz + vec3(1e-5));
  vec3 pp = p - B.xyz - dir * B.w * 0.35;
  float paw = sdEll(pp, vec3(B.w * 1.25, B.w * 0.75, B.w * 1.45));
  vec3 side = normalize(cross(dir, vec3(0.0, 1.0, 0.0)) + vec3(1e-5));
  float s = dot(pp, side) / B.w;
  float toes = exp(-(s - 0.35) * (s - 0.35) * 81.0) + exp(-(s + 0.35) * (s + 0.35) * 81.0);
  paw += 0.00045 * toes * step(0.0, dot(pp, dir));
  return smin(d, paw, 0.005);
}

float sdLimbs(vec3 p) {
  float d = 1e3;
  for (int i = 0; i < LIMBS; i++) {
    if (uLimbA[i].w < 0.003) continue;
    d = min(d, sdLimb(p, i));
  }
  return d;
}

float sdTail(vec3 p) {
  float d = 1e3;
  for (int i = 0; i < TAIL - 1; i++) d = min(d, sdCapsule(p, uTail[i].xyz, uTail[i + 1].xyz, uTail[i].w, uTail[i + 1].w));
  return d;
}

float sdHeadWorld(vec3 p) {
  float hd = length(p - uHeadPos);
  return hd > 0.16 ? hd - 0.11 : sdHead(headLocal(p)) * 1.08;
}

float map(vec3 p) {
  float body = smin(sdTorso(p), sdHeadWorld(p), 0.011);

  // legs join with a small blend: a visible contour, not a melt
  body = smin(body, sdLimbs(p), 0.004);
  body = smax(body, -p.y + 0.001, 0.003);
  float d = smin(body, sdTail(p), 0.006);
  d -= (vnoise(p * 120.0) - 0.5) * 0.00035 + (vnoise(p * 34.0) - 0.5) * 0.00025;
  return d; // the tail may drape over the seat during a stretch
}

vec3 calcNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float h = 0.00055;
  return normalize(k.xyy * map(p + k.xyy * h) + k.yyx * map(p + k.yyx * h) + k.yxy * map(p + k.yxy * h) + k.xxx * map(p + k.xxx * h));
}

float calcAO(vec3 p, vec3 n) {
  float occ = 0.0;
  float sca = 1.0;
  for (int i = 0; i < 5; i++) {
    float h = 0.005 + 0.024 * float(i);
    occ += (h - map(p + n * h)) * sca;
    sca *= 0.7;
  }
  return clamp(1.0 - 3.4 * occ, 0.0, 1.0);
}

vec2 boxHit(vec3 ro, vec3 rd) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (uBoxMin - ro) * inv;
  vec3 t1 = (uBoxMax - ro) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}

// ---------------------------------------------------------------- fur colour (fixed: COLOR never touches her)
vec3 torsoColor(vec3 p, vec3 n) {
  float warp = vnoise(p * 24.0) * 2.0 + sin(p.y * 48.0 + p.z * 25.0) * 0.9;
  float pattern = sin(p.x * 176.0 + p.z * 24.0 + warp);
  float flank = 0.5 + 0.5 * (1.0 - abs(n.y));
  float broken = 0.45 + 0.55 * smoothstep(0.15,0.7,vnoise(p * 37.0));
  float band = smoothstep(0.65,0.95,pattern) * broken * flank;
  vec3 c = mix(FUR, STRIPE, band * 0.8);
  c = mix(c, STRIPE * 1.45, smoothstep(0.6,0.95,n.y) * 0.22);
  // horizontal "necklace" bands across the chest
  float chest = smoothstep(0.08, 0.13, p.x) * smoothstep(0.02, 0.07, p.z);
  c = mix(c, STRIPE * 1.2, chest * smoothstep(0.3, 0.8, sin(p.y * 150.0 + vnoise(p * 40.0) * 2.0)) * 0.55);
  float under = smoothstep(0.045, 0.012, p.y) + smoothstep(-0.1, -0.5, n.y);
  c = mix(c, CREAM * 0.85, clamp(under, 0.0, 1.0) * 0.6);
  return c * (0.94 + 0.12 * vnoise(p * 330.0));
}

vec3 limbColor(vec3 p, int i) {
  vec4 A = uLimbA[i], B = uLimbB[i];
  vec3 ba = B.xyz - A.xyz;
  float h = clamp(dot(p - A.xyz, ba) / dot(ba, ba), 0.0, 1.2);
  // rings down the leg, cream "socks" on the paws
  float rings = smoothstep(0.2, 0.7, sin(h * 26.0 + vnoise(p * 30.0) * 2.0)) * (1.0 - smoothstep(0.6, 0.85, h));
  vec3 c = mix(FUR * 1.02, STRIPE, rings * 0.75);
  c = mix(c, CREAM, smoothstep(0.72, 0.95, h));
  return c * (0.95 + 0.1 * vnoise(p * 330.0));
}

vec3 tailColor(vec3 p) {
  float best = 1e3;
  float tpos = 0.0;
  for (int i = 0; i < TAIL - 1; i++) {
    vec3 a = uTail[i].xyz;
    vec3 ba = uTail[i + 1].xyz - a;
    float h = clamp(dot(p - a, ba) / dot(ba, ba), 0.0, 1.0);
    float dd = length(p - a - ba * h);
    if (dd < best) { best = dd; tpos = (float(i) + h) / float(TAIL - 1); }
  }
  float rings = smoothstep(0.1, 0.6, sin(tpos * 34.0));
  vec3 c = mix(FUR * 1.05, STRIPE * 1.2, rings * 0.65);
  c = mix(c, STRIPE * 0.9, smoothstep(0.84, 0.96, tpos));
  return c * (0.95 + 0.1 * vnoise(p * 330.0));
}

void main() {
  vec3 ro = uCamLocal;
  vec3 rd = normalize(vLocal - ro);
  vec2 tb = boxHit(ro, rd);
  float t = max(tb.x, 0.0);
  float tmax = tb.y;
  bool hit = false;
  vec3 p = ro;
  float dmin = 1e3;
  float tmin = t;
  for (int i = 0; i < 196; i++) {
    p = ro + rd * t;
    float d = map(p);
    if (d < dmin) { dmin = d; tmin = t; }
    if (d < 0.00022) { hit = true; break; }
    t += d * 0.65;
    if (t > tmax) break;
  }
  // soft fur fringe: rays that graze the silhouette get a translucent edge instead of a hard cut
  const float FRINGE = 0.0015;
  float alpha = 1.0;
  if (!hit) {
    if (dmin > FRINGE) discard;
    alpha = pow(1.0 - dmin / FRINGE, 2.2) * (0.35 + 0.35 * vnoise((ro + rd * tmin) * 400.0));
    if (alpha < 0.02) discard;
    p = ro + rd * tmin;
  }

  vec3 n = calcNormal(p);
  vec3 v = -rd;
  // fur strands: fine anisotropic ripples perturb the shading normal (not the shape)
  {
    vec3 fp = p * vec3(1600.0, 190.0, 1200.0);
    vec3 g = vec3(vnoise(fp + vec3(1.3, 0.0, 0.0)) - vnoise(fp - vec3(1.3, 0.0, 0.0)),
                  vnoise(fp + vec3(0.0, 1.3, 0.0)) - vnoise(fp - vec3(0.0, 1.3, 0.0)),
                  vnoise(fp + vec3(0.0, 0.0, 1.3)) - vnoise(fp - vec3(0.0, 0.0, 1.3)));
    n = normalize(n + (g - n * dot(g, n)) * 0.18);
  }
  float ao = calcAO(p, n);

  float dT = sdTorso(p), dL = sdLimbs(p), dTl = sdTail(p);
  vec3 q = headLocal(p);
  float dH = sdHeadWorld(p);
  float eyeMask = 0.0, earInner = 0.0;
  vec3 nl = transpose(uHeadRot) * n;
  float m = min(min(dT, dL), min(dTl, dH));
  vec3 albedo;
  if (m == dH) albedo = headColor(q, nl, eyeMask, earInner);
  else if (m == dL) {
    int li = 0;
    float best = 1e3;
    for (int i = 0; i < LIMBS; i++) {
      float di = uLimbA[i].w >= 0.003 ? sdLimb(p, i) : 1e3;
      if (di < best) { best = di; li = i; }
    }
    albedo = limbColor(p, li);
  } else if (m == dTl) albedo = tailColor(p);
  else albedo = torsoColor(p, n);
  // soften the head seam into the body
  float wH = smoothstep(0.02, 0.0, dH - min(dT, dTl));
  if (m != dH && m != dL && wH > 0.0) albedo = mix(albedo, headColor(q, nl, eyeMask, earInner), wH);

  // Short directional guard hairs break up the smooth sculpt at close range.
  vec3 furSpace = m == dH ? q * vec3(1300.0, 180.0, 1100.0) : p * vec3(190.0, 1300.0, 1100.0);
  float hair = vnoise(furSpace) - 0.5;
  albedo *= 1.0 + hair * 0.24 * (1.0-eyeMask);
  if (eyeMask > 0.5) n = calcNormal(p);
  // crease where a leg meets body or tail: a thin soft shadow line
  float crease = smoothstep(0.006, 0.0, abs(dL - min(dT, dTl))) * smoothstep(0.02, 0.0, dL);
  ao *= 1.0 - crease * 0.55;

  vec3 Lv = uKeyPos - p;
  float ld = length(Lv);
  vec3 L = Lv / ld;
  float att = 1.0 / (1.0 + ld * ld * 0.7);
  float wrapK = pow(max(dot(n, L) * 0.6 + 0.4, 0.0), 1.6);
  float wrapF = pow(max(dot(n, uFillDir) * 0.6 + 0.4, 0.0), 1.8);
  vec3 amb = mix(uGround, uAmbient, n.y * 0.5 + 0.5);
  vec3 col = albedo * (amb * ao + uKeyColor * wrapK * att + uAmbient * max(dot(n,normalize(vec3(-0.6,0.9,0.8))),0.0) * 0.65 + uFillColor * wrapF * (0.35 + 0.65 * ao));
  // rim sheen, subtle, and never on the translucent fringe (that read as a glow round her)
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0) * smoothstep(0.015, 0.07, p.y) * (hit ? 0.7 : 0.0);
  col += albedo * rim * (uKeyColor * att + uRimColor) * ao * 1.3;
  col += EARPINK * earInner * uKeyColor * att * 0.3;
  col += vec3(0.8) * eyeMask * pow(max(dot(reflect(-L, n), v), 0.0), 40.0) * att * 2.0;

  col = mix(col, uFogColor, uFog);
  // never let a numerical accident reach the HDR buffer (bloom would smear it into black blocks)
  if (badf(col.r) || badf(col.g) || badf(col.b)) col = vec3(0.0);
  col = clamp(col, 0.0, 64.0);
  vec4 clip = uClip * vec4(p, 1.0);
  gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;
  gl_FragColor = vec4(col * uReveal, alpha);
}
`;
