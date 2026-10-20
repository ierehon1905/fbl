# Honest limits

What is real, what is approximate, and what is not there at all. Read this before trusting a
generated blueprint with a real base.

## What is real

This is an MVP. What is real: the reader, the checker, the evaluator, blocks, frames, layout,
the prototype registry, the exporter (both module formats, both direction scales), the
collision check, the round-trip through a real blueprint string, and — on the second page — the
solver and everything built on it.

What to know before trusting it with a real base:

- **Entity geometry is partly hand-written.** [FactorioLab](https://factoriolab.github.io)
  is a ratio calculator, so it carries sizes for the 28 crafting machines only. Belts,
  inserters, poles and pipes are typed by hand in `src/data/entity-geometry.ts`. Point
  `scripts/fetch-data.mjs` at a `factorio --dump-data` export and that file becomes a
  fallback rather than a source.
- **The inserter direction convention is pinned by a test, not by the game.** `:dir` names
  the tile the inserter drops into, reasoned from the prototype's `pickup_position {0, 1}`
  and `insert_position {0, -1.2}`. If it turns out inverted in game, flip one call in
  `entities.ts`; one assertion changes with it. `:from` exists so you never have to care.
- **Underground reach values (4/6/8/10) are the tooltip numbers**, used for a warning only.
- **The balancer library is someone else's work.** It is a public community blueprint book,
  re-encoded into `src/data/balancers.json` with its source recorded in the file. The
  extractor re-runs from the original URL, so the derivation is reproducible rather than a
  blob of unexplained coordinates.
- **No macros.** The v1 Lisp had them; this syntax is not homoiconic, and both macros in the
  old examples turned out to be plain blocks with a `for` inside. The AST is shaped so they
  could come back as AST macros, but nothing depends on that today.
- **No circuit wires, no rails, no fluids beyond placing pipes.** Copper wires between poles
  are the exception: the exporter writes them (see [blueprint.md](blueprint.md)). No automatic belt routing —
  `via` corners are yours to choose.
- **The production tab cannot recycle.** Recycling recipes are left out of the graph a factory
  is planned from, so a plan never says "shred fifteen scrap a second for that". On Fulgora,
  where scrap is the whole economy, holmium ore is an input rather than something to make. The
  recycling *tab* models shredding properly; the production one does not use it as a source.
- **The checker does not track throughput.** The arithmetic exists — the studio's rates panel
  and the calculator both use it — but nothing in the checker warns that a belt cannot carry
  what is being put on it.
- **The bundle is 4MB**, almost all of it Monaco. Trimming it means hand-picking the editor
  contributions instead of importing the whole package, and completion is the reason Monaco
  is here at all — so it stays whole until the size actually hurts.

## Next, roughly in value order

The first one is not a formality: everything in this repository rests on it.

1. Paste a generated blueprint into the game and diff it against a hand-built one.
   Everything else rests on that.
2. Real prototype data from `--dump-data`, which also unlocks mods.
3. Ports on blocks: declare `:in` / `:out` tiles so blocks connect instead of being placed
   next to each other and hoped over.
4. Throughput checking in the *language*. The numbers exist on both pages now — the rates
   panel says what the machines on screen eat and make, and the calculator solves the other
   direction — but nothing warns you that a yellow belt cannot feed the row it is feeding.
   `content` is the other half of it: it says which belt carries what, so a throughput check
   has somewhere to start.
5. A decompiler: blueprint string → source. The fastest way to a standard library is to
   read existing blueprint books back into blocks.
