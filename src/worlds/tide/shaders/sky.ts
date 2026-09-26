import { atmosphere } from './common';

export const skyVertex = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.z = gl_Position.w; // always at the far plane
}
`;

export const skyFragment = /* glsl */ `
${atmosphere}
varying vec3 vWorld;
void main() {
  vec3 dir = normalize(vWorld - cameraPosition);
  // below the horizon only a sliver past the far edge of the water is visible: give it the horizon
  vec3 col = dir.y < 0.0 ? horizonTarget(dir) : scene(dir, true);
  col = applyHaze(col, dir);
  gl_FragColor = vec4(col, 1.0);
}
`;
