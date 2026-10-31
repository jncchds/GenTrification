import * as THREE from 'three';
import { getNoiseTexture } from './common.js';

const C = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
const DAY_Z = C(0.30, 0.55, 0.88), DAY_H = C(0.78, 0.87, 0.95);
const SET_Z = C(0.32, 0.38, 0.62), SET_H = C(1.0, 0.62, 0.38);
const NIGHT_Z = C(0.015, 0.025, 0.07), NIGHT_H = C(0.05, 0.07, 0.14);
const GREY_Z = C(0.45, 0.50, 0.56), GREY_H = C(0.62, 0.66, 0.70);

// Sky colors from sun elevation and cloudiness (also drives fog and ambient light).
export function skyColors(sunY, cloud) {
  const day = THREE.MathUtils.smoothstep(sunY, -0.18, 0.25);
  const sunset = Math.max(0, 1 - Math.abs(sunY - 0.02) * 5) * THREE.MathUtils.smoothstep(sunY, -0.25, 0.0);
  const z = NIGHT_Z.clone().lerp(DAY_Z, day).lerp(SET_Z, sunset * 0.5);
  const h = NIGHT_H.clone().lerp(DAY_H, day).lerp(SET_H, sunset * 0.8);
  const overcast = THREE.MathUtils.smoothstep(cloud, 0.45, 0.95);
  z.lerp(GREY_Z.clone().multiplyScalar(0.15 + 0.85 * day), overcast * 0.85);
  h.lerp(GREY_H.clone().multiplyScalar(0.15 + 0.85 * day), overcast * 0.85);
  const sunColor = C(1.0, 0.96, 0.88).lerp(C(1.0, 0.55, 0.3), sunset);
  return { zenith: z, horizon: h, sunColor, day, sunset, overcast };
}

export class Sky {
  constructor(env) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...env, uNoise: { value: getNoiseTexture() } },
      side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunDir, uZenith, uHorizon, uSunColor;
        uniform float uTime, uCloud, uNight, uRain, uFlash, uWindDir;
        uniform sampler2D uNoise;
        varying vec3 vDir;
        float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(d.y, -0.2, 1.0);
          vec3 col = mix(uHorizon, uZenith, pow(max(h, 0.0), 0.55));
          if (d.y < 0.0) col = mix(uHorizon, uHorizon * 0.7, clamp(-d.y * 4.0, 0.0, 1.0));
          float sd = max(dot(d, uSunDir), 0.0);
          float day = smoothstep(-0.15, 0.2, uSunDir.y);
          col += uSunColor * (pow(sd, 900.0) * 30.0 + pow(sd, 12.0) * 0.35) * day * (1.0 - uCloud * 0.85);
          // Moon opposite the sun.
          vec3 md = -uSunDir;
          float mdd = max(dot(d, md), 0.0);
          col += vec3(0.8, 0.85, 1.0) * (smoothstep(0.9993, 0.9996, mdd) * 1.5 + pow(mdd, 30.0) * 0.08) * uNight * (1.0 - uCloud);
          // Stars.
          vec3 sp = floor(d * 300.0);
          float st = step(0.9975, hash(sp)) * smoothstep(0.0, 0.3, d.y);
          col += vec3(st) * uNight * (1.0 - uCloud) * (0.6 + 0.4 * sin(uTime * 3.0 + hash(sp + 1.0) * 30.0));
          // Clouds on a virtual plane.
          if (d.y > 0.0) {
            vec2 uv = d.xz / (d.y + 0.12);
            vec2 wind = vec2(cos(uWindDir), sin(uWindDir)) * uTime * 0.004;
            float n = texture2D(uNoise, uv * 0.18 + wind).r * 0.55 + texture2D(uNoise, uv * 0.45 + wind * 1.7).g * 0.3 + texture2D(uNoise, uv * 1.1 + wind * 2.3).b * 0.15;
            float cov = mix(0.72, 0.28, uCloud);
            float c = smoothstep(cov, cov + 0.18, n) * smoothstep(0.0, 0.15, d.y);
            vec3 lit = mix(vec3(0.95, 0.95, 0.97), uSunColor, 0.25) * (0.35 + 0.75 * day);
            vec3 shade = mix(uHorizon * 0.9, vec3(0.35, 0.37, 0.42) * (0.2 + 0.8 * day), uCloud);
            float thick = smoothstep(cov, cov + 0.45, n);
            vec3 cc = mix(lit, shade, thick * (0.4 + 0.5 * uCloud));
            cc += uSunColor * pow(sd, 6.0) * 0.4 * day * (1.0 - thick);
            col = mix(col, cc * mix(1.0, 0.12, uNight), c);
          }
          col += vec3(0.7, 0.75, 1.0) * uFlash * 0.8;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1400, 48, 24), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
  }
}
