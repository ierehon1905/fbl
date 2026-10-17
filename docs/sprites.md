# Sprites

Where the game's own art comes from, and the four conventions that have to be read exactly
right or every picture lands in the wrong place. All four were found by looking at the result,
not by reasoning about the data — that is the standing lesson of this file.

### Real game art

```bash
"<factorio>/factorio.app/Contents/MacOS/factorio" --dump-data   # writes data-raw-dump.json
npm run extract-sprites                                          # → public/sprites/ (12MB)
```

The extractor finds a Steam or /Applications install by itself; override with `--data` and
`--dump`, or `FACTORIO_DATA` / `FACTORIO_DUMP`. `--ppt 32` quarters the atlas at the cost of
sharpness when zoomed in. Without an atlas the studio still runs: every entity is drawn
as a colour-coded footprint instead of its art, and the console says why.

### The browser keeps its own copy

Thirteen megabytes is too much to download twice, and the HTTP cache will not stop it. GitHub
Pages serves with `cache-control: max-age=600` and an ETag built from the file's **modification
time and size** — `"6ace5e4a-1b66a0"` — so every deploy stamps a new ETag on every file, whether
or not anything in it changed. Ten minutes later the browser revalidates, is told the file is
new, and pulls the whole atlas again. Deploy on a Tuesday afternoon and everyone who visits
afterwards pays for art that has not changed since August.

So the studio keeps the art itself, under the one thing that does change when the art changes:
a hash of the PNG's contents, written into `atlas.json`. `loadAtlas` stores the bytes in Cache
Storage keyed by it, so a second visit asks the network for the manifest — 72 kB, and it is what
carries the hash — and nothing else. When the hash is new the art is fetched once and the old
entry is dropped.

**Nobody has to remember to make that happen.** The extractor writes the hash, and so does the
build (`scripts/stamp-atlas.mjs`), which matters because the atlas is not built in CI: it is
fetched from the `assets` branch, which may hold a manifest made before any of this existed.
The build stamps whatever it finds, every time, and does nothing at all when there is no atlas.

And if a manifest somehow arrives without one, caching still happens: the manifest's own text
stands in as the key. It carries the game version, the sheet's dimensions and the rectangle of
every sprite on it, so art that changed without changing any of those would have to be a
recompression of an identical layout.

Every part of it is optional beyond that: no Cache Storage, a private window, a quota refusal —
each falls through to a plain fetch, which is what happened before.

Hold **Alt** over the preview and the tile under the cursor lights up with its coordinate, ready
to type into the source — negative numbers and all. The hover tooltip stands aside while it is
up, since it would cover the thing being read.

## What the extractor does

`scripts/extract-sprites.mjs` reads the prototype dump and the game's own PNGs and writes
`public/sprites/atlas.png` plus a JSON index. Per entity it resolves the layer stack, picks the
north variant, thins the shadow layer, and records the rect and the sprite's own `shift` so the
renderer can put overhang where the game puts it.

Two things about shadows: `sharp`'s `composite()` has **no** `opacity` option, so a shadow
composited the obvious way comes out solid black. It is thinned with a `dest-in` veil instead.
And a machine's working-state visualisations are only included when the prototype says
`always_draw`; `animated_shift` layers and `mining_drill_scorch_mark` are excluded, which is
what fixed the black hole where an electromagnetic plant should have been.

## The conventions

- **The sprite atlas is a still frame.** One frame per entity, no animation, no working-state
  overlays, and no inserter arms — inserters show their platform, which is what carries their
  facing. 85 of 86 entities resolve; `heat-pipe` names its connection sprites differently and
  falls back to a plain footprint.
- **Belt orientation is derived, not stored.** A belt tile knows only which way it faces; the
  curve art comes from its neighbours. Factorio names those sprites by the side items arrive
  *through*, not by the direction they were travelling — a belt running east enters the corner
  through its west edge, so the piece that turns it south is `west-to-south`. Reading it the
  other way mirrors every bend, which is a bug you only notice by looking. The 20 orientation
  indices are Factorio's defaults, absent from the dump because every vanilla belt uses them;
  they were read off a contact sheet of the sheet itself. A neighbour counts as feeding the
  tile when it *points* at it — comparing directions rather than adding a direction to the
  neighbour's origin, which is what makes a splitter work: it is two tiles wide and its
  position is only one of them, so the arithmetic missed whichever lane it was not on and the
  belt leaving it came out straight.
- **A machine with a fluid recipe grows pipe stubs.** The game keeps them out of the machine's
  own art — a dry assembler has no pipes at all — and supplies one sprite per side, drawn
  relative to the fluid box rather than to the machine, and keyed by the side the stub is
  *seen from*: the sprite for a connection pointing north is `south`. Read either of those the
  obvious way and every pipe lands on the wrong edge, which is how both were found. A third
  thing has to be measured rather than read: a machine is drawn in perspective, so its body
  does not reach its own footprint on every side — an assembler overshoots its top by a third
  of a tile and falls short of its sides by the same. A stub placed by the numbers therefore
  meets the body at the top and floats a visible gap away from it at the sides, so the
  extractor measures the opaque art and seats each stub against it. Only boxes the game gave
  art for all four sides of are drawn; the foundry has one sprite for its own fixed
  orientation, and turning that would be inventing art. A chemical plant needs none of this —
  its pipes are part of its sprite already — but its art has open mouths, and the cap that
  closes them is a separate `pipe_covers` sprite the game draws on any connection with nothing
  attached. Without it you look straight down the hole, which is what a chemical plant used to
  look like here. The cap goes on the tile the pipe would have taken, not on the machine's own,
  and a pipe standing there suppresses it — for which a pipe has to count a fluid machine as a
  neighbour, or it draws its lonely end instead of the one that meets it.
- **Splitters and undergrounds are drawn in several pieces**, as the game draws them. A
  splitter is two belt lanes, then `structure_patch`, then `structure` — its main housing only
  reaches over one lane, so without the patch half the splitter renders as bare belt. An
  underground is `back_patch`, half a tile of belt, the hood, then `front_patch`. Each missing
  piece looks like a different bug, and none of them is visible in the prototype's obvious
  fields; [Factorio Blueprint Editor](https://github.com/teoxoy/factorio-blueprint-editor)'s
  `spriteDataBuilder.ts` is the reference for what order to draw them in.
- **Both ends of an underground pair carry the same `direction` in the blueprint**, and are
  drawn facing opposite ways. `direction` is the flow; `type: input` / `type: output` tells the
  ends apart. The game then renders an output rotated 180°, so a pair reads as two ramps
  facing each other. Ask the game and it says so plainly: placing an east-facing pair returns
  `a dir=4 type=input | b dir=4 type=output | paired=true`. Take the data at face value and
  you draw both ramps the same way round, which looks wrong and is.
- **A missing sprite name used to fall back to an arbitrary one.** An underground's
  `undergroundType` is `input`/`output` in the blueprint but `in-`/`out-` in the atlas, and the
  mismatched key quietly resolved to whatever variant sorted first — every underground drawn
  facing north while its tooltip read *facing east*. All variant naming now lives in
  `src/core/topology.ts`, a miss draws the footprint fallback instead of a wrong orientation,
  and a test walks every entity in every example to check the name exists.
- Nothing has been pasted into the game and verified tile-for-tile. That is the next test
  worth writing: export a known blueprint from Factorio, decode it, and diff.
