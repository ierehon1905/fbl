# Architecture

## Where things are

```
src/core/          the language — no DOM, runs in Node too
  lexer.ts         text → tokens
  parser.ts        tokens → AST
  types.ts         the type lattice and the closed vocabularies
  slots.ts         which slots each entity, helper and block accepts
  labels.ts        where every argument name is written, for the editor to paint
  metadata.ts      reads the slots written as brackets: content, filters
  modules.ts       the standard library — fbl source, plus the helpers it unlocks
  check.ts         the static pass; everything above runs before a single placement
  run.ts           AST → placements (frames, layout, defaults, helpers)
  scene.ts         the placement accumulator; bbox, translate, collision
  blueprint.ts     scene → blueprint JSON → string
  proto.ts         prototype registry
src/data/          game data: dataset schema, version profiles, geometry table
src/ui/            studio: canvas renderer, Monaco editor, generated docs, wiring
  lang/            language service: tokenizer, completion context, providers
examples/*.fbl     the programs in the example dropdown
```

`src/core` never imports from `src/ui`. `npm run build:core` bundles it for Node, which is
what the tests run against and what a CLI would use.

## The two pages

`index.html` is the studio; `calc.html` is the calculator. They are separate Vite entry points
on purpose — the calculator has no editor, and making it share one bundle would have it load
four megabytes of Monaco to draw a diagram. They share `src/core`, `src/data`, and the small
pieces of `src/ui` that are not about the editor (`base.css`, `icons.ts`, `sankey.ts`).

```
src/core/calc/     the calculator's core: recipe graph, LP solver, machine maths, the
                   quality ladder, links
src/calc/          the calculator page: cards, pickers, diagram, rail, state
src/ui/sankey.ts   flow-diagram layout: columns, ordering, lanes, ports — no DOM
src/ui/base.css    palette, reset, toolbar — both pages start here
```

## Building and testing

```bash
npm test          # bundles the core for Node, then runs every test
npm run dev       # http://localhost:5273
npm run build     # typecheck, then both pages
npm run audit     # asks the solver for every craftable item in all four datasets
npm run charts    # redraws the figures in docs/quality-strategy.md
```

`npm run charts` is the one thing here that is not JavaScript: it solves the ladders in Node and
draws them with matplotlib, so it needs Python with matplotlib and pillow. Nothing else does,
and no build or test depends on it.

`npm run build:core` bundles `src/core/index.ts` **and** `src/ui/sankey.ts` for Node, which is
what the tests import. Anything worth testing has to be reachable from one of those two and
must not touch the DOM.

Tests live in `tests/*.test.mjs` and run against the bundle, not the source, so they exercise
what actually ships.

## Deploying

`.github/workflows/deploy.yml` builds the studio and publishes it to GitHub Pages on every
push to `main`. It is a static site with no backend, so there is nothing else to run.

The one piece of the game's art that *is* committed is `public/favicon.png` — the game's own
icon, 25 kB, so the browser tab has a face. That is a different scale of thing from a sheet of
every item in the game, which is why the rule below does not cover it. `npm run extract-sprites`
refreshes it from the same install as everything else, so it is re-derivable rather than a blob
nobody can account for.

Game data is kept out of `main`, two different ways:

- **Datasets and icon sheets** are fetched at run time from
  [FactorioLab](https://factoriolab.github.io), which serves them with
  `access-control-allow-origin: *`. `npm run fetch-data` puts a local copy under `public/data/`
  for development, and the loader prefers it whenever it is there. CI fetches a copy to run the
  tests, then deletes it before building, because Vite copies `public/` verbatim.
**Caching, and what Pages does to it.** GitHub Pages allows ten minutes of freshness and dates
its ETags by file mtime, so a deploy invalidates everything it publishes — including files it
did not change. Vite's hashed bundle names do not help: same URL, new ETag, full body. It is
only worth engineering around for the thing big enough to notice, which is the 13 MB sprite
atlas; that one the studio keeps in Cache Storage keyed by a content hash, and
[sprites.md](sprites.md) explains how.

- **The sprite atlas lives on the `assets` branch.** It cannot be built in CI — the extractor
  reads the game's own PNGs — so it has to be committed somewhere, and 12MB has no business in
  the history of every clone of the source. The deploy workflow checks that branch out into
  `public/sprites/` before building. To refresh it, run `npm run extract-sprites` on `main` and
  push the result to `assets`.

Nothing blocks on the art. The dataset is all that compiling needs, so the studio opens as soon
as it lands; the icon sheet and the atlas stream in behind it with a progress chip in the
corner, and the footprints give way to the game's art when the atlas arrives.

The build is ~14MB of code, almost all of it Monaco's lazily-loaded language chunks — the page
itself pulls about 1MB gzipped, then the 12MB atlas in the background.
