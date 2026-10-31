import * as THREE from 'three';
import { N, V } from '../sim/world.js';
import { HOURS, SEASON_DAYS, YEAR_DAYS, weather, dayStats, sunTimes } from '../sim/climate.js';
import { T } from '../sim/rules.js';
import { HS, hY, HALF, heightAt } from './common.js';
import { Terrain, makeHeightTexture } from './terrain.js';
import { Water } from './water.js';
import { Sky, skyColors } from './sky.js';
import { Trees } from './trees.js';
import { Grass } from './grass.js';
import { Buildings, buildingGeometry, buildingAnchor, buildingMaterial, radiusOf } from './buildings.js';
import { WeatherFX } from './weather.js';
import { makeComposer } from './post.js';
import { RTSControls, FirstPersonControls, pickGround } from './controls.js';

const MAX_ELEV = [0.85, 1.1, 0.8, 0.5]; // noon sun elevation (radians) per season

export class GameView {
  constructor(canvas, engine, { mobile = false } = {}) {
    this.engine = engine;
    this.mobile = mobile;
    const world = (this.world = engine.world);
    const renderer = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !mobile, powerPreference: 'high-performance' }));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1.25 : 1.75));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;

    const scene = (this.scene = new THREE.Scene());
    scene.fog = new THREE.FogExp2(0xbfd4e6, 0.006);
    const camera = (this.camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.03, 3000));
    this.map = new RTSControls(camera, canvas, world);
    this.fp = new FirstPersonControls(camera, canvas, world, (x, z) => {
      const cx = Math.floor(x + HALF), cz = Math.floor(z + HALF);
      if (!this.state || cx < 0 || cz < 0 || cx >= N || cz >= N) return false;
      const id = this.state.occ[cz * N + cx];
      const t = id ? this.state.buildings[id - 1].type : 0;
      return t === T.HOUSE || t === T.MILL;
    });
    this.controls = this.fp;
    this.mode = 'fp';

    const v3 = () => ({ value: new THREE.Vector3() }), cl = () => ({ value: new THREE.Color() }), f = (x = 0) => ({ value: x });
    const env = (this.env = {
      uTime: f(), uSunDir: v3(), uSunColor: cl(), uSunI: f(1), uAmbient: cl(), uZenith: cl(), uHorizon: cl(),
      uNight: f(), uSeason: f(), uSnowLine: f(100), uSnowCover: f(), uWet: f(), uCloud: f(), uRain: f(),
      uWind: f(0.3), uWindDir: f(0.5), uLeafAmt: f(1), uFlash: f(),
    });

    this.heightTex = makeHeightTexture(world);
    this.terrain = new Terrain(world, env);
    this.water = new Water(world, env, this.heightTex);
    this.sky = new Sky(env);
    this.trees = new Trees(world, env, renderer, world.seed, { mobile });
    this.grass = new Grass(env, this.heightTex, this.terrain.groundTex, this.terrain.occTex, mobile ? 50000 : 160000);
    this.buildings = new Buildings(world, env);
    this.fx = new WeatherFX(env);
    scene.add(this.terrain.mesh, this.water.group, this.sky.mesh, this.trees.group, this.grass.mesh, this.buildings.group, this.fx.group);
    // Where the walker stands, shown in map view: a small glowing pin.
    const pin = (this.walkerPin = new THREE.Group());
    const pinMat = new THREE.MeshBasicMaterial({ color: 0xffe08a, fog: false, depthTest: false, transparent: true });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.4, 12), pinMat);
    cone.rotation.x = Math.PI; cone.position.y = 1.0;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.55, 14, 10), pinMat);
    ball.position.y = 1.9;
    pin.add(cone, ball);
    pin.renderOrder = 10; cone.renderOrder = 10; ball.renderOrder = 10;
    pin.visible = false;
    scene.add(pin);

    const sun = (this.sun = new THREE.DirectionalLight(0xffffff, 2.5));
    sun.castShadow = true;
    sun.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
    const sc = sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 1; sc.far = 400;
    sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.04; sun.shadow.radius = 4;
    sun.shadow.intensity = 0.72; // softer, airier shadows (shaded areas keep some sunlight)
    scene.add(sun, sun.target);
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x5a4a32, 0.7);
    scene.add(this.hemi);

    const post = makeComposer(renderer, scene, camera, { samples: mobile ? 2 : 4 });
    this.post = post;
    this.paint = !mobile;

    // Placement preview: ghost building, footprint outline and work radius.
    this.ghostMat = buildingMaterial(env, { transparent: true, opacity: 0.65, depthWrite: false });
    this.ghost = new THREE.Mesh(new THREE.BufferGeometry(), this.ghostMat);
    this.ghost.visible = false;
    this.outline = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }));
    this.ring = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xfff3c0, dashSize: 0.6, gapSize: 0.4, transparent: true, opacity: 0.8, depthTest: false }));
    this.outline.renderOrder = this.ring.renderOrder = 10;
    scene.add(this.ghost, this.outline, this.ring);
    this.previewKey = '';

    this.smooth = { snowLine: null, snowCover: 0, wet: 0 };
    window.addEventListener('resize', () => this.resize());
    this.clock = new THREE.Clock();
    this.lastTreeUpdate = -1; this.lastTerrainUpdate = -1;
    this.setMode('fp');
  }

  focus(x, z) {
    this.fp.focus(x, z);
    this.map.focus(x, z);
    this.map.target.copy(this.map.goal.target);
  }

  // 'fp' (first person, default) or 'map' (overhead planning view).
  setMode(mode) {
    if (mode === 'map') {
      this.map.goal.target.set(this.fp.pos.x, 0, this.fp.pos.z);
      this.map.target.copy(this.fp.pos);
      this.map.goal.yaw = this.map.yaw = this.fp.yaw;
      if (document.pointerLockElement) document.exitPointerLock();
    }
    // Back to walking: the walker stays where they were (use teleport() to move them).
    this.mode = mode;
    this.fp.enabled = mode === 'fp';
    this.map.enabled = mode === 'map';
    this.controls = mode === 'fp' ? this.fp : this.map;
    this.camera.near = mode === 'fp' ? 0.03 : 0.3;
    this.camera.fov = mode === 'fp' ? 65 : 50;
    this.camera.updateProjectionMatrix();
    const sc = this.sun.shadow.camera, ext = mode === 'fp' ? 45 : 70;
    sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.updateProjectionMatrix();
    this.shadowExt = ext;
  }

  // Move the walker to a world position (map view's "Go here").
  teleport(x, z) {
    this.fp.focus(x, z);
    this.fp.yaw = this.map.yaw;
  }

  // Compass heading in degrees, clockwise from north (-z). Both camera modes look along (-sin yaw, -cos yaw).
  heading() { return (((-this.controls.yaw * 180) / Math.PI) % 360 + 360) % 360; }

  // Ground point under the crosshair (first person) or the mouse (map).
  pickAt(clientX, clientY) {
    if (this.mode === 'fp') {
      const p = pickGround(this.world, this.camera, new THREE.Vector2(0, 0), 40);
      return p ? { x: Math.floor(p.x + HALF), y: Math.floor(p.z + HALF), p } : null;
    }
    return this.pick(clientX, clientY);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.post.resize(w, h);
  }

  pick(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const p = pickGround(this.world, this.camera, ndc);
    if (!p) return null;
    return { x: Math.floor(p.x + HALF), y: Math.floor(p.z + HALF), p };
  }

  // Preview of a building about to be placed (null hides it).
  setPreview(e, ok) {
    if (!e) { this.ghost.visible = this.outline.visible = this.ring.visible = false; this.previewKey = ''; return; }
    const key = `${e.type}:${e.x}:${e.y}:${e.s}:${e.seed}:${ok}`;
    if (key === this.previewKey) return;
    this.previewKey = key;
    const color = ok ? 0x9cff9c : 0xff7a6a;
    if (e.type === T.DEMOLISH) {
      this.ghost.visible = false; this.ring.visible = false;
      this.outlineCells(e.x, e.y, 1, color);
      return;
    }
    const b = { ...e, eff: 1000, quirk: 0 };
    this.ghost.geometry.dispose();
    this.ghost.geometry = buildingGeometry(this.world, b);
    this.ghost.position.copy(buildingAnchor(this.world, b));
    this.ghost.visible = true;
    this.ghostMat.color.set(ok ? 0xffffff : 0xff9090);
    this.outlineCells(e.x, e.y, e.s, color);
    const r = radiusOf({ ...b, quirk: e.quirk ?? 0 });
    if (r) {
      const pts = [], cx = e.x + (e.s >> 1) + 0.5 - HALF, cz = e.y + (e.s >> 1) + 0.5 - HALF;
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * Math.PI * 2, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
        pts.push(new THREE.Vector3(x, Math.max(0, heightAt(this.world, x, z)) + 0.3, z));
      }
      this.ring.geometry.dispose();
      this.ring.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      this.ring.computeLineDistances();
      this.ring.material.color.set(e.type === T.MILL ? 0xffd28a : 0xa8ffcf);
      this.ring.visible = true;
    } else this.ring.visible = false;
  }

  outlineCells(x0, y0, s, color) {
    const pts = [];
    const edge = (ax, az, bx, bz) => {
      for (let i = 0; i <= 8; i++) {
        const x = ax + ((bx - ax) * i) / 8, z = az + ((bz - az) * i) / 8;
        pts.push(new THREE.Vector3(x - HALF, Math.max(0, heightAt(this.world, x - HALF, z - HALF)) + 0.12, z - HALF));
      }
    };
    edge(x0, y0, x0 + s, y0); edge(x0 + s, y0, x0 + s, y0 + s); edge(x0 + s, y0 + s, x0, y0 + s); edge(x0, y0 + s, x0, y0);
    this.outline.geometry.dispose();
    this.outline.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    this.outline.material.color.set(color);
    this.outline.visible = true;
  }

  // Climate -> lighting, sky and shader uniforms. tickF is fractional for smooth motion.
  updateEnvironment(tickF, dt) {
    const env = this.env, seed = this.world.seed;
    const t0 = Math.floor(tickF), fr = tickF - t0;
    const w0 = weather(seed, t0), w1 = weather(seed, t0 + 1);
    const lerp = (a, b) => a + (b - a) * fr;
    const cloud = lerp(w0.cloud, w1.cloud) / 1023, rain = lerp(w0.rain, w1.rain) / 1000, wind = lerp(w0.wind, w1.wind) / 1023;
    const tempC = lerp(w0.temp, w1.temp) / 10;
    const day = Math.floor(tickF / HOURS), hourF = tickF - day * HOURS, doy = day % YEAR_DAYS;
    const season = Math.floor(doy / SEASON_DAYS);
    env.uSeason.value = (doy + hourF / HOURS) / SEASON_DAYS;

    // Sun path: day arc between sunrise and sunset, night arc below the horizon.
    const [rise, set] = sunTimes(season);
    let phi;
    if (hourF >= rise && hourF < set) phi = (Math.PI * (hourF - rise)) / (set - rise);
    else { const nightLen = HOURS - (set - rise); const into = (hourF - set + HOURS) % HOURS; phi = Math.PI + (Math.PI * into) / nightLen; }
    const E = MAX_ELEV[season];
    const sunDir = new THREE.Vector3(Math.cos(phi), Math.sin(phi) * Math.sin(E), Math.sin(phi) * Math.cos(E) * 0.7 + 0.25).normalize();
    env.uSunDir.value.copy(sunDir);
    const night = 1 - THREE.MathUtils.smoothstep(sunDir.y, -0.12, 0.1);
    env.uNight.value = night;
    const sky = skyColors(sunDir.y, Math.max(cloud, rain));
    env.uZenith.value.copy(sky.zenith); env.uHorizon.value.copy(sky.horizon); env.uSunColor.value.copy(sky.sunColor);
    env.uCloud.value = THREE.MathUtils.smoothstep(cloud, 0.3, 1.0);
    env.uRain.value = rain;
    env.uWind.value = 0.15 + wind * (w0.storm ? 1.6 : 0.9);
    env.uWindDir.value = 0.6 + Math.sin(tickF * 0.01) * 0.8;

    // Seasons: leaves bud in spring, fall through autumn.
    const s = env.uSeason.value;
    env.uLeafAmt.value = s < 0.4 ? 0.25 + (s / 0.4) * 0.75 : s < 2 ? 1 : s < 3 ? 1 - (s - 2) * 0.85 : s < 3.9 ? 0.06 : 0.06 + (s - 3.9) * 2;

    // Snow line from today's mean temperature (lapse rate matches the sim); permanent caps on the highest peaks.
    const ds = dayStats(seed, day);
    const lineH = Math.min(3350, 1000 + Math.floor((Math.max(ds.temp, -50) * 300) / 13));
    const lineTarget = hY(lineH);
    const sm = this.smooth;
    if (sm.snowLine === null) sm.snowLine = lineTarget;
    sm.snowLine += (lineTarget - sm.snowLine) * Math.min(1, dt * 0.3);
    env.uSnowLine.value = sm.snowLine;
    const coverTarget = ds.temp < 15 ? THREE.MathUtils.clamp((15 - ds.temp) / 50, 0, 1) : 0;
    sm.snowCover += (coverTarget - sm.snowCover) * Math.min(1, dt * (coverTarget > sm.snowCover ? 0.25 : 0.12));
    env.uSnowCover.value = sm.snowCover;
    const snowing = w0.snow || tempC < 1;
    sm.wet += ((rain > 0.05 && !snowing ? 1 : 0) - sm.wet) * Math.min(1, dt * (rain > 0.05 ? 0.6 : 0.08));
    env.uWet.value = sm.wet;

    // Lights.
    const overcast = sky.overcast;
    const dayLight = sky.day;
    const moonUp = sunDir.y < 0.02;
    const L = moonUp ? sunDir.clone().negate() : sunDir;
    this.sun.color.copy(moonUp ? new THREE.Color(0.55, 0.65, 1.0) : sky.sunColor);
    this.sun.intensity = moonUp ? 0.35 * (1 - cloud) : 3.0 * dayLight * (1 - 0.7 * overcast);
    env.uSunI.value = moonUp ? 0.12 : dayLight * (1 - 0.7 * overcast);
    this.hemi.color.copy(sky.zenith).lerp(new THREE.Color(1, 1, 1), 0.35);
    this.hemi.groundColor.set(0x4a3f2c).multiplyScalar(0.3 + 0.7 * dayLight);
    this.hemi.intensity = 0.4 + 1.0 * dayLight + 0.2 * night;
    env.uAmbient.value.copy(sky.zenith).lerp(sky.horizon, 0.5).multiplyScalar(0.55 + 0.4 * overcast).addScalar(0.02 + 0.03 * night);
    const flash = this.fx.update(this.controls.target, rain, snowing, w0.storm, this.clock.elapsedTime);
    env.uFlash.value = flash;
    if (flash) this.hemi.intensity += flash * 3;

    const fogC = sky.horizon.clone();
    this.scene.fog.color.copy(fogC);
    const mist = lerp(w0.fog, w1.fog) / 1000;
    sm.mist = (sm.mist ?? mist) + (mist - (sm.mist ?? mist)) * Math.min(1, dt * 0.5);
    this.scene.fog.density = 0.0042 + rain * 0.012 + overcast * 0.003 + sm.mist * 0.045;
    if (sm.mist > 0.05) this.scene.fog.color.lerp(new THREE.Color(0.78, 0.8, 0.82).multiplyScalar(0.25 + 0.75 * sky.day), sm.mist * 0.6);
    this.post.grade.uniforms.uNight.value = night;

    // Shadow camera follows the view, snapped to texels to avoid shimmering.
    const tgt = this.controls.target;
    const snap = (2 * this.shadowExt) / this.sun.shadow.mapSize.x;
    const tx = Math.round(tgt.x / snap) * snap, tz = Math.round(tgt.z / snap) * snap;
    this.sun.target.position.set(tx, tgt.y, tz);
    this.sun.position.set(tx + L.x * 150, tgt.y + Math.max(L.y, 0.08) * 150, tz + L.z * 150);
    return { weather: w0, tempC, rain, cloud, snowing, season, hourF, day };
  }

  frame(state, tickF, epoch) {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const now = this.clock.elapsedTime;
    this.env.uTime.value = now;
    this.post.grade.uniforms.uTime.value = now;
    this.state = state;
    this.controls.update(dt);
    this.walkerPin.visible = this.mode === 'map';
    if (this.walkerPin.visible) {
      const k = Math.max(1, this.map.dist / 40);  // stay readable when zoomed out
      this.walkerPin.scale.setScalar(k);
      this.walkerPin.position.set(this.fp.pos.x, this.fp.pos.y, this.fp.pos.z);
    }
    const info = this.updateEnvironment(tickF, dt);
    const c2 = new THREE.Vector2(this.controls.target.x, this.controls.target.z);
    if (now - this.lastTerrainUpdate > 0.25) { this.terrain.update(state, epoch); this.lastTerrainUpdate = now; }
    if (now - this.lastTreeUpdate > 0.5) { this.trees.update(state, epoch, c2); this.lastTreeUpdate = now; }
    this.buildings.update(state, tickF);
    this.grass.update(c2);
    this.sky.mesh.position.copy(this.camera.position);
    this.post.grade.uniforms.uPaint.value = this.paint ? 1 : 0;
    this.post.composer.render(dt);
    return info;
  }
}

export { HS, V, N };
