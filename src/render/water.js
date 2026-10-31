import * as THREE from 'three';
import { N, V, WKIND } from '../sim/world.js';
import { hY, HALF, getNoiseTexture, GLSL_COMMON } from './common.js';

const WATER_VS = /* glsl */ `
  attribute vec2 aFlow;
  attribute float aRiver;
  varying vec3 vWPos; varying vec3 vN; varying vec2 vFlow; varying float vRiver;
  #include <fog_pars_vertex>
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWPos = wp.xyz; vN = normalize(mat3(modelMatrix) * normal); vFlow = aFlow; vRiver = aRiver;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;

const WATER_FS = /* glsl */ `
  ${GLSL_COMMON}
  uniform sampler2D uNoise, uHeight;
  uniform float uTime, uRain, uNight, uCloud;
  uniform vec3 uSunDir, uSunColor, uZenith, uHorizon;
  varying vec3 vWPos; varying vec3 vN; varying vec2 vFlow; varying float vRiver;
  #include <fog_pars_fragment>
  vec2 nGrad(vec2 p) {
    float e = 0.02;
    float c = texture2D(uNoise, p).r;
    return vec2(texture2D(uNoise, p + vec2(e, 0.0)).r - c, texture2D(uNoise, p + vec2(0.0, e)).r - c) / e;
  }
  void main() {
    vec2 huv = (vWPos.xz + ${HALF.toFixed(1)} + 0.5) / ${V.toFixed(1)};
    float ground = texture2D(uHeight, clamp(huv, 0.0, 1.0)).r;
    if (huv.x < 0.0 || huv.y < 0.0 || huv.x > 1.0 || huv.y > 1.0) ground = -12.0;
    float depth = max(0.0, vWPos.y - ground);
    float steep = 1.0 - vN.y;
    float fall = smoothstep(0.25, 0.55, steep) * vRiver;

    vec2 flow = vFlow * (0.6 + 2.4 * vRiver);
    vec2 p1 = vWPos.xz * 0.045 - flow * uTime * 0.05 + vec2(uTime * 0.004, 0.0);
    vec2 p2 = vWPos.xz * 0.11 - flow * uTime * 0.09 - vec2(0.0, uTime * 0.007);
    vec2 g = nGrad(p1) * 0.04 + nGrad(p2) * 0.03;
    // Rain ripples.
    g += uRain * (nGrad(vWPos.xz * 0.6 + uTime * 0.7) * 0.012);
    vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
    n = normalize(mix(n, vN, fall));

    vec3 V = normalize(cameraPosition - vWPos);
    float fres = pow(1.0 - max(dot(n, V), 0.0), 4.0);
    vec3 R = reflect(-V, n);
    vec3 sky = mix(uHorizon, uZenith, clamp(R.y, 0.0, 1.0));
    vec3 deep = srgb(vec3(0.04, 0.20, 0.32));
    vec3 shallow = srgb(vec3(0.16, 0.52, 0.52));
    vec3 lake = srgb(vec3(0.10, 0.36, 0.38));
    vec3 col = mix(shallow, mix(deep, lake, vRiver), 1.0 - exp(-depth * 0.45));
    col *= mix(1.0, 0.55, uCloud * 0.6) * mix(1.0, 0.25, uNight);
    col = mix(col, sky, 0.15 + 0.6 * fres);
    float spec = pow(max(dot(R, uSunDir), 0.0), 220.0) * (1.0 - uCloud * 0.8);
    col += uSunColor * min(spec * 1.2, 0.6); // gentle glints (strong ones bloom into blobs)

    // Shore foam and river rapids.
    float fn = texture2D(uNoise, vWPos.xz * 0.35 + vec2(uTime * 0.03, -uTime * 0.02)).g;
    float shore = smoothstep(0.35, 0.0, depth + (fn - 0.5) * 0.25);
    float rapids = vRiver * smoothstep(0.16, 0.35, steep) * smoothstep(0.5, 0.8, fn);
    // Waterfall streaks fall along the flow.
    float streak = texture2D(uNoise, vec2(dot(vWPos.xz, vec2(vFlow.y, -vFlow.x)) * 0.9, vWPos.y * 0.25 + uTime * 0.6)).b;
    float foam = max(shore * 0.8, rapids * 0.7);
    foam = max(foam, fall * (0.55 + 0.45 * smoothstep(0.35, 0.65, streak)));
    vec3 foamC = vec3(0.92, 0.95, 0.97) * mix(1.0, 0.3, uNight);
    col = mix(col, foamC, clamp(foam, 0.0, 1.0));
    float alpha = mix(0.6, 0.96, smoothstep(0.0, 2.5, depth));
    alpha = max(alpha, foam);
    // Fade out where the water thins to nothing, so the shoreline is soft (waterfalls stay solid).
    alpha *= max(smoothstep(0.0, 0.08, depth), fall);
    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

export class Water {
  constructor(world, env, heightTex) {
    this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]);
    Object.assign(this.uniforms, env, { uNoise: { value: getNoiseTexture() }, uHeight: { value: heightTex } });
    const mat = new THREE.ShaderMaterial({
      vertexShader: WATER_VS, fragmentShader: WATER_FS, uniforms: this.uniforms,
      transparent: true, fog: true, depthWrite: true,
    });
    this.material = mat;
    this.group = new THREE.Group();

    // Open sea: one huge plane at sea level.
    const sea = new THREE.PlaneGeometry(3000, 3000, 1, 1).rotateX(-Math.PI / 2);
    sea.setAttribute('aFlow', new THREE.BufferAttribute(new Float32Array(4 * 2), 2));
    sea.setAttribute('aRiver', new THREE.BufferAttribute(new Float32Array(4), 1));
    const seaMesh = new THREE.Mesh(sea, mat);
    seaMesh.renderOrder = 1;
    this.group.add(seaMesh);

    // Inland water (lakes + rivers + waterfalls) as one mesh on the vertex grid.
    const surf = new Float32Array(V * V).fill(NaN);
    for (let v = 0; v < V * V; v++) {
      const k = world.vkind[v];
      if (k === WKIND.LAKE || k === WKIND.RIVER) surf[v] = hY(world.surf[v]);
    }
    const inland = (i) => world.water[i] === WKIND.LAKE || world.water[i] === WKIND.RIVER;
    // Smooth shores: the surface reaches RING cells past the water cells, and the sloping bank hides
    // it, so the shoreline follows the terrain contour instead of cell edges. Dry vertices take the
    // level of the nearest water vertex (breadth-first).
    const RING = 1;
    // Inside water cells, dry corners take the cell's lowest water level (as the game always did).
    const filled = surf.slice();
    const ofWaterCell = new Uint8Array(V * V);
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      if (!inland(z * N + x)) continue;
      const vs = [z * V + x, z * V + x + 1, (z + 1) * V + x, (z + 1) * V + x + 1];
      let lo = Infinity;
      for (const v of vs) { ofWaterCell[v] = 1; if (!Number.isNaN(surf[v])) lo = Math.min(lo, surf[v]); }
      if (lo === Infinity) lo = Math.max(...vs.map((v) => hY(world.H[v]))) - 0.05;
      for (const v of vs) if (Number.isNaN(filled[v])) filled[v] = lo;
    }
    // Ring vertices take the level of the nearest water-cell vertex (breadth-first; equally near: the lower).
    const layer = new Int8Array(V * V).fill(-1);
    let frontier = [];
    for (let v = 0; v < V * V; v++) if (!Number.isNaN(filled[v])) { frontier.push(v); layer[v] = 0; }
    for (let step = 1; step <= 2 * RING + 2 && frontier.length; step++) {
      const next = [];
      for (const v of frontier) {
        const x = v % V, z = (v / V) | 0;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= V || nz >= V) continue;
          const u = nz * V + nx;
          if (layer[u] === -1) { layer[u] = step; filled[u] = filled[v]; next.push(u); }
          else if (layer[u] === step) filled[u] = Math.min(filled[u], filled[v]);
        }
      }
      frontier = next;
    }
    const nearWater = new Uint8Array(N * N);
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      if (!inland(z * N + x)) continue;
      for (let dz = -RING; dz <= RING; dz++) for (let dx = -RING; dx <= RING; dx++) {
        const cx = x + dx, cz = z + dz;
        if (cx >= 0 && cz >= 0 && cx < N && cz < N && world.water[cz * N + cx] !== WKIND.SEA) nearWater[cz * N + cx] = 1;
      }
    }
    const cellVs = (x, z) => [z * V + x, z * V + x + 1, (z + 1) * V + x, (z + 1) * V + x + 1];
    const isMesh = new Uint8Array(N * N);
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++)
      if (nearWater[z * N + x] && cellVs(x, z).every((v) => !Number.isNaN(filled[v]))) isMesh[z * N + x] = 1;
    const meshCell = (x, z) => isMesh[z * N + x] === 1;
    // Real water cells keep their level. Ring vertices keep it only where the bank rises above it
    // (the bank then hides the surface along a smooth contour); anywhere lower (flat lake margins,
    // beside a waterfall) and wherever the mesh ends, they are tucked just under the ground, so no
    // water shows over land the game treats as dry.
    for (let vz = 0; vz < V; vz++) for (let vx = 0; vx < V; vx++) {
      const v = vz * V + vx;
      if (ofWaterCell[v] || Number.isNaN(filled[v])) continue;
      let border = false;
      for (const [cx, cz] of [[vx - 1, vz - 1], [vx, vz - 1], [vx - 1, vz], [vx, vz]])
        if (cx < 0 || cz < 0 || cx >= N || cz >= N || !isMesh[cz * N + cx]) border = true;
      const g = hY(world.H[v]);
      if (border || g < filled[v]) filled[v] = Math.min(filled[v], g - 0.01);
    }
    const pos = [], flow = [], river = [], index = [];
    const map = new Int32Array(V * V).fill(-1);
    const vert = (v) => {
      if (map[v] >= 0) return map[v];
      const x = v % V, z = (v / V) | 0;
      map[v] = pos.length / 3;
      pos.push(x - HALF, filled[v], z - HALF);
      const r = world.recv[v];
      let fx = 0, fz = 0;
      if (r >= 0) { fx = (r % V) - x; fz = ((r / V) | 0) - z; const l = Math.hypot(fx, fz) || 1; fx /= l; fz /= l; }
      flow.push(fx, fz);
      river.push(world.vkind[v] === WKIND.RIVER ? 1 : 0);
      return map[v];
    };
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      if (!meshCell(x, z)) continue;
      const a = vert(z * V + x), b = vert(z * V + x + 1), c = vert((z + 1) * V + x), d = vert((z + 1) * V + x + 1);
      index.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aFlow', new THREE.Float32BufferAttribute(flow, 2));
    geo.setAttribute('aRiver', new THREE.Float32BufferAttribute(river, 1));
    geo.setIndex(index);
    geo.computeVertexNormals();
    const inlandMesh = new THREE.Mesh(geo, mat);
    inlandMesh.position.y = 0.02;
    inlandMesh.renderOrder = 2;
    this.group.add(inlandMesh);

    this.mist = makeMist(world, env);
    if (this.mist) this.group.add(this.mist);
  }
}

// Soft mist puffs at the foot of each waterfall.
function makeMist(world, env) {
  const falls = world.waterfalls;
  if (!falls.length) return null;
  const PER = 14;
  const pos = new Float32Array(falls.length * PER * 3), rnd = new Float32Array(falls.length * PER), size = new Float32Array(falls.length * PER);
  let k = 0;
  for (const f of falls) {
    for (let j = 0; j < PER; j++, k++) {
      pos[k * 3] = f.tx - HALF + (Math.random() - 0.5) * 1.2;
      pos[k * 3 + 1] = hY(f.bottom) + 0.2;
      pos[k * 3 + 2] = f.ty - HALF + (Math.random() - 0.5) * 1.2;
      rnd[k] = Math.random();
      size[k] = 0.6 + Math.min(1.5, f.flow / 8000) + Math.random() * 0.6;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: env.uTime, uNight: env.uNight },
    vertexShader: /* glsl */ `
      attribute float aRnd; attribute float aSize; uniform float uTime; varying float vA;
      void main() {
        float t = fract(uTime * 0.25 + aRnd);
        vec3 p = position + vec3(sin(aRnd * 40.0) * t, t * 1.6, cos(aRnd * 31.0) * t);
        vA = sin(t * 3.1416) * 0.1;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = min(aSize * (1.0 + t) * 120.0 / -mv.z, 48.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uNight; varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d) * vA;
        gl_FragColor = vec4(vec3(0.75) * mix(1.0, 0.3, uNight), a);
      }`,
    transparent: true, depthWrite: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.renderOrder = 3;
  pts.frustumCulled = false;
  return pts;
}
