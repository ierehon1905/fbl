# Editing on the map

**Inspection, property editing and drawing belts are built.** Clicking an entity to find out
where it came from, and putting the caret in a line to see what it made, work in the ordinary
view. Changing a recipe, a quality or a facing, and laying a belt by dragging, work in builder
mode. What is left is deleting, moving, and everything that needs a printer for the source —
the rest of this file is the design that should be built to, with what is done marked.

The studio draws a blueprint from source. This is about the other direction: pointing at the
picture and having the source change. Three things make that tractable here and they are worth
saying before any of the design:

- **Every entity knows where it came from.** `PlacedEntity.trace` carries the whole path — the
  blocks that were called, the turns of the loops, and the frame the entity was placed in — and
  `PlacedEntity.loc` the statement itself. The evaluator keeps that path as it walks
  (`src/core/run.ts`, `callStack`) and the scene stamps it on everything placed.
- **The compiler is a fast pure function of the text**, re-run on a 200 ms debounce. So an edit
  does not need a provably correct inverse: guess a patch, re-run, check the entity actually
  moved where the pointer said, and offer it. Verification is a test, not a proof.
- **The whole application state is a string.** Undo is Monaco's undo — one map action grouped as
  one stack element gives the game's own "one Ctrl+Z, one placement" for free, with no
  edit history of our own to keep in step.

## The one rule

**Refuse before the click, never fudge after it.** Everything that cannot be expressed cleanly
in the language is shown as impossible or ambiguous *while the pointer is still moving*, in the
same visual language the game uses for a placement that will not fit. Silently emitting
`if (i == 3)` because somebody dragged a mouse is how a language turns into a pile of
exceptions in a week.

## Two modes

The default is what exists today: left-drag pans, hover shows a tooltip, nothing writes. Every
mechanic below lives behind **builder mode**, entered on purpose — a toggle in the toolbar and
**B**. It rebinds the primary mouse button, so it says so loudly: an accent border around the
canvas and a status strip along the bottom with the mode and the keys that matter right now.

It does not survive a reload. Coming back to a tab and finding the left button rebound is worse
than pressing one key, and the mode is one keystroke away. (One line to change if that turns out
to be wrong in practice.)

**Inspection is the exception**: selecting an entity and seeing where it came from writes
nothing and needs no exclusive hold on the mouse, so it works in both modes. A click that did
not travel more than a few pixels selects; anything longer is a pan, as now.

## The cursor is the mode

Everything follows from what the cursor is holding, which is how the game works:

| the cursor | the pointer does | where it lives |
|---|---|---|
| **empty** | hover highlights, click selects | both modes |
| **an entity** | ghost preview, click places, drag draws a run | builder |
| **a tool** | deconstruction, copied settings | later, not in this design |

## Keys

Taken from the game wherever the game has an opinion.

| key | in Factorio | here | built |
|---|---|---|---|
| **B** | — | enter and leave builder mode | ✓ |
| **R** / **Shift+R** | rotate, and back | writes the `dir` slot — or `from`, on an inserter written that way | ✓ |
| **Ctrl+Z** | undo | Monaco's undo, one stack element per action, reachable from the map | ✓ |
| **Esc** | clear the cursor | drops the selection; pressing it again leaves builder mode | ✓ |
| **Ctrl+C** | copy | the *source text* of the call that placed the selected entity | ✓ |
| **1** | quickbar | holds a belt; again or Esc puts it down | ✓ |
| **left drag** with a belt held | drag a run | appends one `belt` statement | ✓ |
| **Q** | pipette: take what you are pointing at | the same, once there is more than one thing to hold | |
| **2**–**0** | the rest of the quickbar | other entities, kept in this browser | |
| **right click / drag** | mine | not in this design — deleting is its own problem | |
| **Ctrl+Shift+C / V** | copy and paste a machine's settings | recipe, modules, quality onto another entity | |
| **middle drag, space+drag, WASD** | — | pan, once the left button is busy | |

Two the studio had already, and they win: **F** fits the view and **P** shows what the poles
reach. **Alt** is the coordinate ruler here rather than the game's alt-mode — the studio draws
recipe and module badges all the time, so there is nothing for alt-mode to reveal, and a ruler
is the better use of the key.

Selection and copying work in the ordinary view too. They read; only what writes needs the
mode.

## Inspection: where did this come from

The tooltip gains one dim line at the bottom, which is the whole of tier 0 in one sentence:

```
┌─────────────────────────────┐
│ Assembling machine 3        │
│ [12 7] 3×3 · iron-gear-wheel│
│ ─────────────────────────── │
│ line 45 · 3rd of 24         │
└─────────────────────────────┘
```

Clicking selects it, and a breadcrumb appears under the canvas — the chain of calls out to the
top of the file, every segment clickable:

```
 main.fbl:12  ›  smelter-column (n 4)  ›  for i, 3 of 24  ›  :45 assembling-machine-3
```

And the direction that turns out to matter more: **put the caret in a line of source and every
entity that line produced lights up on the map.** All twenty-four of them. It is the game's
alt-mode pointed at the code, and it costs nothing once an entity carries its trace.

## Placing and drawing — belts are built

Take a belt from the quickbar with **1**, drag, release. The drag runs along the axis it moved
furthest in first and then the other, which is the shape the game draws and the shape `via`
writes down: one corner, no diagonals, nothing to guess at.

The ghost is not an impression. It is expanded by `walkPath` — the same call the compiler places
from, moved into `src/core/geometry.ts` so there is one answer to "which tiles does this cover"
— and tiles that already hold something are marked red, because that is where `auto` will dive
under.

What the ghost does **not** do yet is run `planRoute` (`src/core/routing.ts`) live and say when
a tunnel cannot surface. `auto` sorts the tunnels out at compile time and reports its failures
to the console; showing them under the pointer, in the game's own language of a placement that
will not fit, is the next thing this should learn.

```
   ▸▸▸▸▸▸▸■□□□■▸▸▸▸▸▸▸▸▸
          ↑     ↑
        entry  exit          14 tiles · 1 tunnel
```

On release the drag becomes exactly one statement, with the corner as a `via` point:

```lisp
belt (from (3, 2), via ((6, 2)), to (6, 4), auto)
```

When the route cannot be built, `planRoute` says why in a typed failure, and that is better
material than the game has: it refuses without explaining. Colour the failing stretch and put
the reason next to it.

```
   ▸▸▸▸▸▸▸▓▓▓▓▓▓▓▓▓▓
          ╰── 9 tiles underground; an underground belt reaches 6
```

**Where the statement lands** is a question the game never has to answer, so it needs a visual
of its own. The rule should be: it goes where the caret is, and if the caret is inside a block,
the block's frame is outlined on the canvas and labelled, so the coordinate system being drawn
into is visible before the button comes up.

**What is built is the plainest version of that**: every run is appended at the end of the file,
at the top level, where a tile on screen is the tile that gets written. The panel says so while
a belt is held. Writing into the caret's block needs the frame drawn first, or the statement
lands somewhere nobody pointed at — and a belt in the wrong coordinate system is worse than a
belt at the bottom of the file.

```
  ┌╌╌╌ drawing inside smelter-column · local coordinates ╌╌┐
  ╎                                                        ╎
```

## Editing what is already there — built

Selecting an entity in builder mode gives the game's machine window, assembled from a widget
this repository already had: the icon grid with tooltips, which now lives in `src/ui/picker.ts`
because both pages open it — the calculator to choose a recipe for a node, the studio to change
one on an entity already on the map.

```
┌── Assembling machine 3 ──────────────── line 45 ─┐
│  recipe    [🔧 iron-gear-wheel        ]          │
│  quality   [• normal                  ]          │
│  facing    north                            [R]  │
│  ─────────────────────────────────────────────── │
│  one statement made 24 of these — a change here  │
│  changes all of them                             │
└──────────────────────────────────────────────────┘
```

**R** rotates, as it does in the game, and Shift+R goes back the other way. An inserter written
with `from` is rotated by its `from`, because that is the slot that was written and turning the
other one would send it the wrong way. Modules are not editable yet: a list is a different
shape of edit from a value, and the value case is worth having on its own first.

The interesting moment is the one where the edit has no single answer, because the entity came
out of a loop or a block called from several places. The game already has a colour for "this
will not work" — red. This is not that; it is amber, and it asks:

```
     this machine is 1 of 24 from smelter-column

     [ All 24 ]      change the literal in the block        ⏎
     [ This one ]    adds  if (i == 3)
     [ As a slot ]   make it a parameter, update the calls

     ↑↓ choose · ⏎ apply · Esc cancel
```

The three are not a menu of guesses: they are the three things the language can actually
express, which is why the choice can be offered honestly rather than resolved by heuristic.

**What is built today is the first of them, and the warning that goes with it.** The panel says
*one statement made 24 of these — a change here changes all of them* before anything is
touched, and the change is to the literal in the generator. Specialising one instance and
promoting a value to a parameter both need a printer for the source, which nothing else has
wanted yet.

What is *not* offered: an entity whose position or property was computed —
`at (x + i * 3, y)` — cannot be edited by dragging, because one example does not say which part
of the expression was meant. It selects and inspects like anything else, and the refusal says
which case it is:

- *recipe is whatever 'r' was, so it is set where this block is called rather than here* — the
  value came in as a parameter, and this points at the place that can actually change it.
- *at is worked out rather than written, so there is nothing here to replace* — an expression,
  and one example cannot say which part of it was meant.

## What has to be built

Roughly in the order it should happen. Effort is for one person who knows this codebase.

**~~Provenance~~ — done.** `Trace` and `TraceStep` in `src/core/scene.ts`, stamped in
`Scene.place`
from a hook the runtime installs, so a belt, a tunnel end and a balancer's splitters all carry
it without any of the seven placement sites being told to. Both loops are instrumented: the
plain `for` and the `row … for …` that layout folds in, which is the one most entities are
actually written in.

What is *not* stamped yet is per-slot origins — which argument, or which `defaults`, supplied
`recipe` or `dir`. It is the one subtle part and it lands in one place: `fillSlots`
(`run.ts`) is where that is known and currently thrown away. Property editing needs it; nothing
below tier 1 does.

**~~Selection and highlight~~ — done.** Click-versus-pan in `canvas.ts` (a press that travels
more than a few pixels is a pan, anything shorter selects), the selection ring, the breadcrumb
along the top of the canvas, and `onCaretLine` on the `Editor` interface. `src/ui/provenance.ts`
turns a trace into something to read, and is the only piece the two directions share.

**~~Spans~~ — done, for the literals.** A `name`, a `number` and a `text` carry an `end`, which
is all a value edit needs: a recipe, a facing and a count are each one token. Nothing else does,
and the absence is the point — it is how "this was computed" is said. A full set of spans on
every node is still owed if a statement ever has to be moved or removed.

**~~Per-slot origins~~ — done.** `fillSlots` records, for every slot, whether the value stood in
the call as a literal (with its span), came in under a name, was worked out, or was never
mentioned at all. That last case is what makes *adding* an argument possible rather than only
replacing one.

**~~Patching~~ — done.** `src/core/edit.ts`: `planSlotEdit` decides between replacing a span,
inserting an argument before the closing bracket, and refusing with a reason. `applyEdit` is the
splice. The studio applies it through Monaco rather than to the text, so one change on the map is
one press of Ctrl+Z — which works with the canvas focused, since the map and the editor share the
one history.

**Builder mode — half done.** The mode, its chrome and its keys are in `src/ui/builder.ts`; the
quickbar, the ghost under the cursor and the rebound pointer are not, because nothing is placed
yet. Note that selection did not need the mode: a press that travels more than a few pixels is a
pan and anything shorter selects, so the default page kept working exactly as it did.

**~~Belts~~ — the drag is done.** Holding, the ghost, the corner rule and the statement it
writes. Still owed: the live `planRoute` preview with its failure reasons, the scope outline,
and inserting where the caret is rather than at the end of the file.

**~~Property edits~~ — done**, less the module slots and the copy-paste of settings between
machines.

Dragging entities to new positions and rewriting generators from an example are deliberately
absent. They need the same machinery plus answers to harder questions, and the first version is
more useful without them than it would be delayed by them.
