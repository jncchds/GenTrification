import * as THREE from 'three';

const BOX = 60, TOP = 30;

// Rain streaks and snowflakes in a box that follows the camera target.
export class WeatherFX {
  constructor(env) {
    const RAIN = 14000, SNOW = 9000;
    const rp = new Float32Array(RAIN * 2 * 3), rr = new Float32Array(RAIN * 2), re = new Float32Array(RAIN * 2);
    for (let i = 0; i < RAIN; i++) {
      const x = (Math.random() - 0.5) * BOX, y = Math.random() * TOP, z = (Math.random() - 0.5) * BOX, r = Math.random();
      for (let k = 0; k < 2; k++) { rp.set([x, y, z], (i * 2 + k) * 3); rr[i * 2 + k] = r; re[i * 2 + k] = k; }
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    rg.setAttribute('aRnd', new THREE.BufferAttribute(rr, 1));
    rg.setAttribute('aEnd', new THREE.BufferAttribute(re, 1));
    this.uniforms = { ...env, uCenter: { value: new THREE.Vector3() }, uAmount: { value: 0 } };
    const common = /* glsl */ `
      uniform vec3 uCenter; uniform float uTime, uAmount, uWind, uWindDir;
      attribute float aRnd;
      vec3 place(vec3 p, float speed) {
        float y = mod(p.y - uTime * speed * (0.8 + 0.4 * aRnd), ${TOP.toFixed(1)});
        vec2 drift = vec2(cos(uWindDir), sin(uWindDir)) * uWind * (${TOP.toFixed(1)} - y) * 0.25;
        vec2 xz = mod(p.xz + drift - uCenter.xz + ${(BOX / 2).toFixed(1)}, ${BOX.toFixed(1)}) - ${(BOX / 2).toFixed(1)} + uCenter.xz;
        return vec3(xz.x, uCenter.y + y - 6.0, xz.y);
      }`;
    this.rain = new THREE.LineSegments(rg, new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false,
      vertexShader: /* glsl */ `
        ${common}
        attribute float aEnd; varying float vA;
        void main() {
          vec3 p = place(position, 26.0);
          p.y += aEnd * 0.7;
          p.xz -= aEnd * vec2(cos(uWindDir), sin(uWindDir)) * uWind * 0.18;
          vA = step(aRnd, uAmount) * (0.25 + 0.2 * aEnd);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uNight; varying float vA;
        void main() { if (vA <= 0.0) discard; gl_FragColor = vec4(vec3(0.75, 0.8, 0.88) * mix(1.0, 0.35, uNight), vA); }`,
    }));
    this.rain.frustumCulled = false;

    const sp = new Float32Array(SNOW * 3), sr = new Float32Array(SNOW);
    for (let i = 0; i < SNOW; i++) { sp.set([(Math.random() - 0.5) * BOX, Math.random() * TOP, (Math.random() - 0.5) * BOX], i * 3); sr[i] = Math.random(); }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    sg.setAttribute('aRnd', new THREE.BufferAttribute(sr, 1));
    this.snowU = { ...this.uniforms, uSnowAmt: { value: 0 } };
    this.snow = new THREE.Points(sg, new THREE.ShaderMaterial({
      uniforms: this.snowU, transparent: true, depthWrite: false,
      vertexShader: /* glsl */ `
        ${common}
        uniform float uSnowAmt; varying float vA;
        void main() {
          vec3 p = place(position, 2.2);
          p.x += sin(uTime * 1.3 + aRnd * 40.0) * 0.4; p.z += cos(uTime * 1.1 + aRnd * 30.0) * 0.4;
          vA = step(aRnd, uSnowAmt);
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (2.0 + aRnd * 2.5) * 40.0 / -mv.z;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uNight; varying float vA;
        void main() { if (vA <= 0.0) discard; float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(vec3(1.0) * mix(1.0, 0.45, uNight), smoothstep(0.5, 0.2, d) * 0.9); }`,
    }));
    this.snow.frustumCulled = false;
    this.group = new THREE.Group();
    this.group.add(this.rain, this.snow);
    this.flash = 0;
    this.nextFlash = 0;
  }

  // rain/snow: 0..1 intensity; storm: lightning.
  update(center, rain, snowing, storm, now) {
    this.uniforms.uCenter.value.copy(center);
    this.uniforms.uAmount.value = snowing ? 0 : rain;
    this.snowU.uSnowAmt.value = snowing ? rain : 0;
    if (storm && now > this.nextFlash) { this.flash = 1; this.nextFlash = now + 2 + Math.random() * 7; }
    this.flash *= 0.86;
    return this.flash > 0.02 ? this.flash * (0.6 + 0.4 * Math.sin(now * 90)) : 0;
  }
}
