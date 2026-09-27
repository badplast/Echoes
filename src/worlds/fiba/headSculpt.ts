/** Reference sculpt: IMG_7316 (front), IMG_5795 (profile), IMG_6275 (sleep).
 * A tapered facial mask, shallow orbital volumes and cupped pinnae. The eye
 * aperture is shared by geometry and pigment, so opening a lid reveals a cornea.
 */
export const headSculpt = /* glsl */ `
vec3 headLocal(vec3 p) { return transpose(uHeadRot) * (p - uHeadPos) / 1.08; }
float smax(float a, float b, float k) { return -smin(-a, -b, k); }

vec3 earLocal(vec3 q, float side) {
  vec3 e = q - vec3(side * 0.037, 0.041, -0.016);
  float a = side * (0.23 + uEars.z * 0.3);
  e.xy = mat2(cos(a), -sin(a), sin(a), cos(a)) * e.xy;
  a = 0.10 + uEars.z * 0.3;
  e.yz = mat2(cos(a), -sin(a), sin(a), cos(a)) * e.yz;
  a = side > 0.0 ? uEars.x : uEars.y;
  e.xz = mat2(cos(a), -sin(a), sin(a), cos(a)) * e.xz;
  return e;
}
float sdEar(vec3 q, float side) {
  vec3 e = earLocal(q, side);
  e.z *= 2.2;
  float outer = sdEarCone(e, 0.026, 0.003, 0.057) * 0.44;
  float bowl = sdEarCone(e-vec3(0.0,0.006,0.016),0.0205,0.0015,0.049) * 0.44;
  return smax(outer,-bowl,0.002);
}

vec3 eyeLocal(vec3 q, float side) {
  vec3 e = q - vec3(side * 0.0255, 0.011, 0.027);
  // Both eyes sit on the sloping front of the skull, not on a flat front decal.
  float a = -side * 0.18;
  e.xz = mat2(cos(a), -sin(a), sin(a), cos(a)) * e.xz;
  e.y -= side * e.x * 0.10;
  return e;
}
float eyeOpening(vec3 e, float open) {
  float x = e.x / 0.0175;
  float arch = max(0.0, 1.0 - x * x);
  float centre = -0.002 + 0.002 * x * x;
  float halfHeight = 0.0125 * open * pow(arch, 0.85);
  return max(abs(e.y - centre) - halfHeight, abs(e.x) - 0.0175);
}
float sdCornea(vec3 e) { return sdEll(e, vec3(0.019, 0.018, 0.015)); }

float sdHead(vec3 q) {
  // One skull, narrowing continuously through the jaw. No inflated cheek balls.
  vec3 skull = q - vec3(0.0, 0.013, -0.013);
  float jaw = mix(0.76, 1.0, smoothstep(-0.041, 0.018, q.y));
  skull.x /= jaw;
  float d = sdEll(skull, vec3(0.057, 0.052, 0.049)) * jaw;
  vec3 mask = q - vec3(0.0, -0.009, 0.018);
  mask.x /= mix(0.62, 1.0, smoothstep(-0.041, 0.004, q.y));
  d = smin(d, sdEll(mask, vec3(0.046, 0.037, 0.032)), 0.009);
  // Straight bridge, short feline muzzle and a small chin under the mouth.
  d = smin(d, sdEll(q - vec3(0.0, -0.003, 0.039), vec3(0.013, 0.026, 0.020)), 0.007);
  d = smin(d, sdEll(q - vec3(0.0, -0.026, 0.040), vec3(0.026, 0.013, 0.017)), 0.005);
  d = smin(d, sdEll(q - vec3(0.0, -0.036, 0.033), vec3(0.018, 0.008, 0.017)), 0.004);
  d = smin(d, sdEll(q - vec3(0.0, -0.018, 0.058), vec3(0.008, 0.006, 0.004)), 0.003);
  for (int s = 0; s < 2; s++) {
    float side = s == 0 ? -1.0 : 1.0;
    float open = s == 0 ? uEyes.y : uEyes.x;
    vec3 e = eyeLocal(q, side);
    float aperture = eyeOpening(e, open);
    // A shallow orbital mound gives the closed lids their volume. Only the
    // opening is cut back, and an actual curved eye surface sits behind it.
    float orbit = sdEll(e - vec3(0.0, 0.001, -0.004), vec3(0.021, 0.014, 0.019));
    d = smin(d, orbit, 0.004);
    if (open > 0.015) {
      float cut = max(aperture, abs(e.z - 0.020) - 0.018);
      d = smax(d, -cut, 0.0008);
      d = min(d, max(sdCornea(e), aperture));
    }
  }
  d = smin(d, sdEar(q, -1.0), 0.005);
  d = smin(d, sdEar(q, 1.0), 0.005);
  return d;
}

vec3 headColor(vec3 q, vec3 nl, out float eyeMask, out float earInner) {
  eyeMask = 0.0; earInner = 0.0;
  vec3 c = FUR;
  // Fine tabby M, a dark bridge, two cheek strokes; no broad zebra mask.
  float forehead = smoothstep(0.004, 0.031, q.y) * smoothstep(-0.01, 0.021, q.z);
  float md = min(abs(abs(q.x)-(0.007+abs(q.y-0.027)*0.32)),abs(abs(q.x)-(0.021+(q.y-0.015)*0.27)));
  float lines = exp(-pow(md / 0.0019,2.0));
  c = mix(c, STRIPE, forehead * lines * 0.8);
  c = mix(c, STRIPE, smoothstep(0.010, 0.003, abs(q.x)) * smoothstep(0.00, 0.025, q.y) * 0.35);
  float cheek = smoothstep(0.024, 0.041, abs(q.x)) * smoothstep(-0.005, 0.024, q.z);
  float strokes = exp(-pow((q.y + 0.013 + (abs(q.x)-0.028)*0.35)*650.0,2.0));
  strokes += 0.6 * exp(-pow((q.y + 0.025 + (abs(q.x)-0.028)*0.2)*600.0,2.0));
  c = mix(c, STRIPE, cheek * min(1.0, strokes) * 0.85);
  float muzzle = smoothstep(0.036, 0.012, length((q - vec3(0.0,-0.029,0.046))*vec3(0.85,1.4,1.1)));
  c = mix(c, CREAM, muzzle * 0.95);
  float chin = smoothstep(-0.025,-0.036,q.y) * smoothstep(0.009,0.03,q.z);
  c = mix(c, CREAM, chin * 0.85);
  // Nose leather and a fine philtrum, not a large round bulb.
  vec2 nose = vec2(q.x, q.y + 0.019);
  float triangle = max(abs(nose.x) - (nose.y + 0.006) * 0.95, max(-nose.y - 0.006, nose.y - 0.003));
  float leather = smoothstep(0.0008,-0.0002,triangle) * smoothstep(0.056,0.060,q.z);
  c = mix(c, NOSE, leather);
  float philtrum = smoothstep(0.0010,0.00035,abs(q.x)) * smoothstep(-0.032,-0.029,q.y) * smoothstep(-0.023,-0.026,q.y) * step(0.051,q.z);
  float mouth = exp(-pow((q.y+0.033-abs(q.x)*0.18)*1100.0,2.0)) * smoothstep(0.019,0.006,abs(q.x)) * smoothstep(0.042,0.051,q.z);
  c = mix(c, STRIPE, max(philtrum,mouth)*0.6);
  for (int s = 0; s < 2; s++) {
    float side = s == 0 ? -1.0 : 1.0;
    vec3 ear = earLocal(q,side);
    float inner = smoothstep(0.006,0.018,ear.y) * smoothstep(0.063,0.044,ear.y) * smoothstep(0.020,0.010,abs(ear.x)) * smoothstep(0.0,0.012,ear.z);
    earInner = max(earInner,inner);
    c = mix(c,EARPINK,inner*0.7);
    vec3 e = eyeLocal(q,side);
    float open = s == 0 ? uEyes.y : uEyes.x;
    if (e.z < 0.008 || abs(e.x)>0.024 || abs(e.y)>0.023) continue;
    float edge = eyeOpening(e,open);
    float pale = exp(-pow((edge-0.003)*400.0,2.0));
    c = mix(c,CREAM*0.9,pale*0.3*smoothstep(0.1,0.5,open));
    float liner = smoothstep(0.00075,0.00015,abs(edge)) * smoothstep(0.018,0.012,abs(e.x));
    c = mix(c,STRIPE*0.28,liner*0.95);
    if(open > 0.015 && edge < 0.0002 && abs(sdCornea(e)) < 0.0012) {
      float radius = length(e.xy / vec2(0.015,0.014));
      float radial = atan(e.y,e.x);
      vec3 iris = mix(vec3(0.20,0.23,0.075),vec3(0.39,0.42,0.17),smoothstep(0.2,0.85,radius));
      iris *= 0.9 + 0.1*sin(radial*39.0+radius*24.0);
      float pupil = 1.0-smoothstep(0.0,0.001,abs(e.x)-0.0014*sqrt(max(0.0,1.0-pow(e.y/0.013,2.0))));
      iris = mix(iris,vec3(0.006,0.010,0.006),pupil);
      iris = mix(iris,vec3(0.016,0.022,0.012),smoothstep(0.70,1.03,radius));
      iris += vec3(0.45)*exp(-dot(e.xy-vec2(-0.004,0.004),e.xy-vec2(-0.004,0.004))/0.000002);
      c = iris;
      eyeMask = 1.0;
    }
  }
  return c * (0.96 + 0.08 * vnoise(q * 300.0));
}
`;
