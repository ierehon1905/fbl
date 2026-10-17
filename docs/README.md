# Documentation index

Start here. Each file below covers one capability end to end — what it does, why it works the
way it does, and where the code for it lives. The point of the index is to save you reading
three files to find out which one you wanted, so the line under each is *when you would open
it*, not what it is about.

If you are about to change something and cannot tell which file covers it, that is a gap in
this index; fix the index too.

## The files

| File | Open it when |
|---|---|
| **[language.md](language.md)** | You are writing or changing fbl itself: syntax, types, records, blocks, layout forms, defaults, libraries, and what the checker refuses. |
| **[routing.md](routing.md)** | A belt goes somewhere unexpected, or you are touching `auto` — tunnels, merging, when two belts are the same line. |
| **[blueprint.md](blueprint.md)** | Something is wrong in the exported string, or a version behaves differently: the encoding, positions, directions, modules, quality. |
| **[calculator.md](calculator.md)** | The calculator's **production** tab: the linear programme, what it decides and what it refuses to decide, the diagram, the controls, sharing a plan by link. |
| **[recycling.md](recycling.md)** | The calculator's **recycling** tab: farming quality through a loop of assemblers and recyclers, and why the odds are nothing like what people expect. |
| **[quality-strategy.md](quality-strategy.md)** | You are deciding when to chase quality in your own game, or you want to see what the recycling tab is for: a worked answer with charts, all of it re-derived from the data. |
| **[map-editing.md](map-editing.md)** | You are building — or arguing about — editing the blueprint on the canvas and having it write the source: builder mode, the cursor, what it refuses and why. Design, not yet built. |
| **[studio.md](studio.md)** | Anything on the editor page: the preview, the editor's language service, the cost and rates panels, the power overlay, saved schemas. |
| **[data.md](data.md)** | **Before** changing which recipes are usable, what counts as raw, or which recipe leads a list. Every trap in the dataset is written down here, and each one produced a plausible-looking wrong answer before it was found. |
| **[sprites.md](sprites.md)** | A sprite lands in the wrong place, is missing, or the atlas needs rebuilding. |
| **[architecture.md](architecture.md)** | You need to know where a thing lives, how the two pages are split, or how to build, test and deploy. |
| **[limits.md](limits.md)** | Before trusting a generated blueprint with a real base, or when deciding what to build next. |

## Where the knowledge actually is

Three places, and they are not interchangeable:

- **These files** — why a capability works the way it does, and the decisions behind it.
- **The comments in the code** — why *this* code, right here, is shaped this way. The house
  style is prose above the thing it explains, saying what would go wrong otherwise.
- **The tests** (`tests/*.test.mjs`) — what the behaviour actually is. Where a doc and a test
  disagree, the test is right until someone proves otherwise; where the code and a test
  disagree, one of them is a bug.

## The one rule

**Change the behaviour, change the file that describes it, in the same pass.** A doc that has
drifted is worse than no doc, because it is believed. See [../CLAUDE.md](../CLAUDE.md).
