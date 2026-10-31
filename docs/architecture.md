# Architecture

```
src/sim/      deterministic simulation (integer math only, runs in browser and Node)
  prng.js       hashing (Math.imul), mulberry32, seed parsing
  noise.js      integer value noise + fbm (output 0..1023)
  world.js      seed -> static world: heights, drainage, lakes, rivers, waterfalls, biomes, caps, fertility
  climate.js    calendar + weather as pure functions of (seed, tick)
  rules.js      building definitions, quirks, economy constants
  sim.js        state, placement validation, the hourly step, nature health, state hash
  engine.js     timeline: log, snapshots, rollback/replay, save codes
  bot.js        settler bot (demo village and balance testing)
src/render/   Three.js renderer (floats allowed; only reads sim state)
src/ui/       HUD and touch controls
src/net/      local session (clock, localStorage, offline catch-up) and remote session (WebSocket)
server/       multiplayer log server (orders and stores the log; never simulates)
test/         determinism and multiplayer tests
tools/        map preview, demo layout, screenshots
```

## Determinism rules

Everything under `src/sim` must give bit-identical results on every JS engine:

- Only integers. Fractions are fixed-point (per-mille, milli-units, 10-bit noise).
  Division is always `Math.floor(a / b)` with operands well inside 2^31.
- No `Math.random`, `Math.sin/exp/pow/sqrt`, `Date`, or iteration over unordered keys.
  Integer sine (Bhaskara approximation) drives the seasonal curves.
- Randomness comes from `hash3(seed, a, b, c)`. "Probabilistic" events, including the
  stochastic rounding of tree growth, hash on (seed, tick or day, cell).
- Player iteration is in sorted id order. Building iteration is in creation order.

`npm test` checks this. The same log gives the same `hashState` whether it is simulated
live, all at once (offline catch-up), delivered late and shuffled (with rollbacks), or
loaded from a save code. A second test runs two WebSocket clients against the server.

## Tick order (one hour)

1. Apply this tick's log entries in log (`seq`) order. Invalid entries are ignored, deterministically.
2. In daylight, unless there's a storm: mills cut, farms grow food (depending on temperature).
3. The chunks whose turn it is this hour (`chunk % 24 == hour`) grow forest, reseed and recover soil, if awake.
4. At 23:00: each player eats and burns firewood, population changes, nature health and score update.

A chunk sleeps when nothing in it can change (all trees at cap or unable to reseed, soil
recovered). Any change wakes it and its neighbours. That is why long catch-ups are cheap:
two in-game years simulate in about 150 ms.

## Log entries and save codes

`{ tick, owner, type, x, y, s, seed[, seq] }`, with type 1 house, 2 farm, 3 mill, 4 reserve, 9 demolish.

A save code is `GT1.<seed>.<tick>.<base64url varints>`: each entry stored as
delta-tick, owner, type, x, y, size, seed.

## Multiplayer protocol (JSON over WebSocket)

| Direction | Message |
|---|---|
| client → server | `{t:'join', room, name, token}` |
| server → client | `{t:'welcome', seed, start, msPerTick, now, log, you, roster}` |
| client → server | `{t:'place', entry}` (asks for a tick slightly ahead of its own clock) |
| server → all | `{t:'entry', entry}`: the server sets `owner`, clamps `tick` to the future, assigns `seq` |
| server → all | `{t:'roster', roster}` |

The server's clock is `tick = (now − start) / msPerTick`. A client that receives an entry
for a tick it has already simulated rolls back to the latest snapshot (every 4 days) and
replays. Rooms persist to `server/data/<room>.json`.
