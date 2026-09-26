/**
 * Fiba as a soft sculpture: a signed-distance field made of smoothly blended ellipsoids,
 * raymarched inside a proxy box. Pose and life come from CatRig (JS) through uniforms.
 * Local space: y up, the seat at y = 0, +x toward her head in the curled pose, +z toward camera.
 */
export const PARTS = 12;
export const TAIL = 10;

export const catVertex = /* glsl */ `
varying vec3 vLocal;
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const catFragment = /* glsl */ `
#define PARTS ${PARTS}
#define TAIL ${TAIL}
uniform vec4 uPart[PARTS];   // xyz centre, w yaw
uniform vec4 uPartR[PARTS];  // xyz radii (0 = off), w blend
uniform vec4 uTail[TAIL];    // xyz, w radius
uniform vec3 uHeadPos;
uniform mat3 uHeadRot;       // head frame -> local
uniform vec4 uEars;          // x,y: left/right flick angle, z: ears back (0..1), w: unused
uniform vec4 uEyes;          // x,y: openness L/R (0..1), z: pupil width, w: gaze
uniform float uStretch;      // 0 curled .. 1 stretched (for the stripe direction)
uniform vec3 uCamLocal;
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
uniform vec3 uLampPos;       // local
uniform vec3 uLampColor;
uniform vec3 uMoonDir;       // local, toward the light
uniform vec3 uMoonColor;
uniform vec3 uAmbient;
uniform vec3 uGround;
uniform vec3 uGlowColor;
uniform float uGlow;         // music: a soft halo of light in her fur
uniform float uWhiskerGlow;
uniform float uReveal;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uCamDist;
uniform mat4 uClip;          // projection * view * model (for writing depth)
varying vec3 vLocal;

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
// round cone between two points (IQ)
float sdRoundCone(vec3 p, vec3 a, vec3 b, float r1, float r2) {
  vec3 ba = b - a;
  float l2 = dot(ba, ba);
  float rr = r1 - r2;
  float a2 = l2 - rr * rr;
  float il2 = 1.0 / l2;
  vec3 pa = p - a;
  float y = dot(pa, ba);
  float z = y - l2;
  vec3 xv = pa * l2 - ba * y;
  float x2 = dot(xv, xv);
  float y2 = y * y * l2;
  float z2 = z * z * l2;
  float k = sign(rr) * rr * rr * x2;
  if (sign(z) * a2 * z2 > k) return sqrt(x2 + z2) * il2 - r2;
  if (sign(y) * a2 * y2 < k) return sqrt(x2 + y2) * il2 - r1;
  return (sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}
// rounded cone along +y from the origin (ears)
float sdEarCone(vec3 p, float r1, float r2, float h) {
  vec2 q = vec2(length(p.xz), p.y);
  float b = (r1 - r2) / h;
  float a = sqrt(1.0 - b * b);
  float k = dot(q, vec2(-b, a));
  if (k < 0.0) return length(q) - r1;
  if (k > a * h) return length(q - vec2(0.0, h)) - r2;
  return dot(q, vec2(a, b)) - r1;
}

// ---------------------------------------------------------------- the field
vec3 headLocal(vec3 p) { return transpose(uHeadRot) * (p - uHeadPos); }

float sdEar(vec3 q, float side, float flick) {
  vec3 e = q - vec3(side * 0.037, 0.038, -0.006);
  // tilt outward and back, then the flick (a quick turn toward a sound)
  float roll = -side * (0.38 + uEars.z * 0.5);
  float c = cos(roll), s = sin(roll);
  e.xy = mat2(c, -s, s, c) * e.xy;
  float pitch = 0.18 + uEars.z * 0.5;
  c = cos(pitch); s = sin(pitch);
  e.yz = mat2(c, -s, s, c) * e.yz;
  c = cos(flick); s = sin(flick);
  e.xz = mat2(c, -s, s, c) * e.xz;
  e.z *= 2.3; // thin
  return sdEarCone(e, 0.024, 0.0045, 0.047) * 0.5;
}

float sdHead(vec3 q) {
  float d = sdEll(q, vec3(0.064, 0.056, 0.059));
  d = smin(d, sdEll(q - vec3(0.027, -0.02, 0.016), vec3(0.037, 0.031, 0.035)), 0.02);
  d = smin(d, sdEll(q - vec3(-0.027, -0.02, 0.016), vec3(0.037, 0.031, 0.035)), 0.02);
  d = smin(d, sdEll(q - vec3(0.0, -0.023, 0.049), vec3(0.029, 0.021, 0.024)), 0.018);
  d = smin(d, sdEll(q - vec3(0.0, -0.039, 0.034), vec3(0.019, 0.013, 0.017)), 0.012);
  d = smin(d, sdEar(q, 1.0, uEars.x), 0.012);
  d = smin(d, sdEar(q, -1.0, uEars.y), 0.012);
  return d;
}

float sdBody(vec3 p) {
  float d = 1e3;
  for (int i = 0; i < PARTS; i++) {
    vec4 R = uPartR[i];
    if (R.x <= 0.0) continue;
    vec4 C = uPart[i];
    d = smin(d, sdEll(yaw(p - C.xyz, C.w), R.xyz), R.w);
  }
  return d;
}

float sdTail(vec3 p) {
  float d = 1e3;
  for (int i = 0; i < TAIL - 1; i++) {
    d = min(d, sdRoundCone(p, uTail[i].xyz, uTail[i + 1].xyz, uTail[i].w, uTail[i + 1].w));
  }
  return d;
}

float map(vec3 p) {
  float d = sdBody(p);
  float dt = sdTail(p);
  d = smin(d, dt, 0.03);
  vec3 hp = p - uHeadPos;
  float hd = length(hp);
  float dh = hd > 0.16 ? hd - 0.12 : sdHead(headLocal(p));
  d = smin(d, dh, 0.028);
  // fur: a fine, soft irregularity on the surface
  d -= (vnoise(p * 110.0) - 0.5) * 0.0011 + (vnoise(p * 30.0) - 0.5) * 0.0009;
  return d;
}

vec3 calcNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float h = 0.0012;
  return normalize(k.xyy * map(p + k.xyy * h) + k.yyx * map(p + k.yyx * h) + k.yxy * map(p + k.yxy * h) + k.xxx * map(p + k.xxx * h));
}

float calcAO(vec3 p, vec3 n) {
  float occ = 0.0;
  float sca = 1.0;
  for (int i = 0; i < 5; i++) {
    float h = 0.006 + 0.028 * float(i);
    float d = map(p + n * h);
    occ += (h - d) * sca;
    sca *= 0.72;
  }
  return clamp(1.0 - 3.2 * occ, 0.0, 1.0);
}

vec2 boxHit(vec3 ro, vec3 rd) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (uBoxMin - ro) * inv;
  vec3 t1 = (uBoxMax - ro) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}

// ---------------------------------------------------------------- fur colour
const vec3 FUR = vec3(0.265, 0.245, 0.225);    // grey with a warm undertone
const vec3 STRIPE = vec3(0.075, 0.066, 0.058); // tabby stripes
const vec3 CREAM = vec3(0.62, 0.52, 0.41);     // muzzle, chest, paws
const vec3 EARPINK = vec3(0.62, 0.36, 0.27);
const vec3 NOSE = vec3(0.50, 0.26, 0.21);

vec3 bodyColor(vec3 p, vec3 n) {
  // mackerel stripes run down the flanks, perpendicular to the spine; the spine circles the curl
  // centre (near her paws), and along the top of the back they merge into one dark saddle
  // two stripe fields (curled / stretched) blended by colour, never by coordinate, so a pose
  // change fades the pattern over instead of scrambling it
  vec2 cc = p.xz - vec2(0.05, 0.06);
  float warp = vnoise(p * 14.0) * 1.6 + vnoise(p * 38.0) * 0.7;
  float sCurl = sin(atan(cc.y, cc.x) * 0.2 * 58.0 + warp * 2.4);
  float sLong = sin(p.x * 58.0 + warp * 2.4);
  float stripe = mix(sCurl, sLong, smoothstep(0.2, 0.8, uStretch));
  float flank = smoothstep(0.03, 0.07, p.y) * (1.0 - smoothstep(0.82, 0.98, n.y));
  float band = smoothstep(0.15, 0.75, stripe) * flank * mix(smoothstep(0.03, 0.09, length(cc)), 1.0, uStretch);
  vec3 c = mix(FUR, STRIPE, band * 0.92);
  // darker saddle along the back, creamy underneath
  c = mix(c, STRIPE * 1.35, smoothstep(0.5, 0.92, n.y) * (0.45 + 0.25 * vnoise(p * 24.0)));
  float under = smoothstep(0.045, 0.012, p.y) + smoothstep(-0.1, -0.5, n.y);
  c = mix(c, CREAM * 0.85, clamp(under, 0.0, 1.0) * 0.6);
  // salt-and-pepper ticking
  c *= 0.86 + 0.28 * vnoise(p * 230.0);
  return c;
}

vec3 tailColor(vec3 p) {
  // position along the tail (0 base .. 1 tip), from the nearest segment
  float best = 1e3;
  float tpos = 0.0;
  for (int i = 0; i < TAIL - 1; i++) {
    vec3 a = uTail[i].xyz;
    vec3 b = uTail[i + 1].xyz;
    vec3 ba = b - a;
    float h = clamp(dot(p - a, ba) / dot(ba, ba), 0.0, 1.0);
    float dd = length(p - a - ba * h);
    if (dd < best) { best = dd; tpos = (float(i) + h) / float(TAIL - 1); }
  }
  float rings = smoothstep(0.1, 0.6, sin(tpos * 34.0));
  vec3 c = mix(FUR * 1.05, STRIPE, rings * 0.8);
  c = mix(c, STRIPE * 0.9, smoothstep(0.8, 0.95, tpos)); // dark tip
  return c * (0.88 + 0.24 * vnoise(p * 230.0));
}

vec3 headColor(vec3 q, vec3 nl, out float eyeMask, out float earInner) {
  eyeMask = 0.0;
  earInner = 0.0;
  vec3 c = FUR * 1.05;
  // "M" on the forehead and the lines running back over the skull
  float fore = smoothstep(0.0, 0.03, q.y) * smoothstep(-0.01, 0.04, q.z);
  float mlines = smoothstep(0.35, 0.9, sin(q.x * 150.0 + sin(q.y * 90.0) * 0.8));
  c = mix(c, STRIPE, fore * mlines * 0.95);
  // darker crown and ear backs
  c = mix(c, STRIPE * 1.3, smoothstep(0.035, 0.06, q.y) * smoothstep(0.0, -0.03, q.z) * 0.6);
  // cheek line from the outer eye corner
  float cheek = smoothstep(0.004, 0.0, abs(q.y + 0.012 + (abs(q.x) - 0.03) * 0.5)) * smoothstep(0.028, 0.045, abs(q.x)) * smoothstep(0.0, 0.03, q.z);
  c = mix(c, STRIPE, cheek * 0.8);
  // creamy muzzle, chin and around the eyes
  float muzzle = smoothstep(0.036, 0.018, length((q - vec3(0.0, -0.028, 0.05)) * vec3(0.8, 1.0, 1.0)));
  c = mix(c, CREAM, muzzle * 0.9);
  float spectacles = smoothstep(0.02, 0.012, abs(length(vec2(abs(q.x) - 0.026, q.y - 0.006)) - 0.013)) * step(0.03, q.z);
  c = mix(c, CREAM * 0.95, spectacles * 0.45);
  // nose: a small dusty-pink triangle
  vec2 nq = vec2(q.x, q.y + 0.014);
  float nose = step(q.z, 0.09) * step(0.06, q.z) * smoothstep(0.0008, 0.0, abs(nq.x) - (nq.y + 0.005) * 0.8) * step(-0.005, nq.y) * step(nq.y, 0.0025);
  c = mix(c, NOSE, nose * 0.85);
  // ears: warm inside, facing forward
  if (q.y > 0.04) {
    earInner = smoothstep(0.0, 0.5, nl.z) * smoothstep(0.045, 0.06, q.y) * smoothstep(0.03, 0.01, abs(abs(q.x) - 0.046));
    c = mix(c, EARPINK, earInner * 0.7);
  }
  // eyes: closed = a soft dark line; open = green with a slit
  for (int s = 0; s < 2; s++) {
    float side = s == 0 ? 1.0 : -1.0;
    float open = s == 0 ? uEyes.x : uEyes.y;
    vec2 e = vec2(q.x - side * 0.026, q.y - 0.006);
    float ang = side * 0.28;
    e = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * e;
    if (q.z < 0.03) continue;
    // a closed eye: a short, soft, slightly smiling line
    float lid = smoothstep(0.0012, 0.0003, abs(e.y + e.x * e.x * 6.0 + 0.0005)) * smoothstep(0.014, 0.009, abs(e.x));
    c = mix(c, STRIPE * 0.55, lid * 0.85 * (1.0 - smoothstep(0.1, 0.4, open)));
    if (open > 0.02) {
      float almond = (e.x * e.x) / (0.0155 * 0.0155) + (e.y * e.y) / pow(0.0095 * open, 2.0);
      if (almond < 1.0) {
        float r = length(e / vec2(0.0155, 0.0095));
        vec3 iris = mix(vec3(0.32, 0.36, 0.10), vec3(0.50, 0.46, 0.14), r);
        float pupil = smoothstep(uEyes.z * 0.0035 + 0.0008, uEyes.z * 0.0035, abs(e.x));
        iris = mix(iris, vec3(0.01), pupil);
        iris += vec3(0.9) * smoothstep(0.0022, 0.0, length(e - vec2(-0.004, 0.003)));
        c = mix(c, iris, smoothstep(1.0, 0.8, almond));
        eyeMask = max(eyeMask, smoothstep(1.0, 0.8, almond));
      }
    }
  }
  return c * (0.9 + 0.2 * vnoise(q * 260.0));
}

void main() {
  vec3 ro = uCamLocal;
  vec3 rd = normalize(vLocal - ro);
  vec2 tb = boxHit(ro, rd);
  float t = max(tb.x, 0.0);
  float tmax = tb.y;
  bool hit = false;
  vec3 p = ro;
  for (int i = 0; i < 110; i++) {
    p = ro + rd * t;
    float d = map(p);
    if (d < 0.0005) { hit = true; break; }
    t += d * 0.85;
    if (t > tmax) break;
  }
  if (!hit) discard;

  vec3 n = calcNormal(p);
  vec3 v = -rd;
  float ao = calcAO(p, n);

  // which part are we on? (distances decide the material)
  float dB = sdBody(p);
  float dT = sdTail(p);
  vec3 q = headLocal(p);
  float dH = length(p - uHeadPos) > 0.16 ? 1.0 : sdHead(q);
  float eyeMask = 0.0;
  float earInner = 0.0;
  vec3 albedo;
  if (dH < dB && dH < dT) albedo = headColor(q, transpose(uHeadRot) * n, eyeMask, earInner);
  else if (dT < dB) albedo = tailColor(p);
  else albedo = bodyColor(p, n);
  // blend across the smooth joins so seams never show
  float wH = smoothstep(0.02, 0.0, dH - min(dB, dT));
  if (wH > 0.0 && wH < 1.0) albedo = mix(bodyColor(p, n), headColor(q, transpose(uHeadRot) * n, eyeMask, earInner), wH);

  // light: warm lamp, cool moon, soft ambient; fur gets a wrap-around sheen
  vec3 Lv = uLampPos - p;
  float ld = length(Lv);
  vec3 L = Lv / ld;
  float att = 1.0 / (1.0 + ld * ld * 0.9);
  float wrapL = pow(max(dot(n, L) * 0.6 + 0.4, 0.0), 1.6);
  float wrapM = pow(max(dot(n, uMoonDir) * 0.6 + 0.4, 0.0), 1.8);
  vec3 amb = mix(uGround, uAmbient, n.y * 0.5 + 0.5);
  vec3 col = albedo * (amb * ao + uLampColor * wrapL * att + uMoonColor * wrapM * (0.35 + 0.65 * ao));
  // rim sheen, kept out of the crease where she touches the seat
  float rim = pow(1.0 - max(dot(n, v), 0.0), 2.4) * smoothstep(0.015, 0.07, p.y);
  col += albedo * rim * (uLampColor * att * 1.3 + uMoonColor * 1.1) * ao * 1.2;
  col += EARPINK * earInner * uLampColor * att * 0.35; // light through the thin ears
  col += vec3(0.8) * eyeMask * pow(max(dot(reflect(-L, n), v), 0.0), 40.0) * att * 2.0;
  // music: a soft glow caught in her fur
  col += uGlowColor * (rim * 0.8 + 0.15) * uGlow * ao;

  // atmosphere, same as the room
  float fog = 1.0 - exp(-uCamDist * uFogDensity);
  col = mix(col, uFogColor, fog);
  col *= uReveal;

  vec4 clip = uClip * vec4(p, 1.0);
  gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;
  gl_FragColor = vec4(col, 1.0);
}
`;
