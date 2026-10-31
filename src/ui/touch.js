// Touch controls.
//  First person: floating joystick on the left half, drag anywhere else to look,
//                buttons for jump / build / map.
//  Map view:     one finger pans, two fingers pinch-zoom and twist-rotate, tap picks a spot.
export const isTouchDevice = () => matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

export class TouchControls {
  constructor(root, canvas, view, actions) {
    this.view = view; this.actions = actions;
    this.pointers = new Map();
    this.stick = null;
    const el = document.createElement('div');
    el.className = 'touch';
    el.innerHTML = `
      <div class="stick" id="t-stick"><div class="knob" id="t-knob"></div></div>
      <div class="tbtns">
        <button class="tb" id="t-map" title="Map / walk">🗺</button>
        <button class="tb" id="t-jump" title="Jump">⤒</button>
        <button class="tb primary" id="t-build" title="Build here">✓</button>
      </div>`;
    root.appendChild(el);
    this.el = el;
    const $ = (id) => el.querySelector('#' + id);
    this.stickEl = $('t-stick'); this.knob = $('t-knob');
    const tap = (id, fn) => $(id).addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
    tap('t-map', () => actions.toggleMap());
    tap('t-jump', () => { view.fp.wantJump = true; });
    tap('t-build', () => actions.place());

    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    canvas.style.touchAction = 'none';
  }

  update() {
    this.el.classList.toggle('map', this.view.mode === 'map');
  }

  down(e) {
    if (e.pointerType !== 'touch') return;
    e.preventDefault();
    const p = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(), kind: 'look' };
    if (this.view.mode === 'fp' && e.clientX < window.innerWidth * 0.4 && !this.stick) {
      p.kind = 'stick';
      this.stick = p;
      Object.assign(this.stickEl.style, { left: e.clientX - 60 + 'px', top: e.clientY - 60 + 'px', display: 'block' });
      this.knob.style.transform = 'translate(0px, 0px)';
    }
    this.pointers.set(e.pointerId, p);
    if (this.view.mode === 'map' && this.pointers.size === 2) this.pinch = this.twoFinger();
  }

  twoFinger() {
    const [a, b] = [...this.pointers.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(b.y - a.y, b.x - a.x), dist: this.view.map.goal.dist, yaw: this.view.map.goal.yaw };
  }

  move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    const view = this.view;
    if (p.kind === 'stick') {
      let sx = p.x - p.x0, sy = p.y - p.y0;
      const l = Math.hypot(sx, sy), max = 55;
      if (l > max) { sx *= max / l; sy *= max / l; }
      this.knob.style.transform = `translate(${sx}px, ${sy}px)`;
      view.fp.touchMove = { r: sx / max, f: -sy / max };
      return;
    }
    if (view.mode === 'fp') { view.fp.look(dx * 0.005, dy * 0.005); return; }
    // map gestures
    if (this.pointers.size >= 2 && this.pinch) {
      const now = this.twoFinger(), g = view.map.goal;
      g.dist = Math.min(260, Math.max(8, (this.pinch.dist * this.pinch.d) / Math.max(now.d, 1)));
      g.yaw = this.pinch.yaw - (now.ang - this.pinch.ang);
    } else if (this.pointers.size === 1) {
      view.map.pan(-dx * view.map.dist * 0.0022, -dy * view.map.dist * 0.0022);
    }
  }

  up(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    if (p.kind === 'stick') {
      this.stick = null;
      this.stickEl.style.display = 'none';
      this.view.fp.touchMove = null;
      return;
    }
    if (this.pointers.size < 2) this.pinch = null;
    // A short, still touch is a tap: in map view it picks where to build.
    const still = Math.hypot(p.x - p.x0, p.y - p.y0) < 10 && performance.now() - p.t0 < 350;
    if (still && this.view.mode === 'map') this.actions.tapAt(p.x, p.y);
  }
}
