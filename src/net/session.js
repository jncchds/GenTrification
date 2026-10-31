// Sessions own the clock and the log. Local play keeps the log in localStorage;
// multiplayer gets the ordered log from the server (see server/server.js).
import { Engine, encodeSave, decodeSave } from '../sim/engine.js';
import { HOURS } from '../sim/climate.js';

export const TICKS_PER_SEC = 4;   // 1x speed: one in-game hour every 0.25 s (a day in 6 s)
const SAVE_KEY = 'gentrification.save.v1';
const MAX_OFFLINE_DAYS = 30;

export class LocalSession {
  constructor({ seed, code, startTick = 0 }) {
    let log = [], tick = startTick, savedAt = null;
    if (code) ({ seed, log, tick } = decodeSave(code));
    else if (seed === undefined) {
      try {
        const raw = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
        if (raw) { ({ seed, log, tick } = decodeSave(raw.code)); savedAt = raw.savedAt; }
      } catch { /* no usable save */ }
    }
    if (seed === undefined) seed = (Math.random() * 2 ** 32) >>> 0;
    // A brand-new world opens on a spring morning (day 3, 08:00) rather than before dawn.
    if (!code && !savedAt && !log.length && tick === 0) tick = 2 * HOURS + 8;
    this.engine = new Engine(seed, log);
    this.engine.advanceTo(tick);
    this.owner = 1;
    this.mode = 'local';
    this.speed = 1;
    this.frac = 0;
    // Offline catch-up: the world kept living while you were away (capped).
    this.offlineTicks = 0;
    if (savedAt) {
      const away = Math.floor(((Date.now() - savedAt) / 1000) * TICKS_PER_SEC);
      this.offlineTicks = Math.min(away, MAX_OFFLINE_DAYS * HOURS);
    }
    this.target = tick + this.offlineTicks;
    this.lastSave = 0;
  }
  get seed() { return this.engine.seed; }
  // Wall-clock -> target tick.
  advance(dt) {
    if (this.speed > 0) {
      this.frac += dt * TICKS_PER_SEC * this.speed;
      const whole = Math.floor(this.frac);
      this.frac -= whole;
      this.target += whole;
    }
    const done = this.engine.advanceTo(this.target, 12);
    if (!done) this.frac = 0;
    const now = performance.now();
    if (now - this.lastSave > 5000) { this.save(); this.lastSave = now; }
    return done;
  }
  place(e) {
    const entry = { ...e, tick: this.engine.state.tick, owner: this.owner };
    this.engine.add(entry);
    return entry;
  }
  saveCode() { return encodeSave(this.engine.seed, this.engine.state.tick, this.engine.log); }
  save() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify({ code: this.saveCode(), savedAt: Date.now() })); } catch { /* storage full or blocked */ }
  }
  static clearSave() { try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ } }
}

// Multiplayer: the server orders the log and owns the clock; every client replays it.
export class RemoteSession {
  constructor(url, room, name, onStatus) {
    this.mode = 'remote';
    this.speed = 1;
    this.frac = 0;
    this.onStatus = onStatus || (() => {});
    this.roster = {};
    this.ready = new Promise((resolve, reject) => {
      let token;
      try { token = localStorage.getItem('gentrification.token'); } catch { /* ignore */ }
      if (!token) { token = Math.random().toString(36).slice(2) + Date.now().toString(36); try { localStorage.setItem('gentrification.token', token); } catch { /* ignore */ } }
      const ws = (this.ws = new WebSocket(url));
      ws.onopen = () => ws.send(JSON.stringify({ t: 'join', room, name, token }));
      ws.onerror = () => reject(new Error('Could not reach the server at ' + url));
      ws.onclose = () => this.onStatus('Disconnected from server');
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.t === 'welcome') {
          this.engine = new Engine(msg.seed, msg.log);
          this.owner = msg.you;
          this.start = msg.start; this.msPerTick = msg.msPerTick;
          this.offset = msg.now - Date.now();
          this.roster = msg.roster;
          resolve(this);
        } else if (msg.t === 'entry') {
          this.engine.add(msg.entry);
        } else if (msg.t === 'roster') {
          this.roster = msg.roster;
        } else if (msg.t === 'reject') {
          this.onStatus('Server rejected placement: ' + msg.reason);
        }
      };
    });
  }
  get seed() { return this.engine.seed; }
  serverTick() { return Math.floor((Date.now() + this.offset - this.start) / this.msPerTick); }
  advance() {
    const t = this.serverTick();
    const done = this.engine.advanceTo(t, 12);
    this.frac = done ? ((Date.now() + this.offset - this.start) % this.msPerTick) / this.msPerTick : 0;
    return done;
  }
  place(e) {
    // Ask for a tick slightly ahead so the entry usually arrives before we simulate it.
    const entry = { ...e, tick: this.engine.state.tick + 2, owner: this.owner };
    this.ws.send(JSON.stringify({ t: 'place', entry }));
    return entry;
  }
  saveCode() { return encodeSave(this.engine.seed, this.engine.state.tick, this.engine.log); }
  save() {}
}
