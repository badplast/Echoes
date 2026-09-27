/**
 * Replaces NaN / Inf / absurd values in the HDR frame before bloom. One bad pixel is invisible
 * on its own, but bloom spreads it into flickering black blocks; this pass makes that impossible
 * for every world, whatever a shader does.
 */
export const sanitizeShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    // NaN and Inf both have an all-ones exponent. A bit test cannot be optimised away
    // (isnan() can be, under fast-math shader compilers such as D3D's).
    bool bad(float x) { return (floatBitsToUint(x) & 0x7F800000u) == 0x7F800000u; }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (bad(c.r) || bad(c.g) || bad(c.b) || bad(c.a)) c = vec4(0.0, 0.0, 0.0, 1.0);
      gl_FragColor = vec4(clamp(c.rgb, 0.0, 256.0), c.a);
    }
  `,
};
