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
  vec3 col = skyWithClouds(dir);
  float c = cloudCover(dir);
  col += stars(dir) * (1.0 - c);
  col += luminaryDisc(dir) * (1.0 - c * 0.85);
  gl_FragColor = vec4(col, 1.0);
}
`;
