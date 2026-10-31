import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// Painterly finish: optional Kuwahara (oil-paint) smoothing, then warm/cool grading, vignette, paper grain.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 },
    uPaint: { value: 1 }, uNight: { value: 0 }, uFlash: { value: 0 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform vec2 uRes; uniform float uTime, uPaint, uNight, uFlash;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    vec3 kuwahara(vec2 uv) {
      vec2 px = 1.0 / uRes;
      vec3 m[4]; vec3 s[4];
      for (int k = 0; k < 4; k++) { m[k] = vec3(0.0); s[k] = vec3(0.0); }
      for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
        vec3 c = texture2D(tDiffuse, uv + vec2(float(i), float(j)) * px).rgb;
        vec3 c2 = c * c;
        if (i <= 0 && j <= 0) { m[0] += c; s[0] += c2; }
        if (i >= 0 && j <= 0) { m[1] += c; s[1] += c2; }
        if (i <= 0 && j >= 0) { m[2] += c; s[2] += c2; }
        if (i >= 0 && j >= 0) { m[3] += c; s[3] += c2; }
      }
      float best = 1e9; vec3 res = vec3(0.0);
      for (int k = 0; k < 4; k++) {
        vec3 mu = m[k] / 9.0;
        vec3 v = abs(s[k] / 9.0 - mu * mu);
        float sv = v.r + v.g + v.b;
        if (sv < best) { best = sv; res = mu; }
      }
      return res;
    }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      if (uPaint > 0.5) c = mix(c, kuwahara(vUv), 0.85);
      // grade: lift shadows toward teal, warm highlights, gentle S-curve and saturation
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(c, vec3(l), -0.12);
      c += vec3(-0.01, 0.01, 0.035) * (1.0 - l) * (1.0 + uNight);
      c *= mix(vec3(1.0), vec3(1.04, 1.0, 0.94), smoothstep(0.4, 1.0, l));
      c = mix(c, c * c * (3.0 - 2.0 * c), 0.25);
      // vignette + paper grain
      vec2 q = vUv - 0.5;
      c *= 1.0 - dot(q, q) * 0.55;
      float g = hash(vUv * uRes + fract(uTime) * 100.0) - 0.5;
      c += g * 0.018;
      float paper = hash(floor(vUv * uRes / 3.0)) - 0.5;
      c *= 1.0 + paper * 0.02;
      gl_FragColor = vec4(c, 1.0);
    }`,
};

export function makeComposer(renderer, scene, camera, { samples = 4 } = {}) {
  const size = renderer.getSize(new THREE.Vector2());
  const pr = renderer.getPixelRatio();
  // Multisampled target: without it the post chain has no anti-aliasing at all (jagged edges everywhere).
  const target = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, { type: THREE.HalfFloatType, samples });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  // Guard: one NaN/Inf or absurdly bright pixel would bloom into a big glowing blob.
  composer.addPass(new ShaderPass({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse; varying vec2 vUv;
      void main() {
        vec4 c = texture2D(tDiffuse, vUv);
        if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0);
        gl_FragColor = vec4(min(c.rgb, vec3(8.0)), c.a);
      }`,
  }));
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.28, 0.5, 0.95);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  const resize = (w, h) => {
    composer.setSize(w, h);
    const pr = renderer.getPixelRatio();
    grade.uniforms.uRes.value.set(w * pr, h * pr);
  };
  resize(size.x, size.y);
  return { composer, bloom, grade, resize };
}
