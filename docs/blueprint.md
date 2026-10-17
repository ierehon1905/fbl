# Blueprints and versions

What a program turns into, and what changes between game versions.

## Versions

The switcher covers Space Age 2.1, Space Age 2.0, Factorio 2.0 and Factorio 1.1. It is not
cosmetic — it changes the entity list, the recipes and the export format:

| | 1.1 | 2.0+ |
| --- | --- | --- |
| direction | 8-point (east = 2) | 16-point (east = 4) |
| modules | `{"speed-module-3": 2}` | `items` array of insert plans with inventory + slot |
| quality | — | supported |

Switch the assembler-line example to 1.1 and it fails on `bulk-inserter`, which is 2.0's
rename of `stack-inserter`. That is the switcher working.

## The string

A blueprint string is the character `0`, then base64 of a zlib-deflated JSON object. The
exporter writes the JSON, deflates at level 9 and prefixes the version byte; the decoder in
`src/core/blueprint.ts` reads it back, which is what the round-trip test exercises.

An entity's `position` is the centre of its footprint, not a corner — a 3×3 assembler at
tiles (0, 0)–(2, 2) has position (1.5, 1.5) — and the exporter converts from the internal
top-left-plus-size form on the way out.

A recipe is written under the game's name, which is not always the dataset's: the dataset
calls the ore-melting recipes `iron-ore-melting` and `copper-ore-melting` because the game
names them after the fluid they make (`molten-iron`, `molten-copper`). The game drops any
machine whose recipe it does not know, so the exporter maps them back (`GAME_RECIPE_NAMES`).
The thumbnail icons are recipe signals on 2.0 and later.

## Directions

Internally every direction is on the 16-point scale that 2.0 introduced: north 0, east 4,
south 8, west 12. The exporter halves them for 1.1, which is the only thing `directionScale`
in the version profile is for. A direction is omitted entirely for entities the game does not
rotate, because writing one makes the game refuse the blueprint.

Inserters are the one place a program and the game disagree on what a direction means. A
program says where an inserter **drops** — `south`, or `from north` — because that is what you
think about when you lay one down. The game points an inserter at where it **picks up**. The
exporter and the sprite picker both turn an inserter round on the way out (`gameDirection` in
`src/core/geometry.ts`); everything inside the language keeps the drop direction.

## Modules and quality

Two formats, chosen by the version profile:

- **`items-array`** (2.0 and later) — an array of plans, each naming an item, a quality and
  which inventory slots it goes in.
- **`items-map`** (1.1) — a flat `{"speed-module-3": 2}` count map, with no notion of quality.

Quality rides on the module entry and on the entity itself. On a version whose profile says
`supportsQuality: false` both are dropped rather than written as `normal`.
