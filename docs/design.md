# Design

## Core idea

The whole world is a pure function of a single seed plus a log of player placements. No map
is ever stored; a save is just numbers.

```
state(t) = simulate(seed, placement_log, t)
placement = (tick, owner, type, x, y, size, building_seed)
walker    = (x, z, yaw, warmth, wetness)      # your own player state, never read by the world
```

**Hard rule:** everything in the simulation derives from seed + log. The walker's needs
are a small player state on top of that: they read the world (weather, water, houses) but the
world never reads them. A whole game is seed + log + player state. The simulation is
integer-only with a seeded PRNG, so every client computes identical bits. Rendering is
separate and uses floats, noise and shaders freely, because it only draws simulated state.

## Decisions (beyond the original brief)

| Topic | Decision |
|---|---|
| Platform | Web: Three.js + Vite, plain ES modules. The sim runs unchanged in Node (tests, server). |
| Camera | **First person** by default (walk, look, build at the crosshair). Overhead map view on Tab for planning. |
| Mobile | Touch joystick + look-drag, build/jump/map buttons; map gestures; lower GPU settings on touch devices. |
| Time | **1 tick = 1 hour.** 24 h days, 12-day seasons, 48-day years. 1× speed = one hour every 5 s (a day in 2 min, a season in 24 min, a year in about 1.6 h). Fast-forward: 5×, 20×, 100×. Multiplayer runs at 1×. |
| Climate | Season, temperature (with altitude lapse), clouds, rain, snow, wind and storms are pure functions of (seed, tick). Never stored. |
| Terrain | Domain-warped fbm island, ridged mountains with terraced cliffs. Priority-flood drainage fills pits into **lakes**, flow accumulation carves **rivers**, and big drops become **waterfalls**. |
| Chunks | 256×256 cells in 8×8 chunks of 32. Each chunk has a seeded tree-cap and fertility multiplier. Forest growth runs once a day per chunk (staggered across hours); settled chunks sleep. |
| Nature health | Derived per player from the 3×3 chunk neighbourhood of their buildings: 60% tree cover, 25% healthy-forest chunks (biodiversity), 15% reserves. |
| Score | Sustained population: a moving average of population that only counts days with nature ≥ 60%. |

## Seasons and weather in play

Each season has its own weather. Fronts last several days, which is what makes a run of
bad weather.

| Season | Mean temp | Character |
|---|---|---|
| Spring | ~9 °C | mild, showers on about half the days, breezy |
| Summer | ~21 °C | mostly clear (about two thirds of hours), dry spells, afternoon thunderstorms on about 1 day in 5 |
| Autumn | ~7 °C | grey and wet, gales, foggy calm mornings, first snow late in the season |
| Winter | ~−5 °C | snow, clear frosty nights, occasional blizzards |

`node tools/climate.mjs [seed] [years]` prints these statistics for any seed.

- Crops grow from ~4 °C, best from 16 °C, and suffer heat stress above 30 °C. Nothing grows in winter.
- Firewood use = cooking + 8 milli-wood per person per degree below 16 °C (daily mean): about
  0.17 wood per person per day in deep winter.
- Forest regrowth by season: spring 1.5×, summer 1.1×, autumn 0.45×, winter ~0. Rainy days help.
  Bare ground reseeds only in spring and summer, and only next to standing trees.
- Mills and farms work in daylight (longer days in summer); storms and blizzards stop work.
- Births follow the seasons. Newcomers only settle with ≥ 5 days of food and firewood in store.
- Shortages: households move away in proportion to the unmet share of the day's food or
  firewood (winter cold drives more of them away), instead of all at once.

## Simulation summary

- Trees per cell `T` in 0..1000 (one full tree), logistic growth `dT = r·T·(1 − T/K)` with
  stochastic rounding from a seeded hash, so small stands still regrow deterministically.
- Mills thin cells down to 25% of cap first (sustainable while regrowth keeps up), then
  clear-cut. That is how overcutting collapses a forest.
- Farms: food = Σ(fertility) × yield × efficiency × staffing × temperature factor. Soil wears
  about 1 point per working day (quirks change this), and recovers 0.5 per day when fallow.
- Workers: farms need ⌈size²/4⌉, mills 2×size, reserves 1. A shortage scales all output.

## The walker's needs (warmth and wetness)

A cozy survival layer for the first-person walker, kept out of the world simulation.

| Thing | Effect |
|---|---|
| Felt temperature | Air temperature at your spot (altitude lapse), minus wind chill (up to 7 °C), minus 6 °C when soaked, minus 4 °C wading / 9 °C swimming, plus 4 °C in sunshine, plus 3 °C running |
| Warmth 0–100 | Below 12 °C felt you lose 0.03 per degree per second. Above it you warm up slowly |
| By the fire | Within 4 cells of any house you feel at least 24 °C: warm up and dry off quickly |
| Wetness 0–1 | Rain soaks slowly (snow slower), wading fast, swimming at once. Warm air, sun and a hearth dry you |
| Cold | Below 40 warmth you slow down (to 70% at 0), and a frosty vignette creeps in |
| Out of warmth | You wake at your last built house (or where you arrived, if you have none) at 70 warmth, dry |
| Water | Shallow water is waded (slower). Deeper than ~1.4 m you swim (slow, no running or jumping) and can pull yourself out onto banks |

Rough timings: a winter walk (−5 °C, breezy) lasts about 2½ minutes from full warmth; a winter
swim about 1½; a summer swim is fine for half an hour of real time.

Needs run in real seconds while you play (paused with the game). While you're away they are
replayed hour by hour (5 s per game hour) against the seeded weather where you stood, so the
result is still a pure function of seed + log + player state. The player state is stored in
the save code (an optional fifth segment) and in local storage.

## Balance

`node tools/balance.mjs` plays several strategies on several seeds for a few years: *idle*
(one house), *plan* (the demo bot), *steward* (reacts to food, firewood, housing and nature
like a careful player) and *greedy* (big mills and farms, no reserves). `--set=k=v` tries
constants without editing `rules.js`.

Findings before this pass, and what changed:

- **Wood didn't matter.** Stocks only ever grew (into the thousands), heating cost about
  0.1 wood per person per winter day, and clearing forest for a farm refunded more wood than
  the farm cost. A careful player grew to 900 people on one mill. Now firewood costs 8 per
  degree (was 5), each tree unit gives 8 milli-wood (was 10), mills cut 20 units per size step
  (was 14), and clearing refunds a quarter of the wood (was half). Mills now press on the
  forest and the winter woodpile is something to plan for.
- **Boom and bust.** Populations filled every house by autumn and then lost half to
  famine every winter. Now newcomers need 5 days of stores, and shortages drive people away
  in proportion to what's missing.
- Results over 8 seeds × 3 years: a careful player reaches ~250 people with nature above
  60%. The greedy mill village grows to ~160, then falls below the 60% nature line and goes
  hungry every winter. Doing nothing still fails (no farms, no food).

## Visuals

Painterly and stylised, fully procedural, no art assets:

- Terrain shader blends sand, grass, forest floor, meadow, rock (by slope) and snow (snow line
  from the day's temperature, lowland cover in cold spells), with brush-stroke noise, seasonal
  palettes, farm furrows and crops by season, and data overlays.
- Trees: recursive branching broadleaves with fluffy leaf clumps (normals pointing away from
  the clump centre), and layered conifers. Seeded variants, wind sway, seasonal colours,
  leaves that fall in autumn, snow on top. Distant trees are billboard impostors rendered
  from the same models.
- GPU-instanced grass and flowers around the player, read from data textures.
- Water: depth colour, shore foam, sky reflection, flowing normals along river flow, foam
  streaks on waterfalls, and mist.
- Buildings: a shape grammar per type driven by size and seed (cottages with gable roofs,
  chimneys and lit windows; barns, silos, haystacks, fences; sawmills with log piles and
  water wheels; reserves with lanterns and gazebos). Each flies a banner in its owner's colour.
- Atmosphere: sun and moon paths by season, sky gradient, stars, clouds that follow the
  weather, fog, rain, snow, lightning, soft shadows, bloom, a Kuwahara paint filter and
  colour grading.

## Original build order (status)

1. Seeded PRNG + noise terrain: done
2. Chunking + placement-log data model: done
3. Placement with seed-driven shapes: done
4. Tick simulation with offline catch-up: done (catch-up capped at 30 days when loading a local save)
5. Resource loop + nature health: done
6. Pretty rendering pass: first pass done
7. Multiplayer log sync: done (Node WebSocket server)

## Ideas not done yet

- Multiplayer hosting (Pages is static only), player names on banners, chat.
- Smoke from chimneys, animals, roads, seasonal events.
- Smarter LOD and chunk streaming for bigger worlds.
- Tutorial / onboarding.
