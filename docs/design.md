# Design

## Core idea

The whole world is a pure function of a single seed plus a log of player placements. No map
is ever stored; a save is just numbers.

```
state(t) = simulate(seed, placement_log, t)
placement = (tick, owner, type, x, y, size, building_seed)
```

**Hard rule:** everything in the simulation derives from seed + log. The simulation is
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
- Firewood use = cooking + a share per degree below 16 °C (daily mean).
- Forest regrowth by season: spring 1.5×, summer 1.1×, autumn 0.45×, winter ~0. Rainy days help.
  Bare ground reseeds only in spring and summer, and only next to standing trees.
- Mills and farms work in daylight (longer days in summer); storms and blizzards stop work.
- Births follow the seasons; the cold is deadlier in winter without firewood.

## Simulation summary

- Trees per cell `T` in 0..1000 (one full tree), logistic growth `dT = r·T·(1 − T/K)` with
  stochastic rounding from a seeded hash, so small stands still regrow deterministically.
- Mills thin cells down to 25% of cap first (sustainable while regrowth keeps up), then
  clear-cut. That is how overcutting collapses a forest.
- Farms: food = Σ(fertility) × yield × efficiency × staffing × temperature factor. Soil wears
  about 1 point per working day (quirks change this), and recovers 0.5 per day when fallow.
- Workers: farms need ⌈size²/4⌉, mills 2×size, reserves 1. A shortage scales all output.

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
