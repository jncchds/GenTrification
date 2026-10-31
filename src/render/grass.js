import * as THREE from 'three';
import { N, V } from '../sim/world.js';
import { T } from '../sim/rules.js';
import { HALF, GLSL_COMMON, GLSL_CLOUDSHADOW, getNoiseTexture } from './common.js';
import { GLSL_SEASON } from './terrain.js';

const R = 22;          // patch half-size (world units) around the player

export class Grass {
  constructor(env, heightTex, groundTex, occTex, COUNT = 120000) {
    // One blade: a soft, round-tipped strip (4 segments) rather than a sharp spike.
    const P = [], Y = [];
    const segs = 4;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs, w = 0.017 * (1 - t * t * 0.72);
      P.push(-w, t, 0, w, t, 0); Y.push(t, t);
    }
    const idx = [];
    for (let i = 0; i < segs; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('aT', new THREE.Float32BufferAttribute(Y, 1));
    geo.setIndex(idx);
    const off = new Float32Array(COUNT * 2), rnd = new Float32Array(COUNT * 4);
    for (let i = 0; i < COUNT; i++) {
      off[i * 2] = (Math.random() * 2 - 1) * R; off[i * 2 + 1] = (Math.random() * 2 - 1) * R;
      rnd[i * 4] = Math.random(); rnd[i * 4 + 1] = Math.random(); rnd[i * 4 + 2] = Math.random(); rnd[i * 4 + 3] = Math.random();
    }
    geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 2));
    geo.setAttribute('aRnd', new THREE.InstancedBufferAttribute(rnd, 4));
    geo.instanceCount = COUNT;

    this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]);
    Object.assign(this.uniforms, env, {
      uHeight: { value: heightTex }, uGround: { value: groundTex }, uOcc: { value: occTex }, uNoise: { value: getNoiseTexture() },
      uCenter: { value: new THREE.Vector2() },
    });
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, fog: true, side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        ${GLSL_COMMON}
        ${GLSL_SEASON}
        attribute vec2 aOff; attribute vec4 aRnd; attribute float aT;
        uniform sampler2D uHeight, uGround, uOcc, uNoise;
        uniform vec2 uCenter; uniform float uTime, uWind, uWindDir, uSeason, uSnowLine, uSnowCover;
        varying float vT; varying vec3 vCol; varying float vFlower; varying vec3 vWorld;
        #include <fog_pars_vertex>
        void main() {
          // Toroidal wrap keeps blades fixed in the world while the patch follows the camera.
          vec2 wp = uCenter + mod(aOff - uCenter + ${R.toFixed(1)}, ${(2 * R).toFixed(1)}) - ${R.toFixed(1)};
          vec2 cuv = (wp + ${HALF.toFixed(1)}) / ${N.toFixed(1)};
          vec4 g = texture2D(uGround, cuv);
          ivec2 cell = clamp(ivec2(floor(wp + ${HALF.toFixed(1)})), ivec2(0), ivec2(${N - 1}));
          vec4 o = texelFetch(uOcc, cell, 0);
          int type = int(o.r * 255.0 + 0.5);
          float ground = texture2D(uHeight, (wp + ${HALF.toFixed(1)} + 0.5) / ${V.toFixed(1)}).r;
          float dens = g.b * (1.0 - 0.6 * g.g);
          if (type == ${T.FARM} || type == ${T.HOUSE} || type == ${T.MILL}) dens = 0.0;
          if (type == ${T.PARK}) dens = 1.0;
          if (cuv.x < 0.0 || cuv.y < 0.0 || cuv.x > 1.0 || cuv.y > 1.0 || ground < 0.15) dens = 0.0;
          float snow = max(smoothstep(uSnowLine - 1.0, uSnowLine, ground), uSnowCover);
          float d = length(wp - uCenter) / ${R.toFixed(1)};
          float keep = step(aRnd.x, dens) * smoothstep(1.0, 0.75, d) * (1.0 - snow * 0.9);
          float n = texture2D(uNoise, wp * 0.05).r;
          float tuft = texture2D(uNoise, wp * 0.7).g; // grass grows in soft tufts
          float near = smoothstep(0.25, 1.2, length(wp - cameraPosition.xz));
          float h = (0.04 + 0.07 * aRnd.y) * (0.6 + 0.8 * n) * (0.55 + 0.7 * tuft) * keep * near * seasonPickF(uSeason, 0.85, 1.1, 0.9, 0.45);
          float flowerChance = (type == ${T.PARK} ? 0.25 : 0.035) * seasonPickF(uSeason, 1.4, 1.0, 0.25, 0.0);
          vFlower = step(aRnd.z, flowerChance);
          if (vFlower > 0.5) h *= 1.2;
          // Bend: wind gusts travel across the field.
          float gust = sin(dot(wp, vec2(cos(uWindDir), sin(uWindDir))) * 0.35 - uTime * 2.2) * 0.5 + 0.5;
          float bend = (0.15 + uWind * 1.1 * gust) * aT * aT;
          float ang = aRnd.w * 6.2832;
          vec3 p = position;
          p.xz = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * p.xz;
          p.y *= h;
          p.x += cos(uWindDir) * bend * h; p.z += sin(uWindDir) * bend * h;
          vec3 world = vec3(wp.x, ground - 0.02, wp.y) + p;
          vec3 base = seasonPick(uSeason, srgb(vec3(0.22,0.40,0.12)), srgb(vec3(0.22,0.36,0.10)), srgb(vec3(0.38,0.34,0.14)), srgb(vec3(0.30,0.28,0.18)));
          vec3 tip = seasonPick(uSeason, srgb(vec3(0.60,0.82,0.34)), srgb(vec3(0.58,0.74,0.28)), srgb(vec3(0.80,0.68,0.32)), srgb(vec3(0.55,0.50,0.36)));
          tip *= 0.85 + 0.3 * n;
          vCol = mix(base, tip, aT);
          if (vFlower > 0.5 && aT > 0.9) {
            float k = fract(aRnd.z * 37.0);
            vCol = k < 0.3 ? srgb(vec3(1.0, 0.92, 0.95)) : k < 0.55 ? srgb(vec3(1.0, 0.85, 0.25)) : k < 0.8 ? srgb(vec3(0.95, 0.45, 0.65)) : srgb(vec3(0.62, 0.48, 0.95));
          }
          vT = aT; vWorld = world;
          vec4 mvPosition = viewMatrix * vec4(world, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunDir, uSunColor, uAmbient; uniform float uSunI, uWet, uTime, uCloud, uWindDir;
        uniform sampler2D uNoise;
        varying float vT; varying vec3 vCol; varying float vFlower; varying vec3 vWorld;
        #include <fog_pars_fragment>
        ${GLSL_CLOUDSHADOW}
        void main() {
          float sun = max(uSunDir.y, 0.0) * (1.0 - 0.7 * cloudShadow(vWorld.xz));
          // Backlit tips glow when looking towards the sun.
          vec3 toFrag = vWorld - cameraPosition;
          float back = pow(clamp(dot(toFrag / max(length(toFrag), 1e-3), uSunDir), 0.0, 1.0), 4.0) * clamp(vT, 0.0, 1.0);
          vec3 col = vCol * (uAmbient * (0.65 + 0.35 * vT) + uSunColor * uSunI * (sun * (0.45 + 0.55 * vT) + back * 0.6));
          col *= 1.0 - 0.2 * uWet;
          if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
          col = min(col, vec3(1.5));
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
  }

  update(center) { this.uniforms.uCenter.value.copy(center); }
}
