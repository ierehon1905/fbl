# The language

Everything about fbl itself: what you can write, what it means, and what the checker refuses.
The two pieces that grew big enough to live on their own are **[belt routing](routing.md)**,
which is what `auto` does, and **[the blueprint format](blueprint.md)**, which is what the
program turns into.

## Shape of a program

Round brackets are the only constructor. A comma is optional between arguments, and a line
break ends a statement unless you are inside `( … )`.

## Placement

Everything you can place — a game entity, a helper, a block of your own — is called the same
way, and its arguments are **slots**:

```
<entity-or-block> ( <slot> <value>, … )
```

```
assembling-machine-3 (at (0, 2), recipe iron-gear-wheel, modules prod-3)
```

**A value's type decides its slot**, so members of the small closed vocabularies are written
bare: `north` fills `dir` because it is a direction, `blue` fills `tier`, `legendary` fills
`quality`. Coordinates default to `at`. Recipes and items are too large a namespace to guess
from — and `iron-gear-wheel` is both — so those always take their label.

**`(x, y)` is the top-left tile of the footprint**, in the current frame, not the centre.
The exporter converts to Factorio's centre-of-footprint convention, which is why a 3×3 machine
lands on `.5` coordinates and a 2×2 one does not. You never see that.

## Types

`int` `float` `bool` `text` `coord` `direction` `tier` `quality` `recipe` `item` `module`
`entity` `handle` `any`, and `T[]` for a list.

Because `()` is the only constructor, a tuple is a coordinate or a list depending on what is
expected: `(0, 2)` is a `coord`, `(speed-module-3, speed-module-3)` is a `module[]`, and a
lone value stands in for a one-element list. A module is an item, optionally paired with a
quality: `(quality-module-3, legendary)`.

```
coord origin = (4, 0)
int    n     = count (prod-3)
def prod-3   = repeat (4, (productivity-module-3, legendary))
```

## Module settings

`defaults` presets any slot left blank, for the rest of the file or for one block. It can be
narrowed to a single entity or to a family:

```
defaults (tier blue)                  ; anything with a tier slot
defaults underground (tier green)     ; just undergrounds
defaults (tier yellow) => { … }       ; only inside this block
```

Innermost wins; within a scope, an entity name beats a family, which beats a bare slot.
Only styling slots can be defaulted — `tier` `quality` `dir` `recipe` `modules` `gap`
`align`, `route` — never a position.

## Blocks

A block writes itself from `(0, 0)`; the caller decides where that origin lands, so nothing
inside ever does coordinate arithmetic against the outside world.

```
defblock cell (recipe r, module[] m = (), int lanes = 2) => { … }
```

A parameter answers to its own name **and to its type**, pluralised for arrays, so
`cell (recipe iron-gear-wheel, modules prod-3)` reaches `r` and `m` without naming them.

A block's body sees the `def`s of the file it is written in, so a module set or a spacing
named once at the top can be used inside every block without being passed down.

**Every block already has an `at` slot**, so it needs no coordinate parameter of its own to be
positioned: `cell (at (4, 0))` shifts the whole block. And since an unlabelled coordinate
always means position, `cell ((4, 0))` fills `at` and never a parameter that happens to be a
`coord` — label it if a block genuinely takes a second one.

## Records

A parameter that has to say more than one thing about each of several things wants a record: a
named bag of fields, written like a block header with no body.

```
defrecord lane (direction dir = east, item[] content = ())

defblock feed (recipe r, int n = 3, lane[] lanes = 1) => {
  for l, i in lanes => { belt (from (0, i) to (n * 4, i), content l.content) }
}
```

Fields are filled exactly the way arguments are — by label, or bare when the type says which
field it could only be — so a misspelt field reads like a misspelt slot, and everything that
knows how to fill a slot already knows how to fill a field. Read them back with `.`, and pick
one out of a list with `[i]`.

```
feed (lanes ((dir west, content (coal)), (dir east)))   ; two lanes, written out
feed (lanes (dir west))                                 ; one
feed (lanes 3)                                          ; three, all at their defaults
```

That last spelling is why a record does not need a union type beside it. **A count is that many
at their defaults**, which is what someone means by `lanes 3`, and it only holds when every
field has a default — otherwise the count would be inventing values you never gave. The body
sees a list either way and never has to ask which spelling it got.

Entries that are each a group of their own are the elements of a list; anything else is one
record written out. The difference is visible in the source rather than inferred from the
fields, so `(dir west)` is one lane and `((dir west), (dir east))` is two.

Two places a literal cannot go, because brackets there are arithmetic rather than a list: a
`def`, and a default. A default takes `()`, which means the record at its own defaults —
`defrecord frame (lane edge = ())` — and a variable takes one by holding what something else
built. A record cannot hold one of its own kind, however far around; there would be no first
one to build, and the checker says so.

A loop over a list can take a second name, which counts the passes — the row to place this one
on is the usual reason to want it:

```
for l, i in lanes => { belt (from (0, i) to (10, i), content l.content) }
```

## Buildings as parameters

An `entity` parameter holds anything placeable — a machine or another block — so one block
covers a whole family:

```
defblock smelter (entity machine, module[] mods = ()) => {
  machine (at (0, 0), modules mods)
  belt (from (0, 3) to (2, 3), tier red)
}

row (gap 1) => {
  smelter (entity electric-furnace, modules (speed-module-3, speed-module-3))
  smelter (entity steel-furnace)
}
```

The checker cannot know which machine arrives, so it validates the slot *names* against the
union of every entity's and leaves the rest to run time. A slot the real building turns out
not to have is dropped with a warning rather than failing the build — a steel furnace has no
module slots, and `modules ()` asked for nothing anyway.

## Layout and control flow

**`for` repeats; it does not position.** Eight calls to `cell ()` with no `at` land eight
cells on the same tile. Either compute the position yourself, or let a layout form measure
each pass and pack them:

```
for i in 0..4 => { medium-electric-pole (at (1 + i * 7, 7)) }   ; you compute it
row for i in 0..8 => { cell (recipe iron-gear-wheel) }          ; row measures and packs
row => { for i in 0..8 => { cell (…) } }                        ; the same, spelled out
```

Layout forms exist because a block's width is not knowable in advance — it depends on the
recipe, the modules, the belt tier. `row` and `column` evaluate a child, measure what it
emitted, then translate it into place.

**A layout only packs along its own axis.** The first item stays exactly where it was written
and each one after it starts a `gap` past the one before; nothing moves across the axis. A
machine you put above the line stays above the line, and a belt written after the row finds it
there — which is what makes `auto` usable next to a layout:

```
row (gap 2) for i in 0..4 => {
  electromagnetic-plant (at (-5, -3), recipe quality-module)   ; above the line
  bulk-inserter (at (-1, 0), west)                             ; on it
}
belt (from (24, 0) to (-12, 0), auto)                          ; tunnels under each group
```

`align` opts into moving things across the axis, measured against the items themselves so it
means the same wherever the layout sits: `start` flushes them to the leading edge, `center`
and `end` follow. Without it their own placement stands.

```
at (10, 4) => { … }                    ; shift the frame
transform (rotate-cw) => { … }         ; turn or mirror what the body built
row (gap 1) => { … }
column (gap 1, align center) => { … }
if n > 4 => { … } else => { … }
def m = measure (cell ())              ; evaluate, report the box, remove it again
```

## Turning and mirroring

`transform` builds its body the plain way round and then turns what came out.

| | |
| --- | --- |
| `flip-h` | swaps left and right |
| `flip-v` | swaps top and bottom |
| `flip-hv` | both at once, which is a half turn |
| `rotate-cw` / `rotate-ccw` | quarter turns |

```
side-buffer (at (0, 0), size 3)
transform (flip-h)    => { side-buffer (at (0, 6), size 3) }
transform (rotate-cw) => { side-buffer (at (12, 0), size 3) }
```

Everything inside sees an ordinary frame, so blocks, layout forms and `auto` need to know
nothing about it. The box keeps its top-left corner and a quarter turn swaps its width and
height, as it does in the game. Footprints move whole — a 1×2 splitter lands on the tiles it
would have covered had it been built that way round — and directions turn with them, except for
entities the game will not let you turn, which only move.

What the geometry cannot show is handedness: a splitter's priorities and a belt's lanes are
named relative to the way the thing faces, so a mirror turns every left into a right and they
are swapped to match. A rotation does not, and two mirrors cancel — only `flip-h` and `flip-v`
swap them.

One limit: a machine whose fluid connections are asymmetric — a chemical plant, an oil refinery
— is moved and turned correctly, but 2.0 stores its internal mirroring as a separate `mirror`
flag on the entity, and that flag is not written yet.

## Raising your own errors

A block can refuse the arguments it was given. `throw` stops the build with your message, and
the error lands on the **call** — the line that needs fixing — naming the block that raised it:

```
defblock bank (int size) => {
  if size < 2 => { throw "size must be at least 2" }
  for i in 0..size => { steel-chest (at (i, 0)) }
}

bank (at (0, 0), size 4)
bank (at (0, 2), size 1)      ; size must be at least 2 — thrown by 'bank' on line 2
```

A parenthesised list is joined with spaces, the way `print` reads its arguments, so the message
can name the value that broke the rule: `throw ("size must be at least 2, got", size)`.

Like every error it means nothing is placed at all — the preview goes empty rather than showing
half a blueprint.

## Labels and arithmetic

A slot is written `name value`, which leaves one place where an argument could be read two
ways: `at (0, lines - j)` might be a subtraction, or the label `lines` with the value `-j`.
Minus is the only operator that can also begin a value, so it is the only one that was ever in
doubt — and it is read as arithmetic. A labelled negative writes its own brackets:
`gap (-2)`.

## Choosing a value

`?` picks between two values, where `if` picks between two pieces of a program. It reads looser
than every operator and chains to the right, so a run of conditions needs no brackets:

```
def pos = i > 2 ? 3 : 1
def t = i < 4 ? yellow : i < 8 ? red : blue

bulk-inserter (at (i, 0), i > 1 ? left : right)
```

The slot's own type reaches both halves, which is why the members there can be written bare.

## Handles and fields

A placement evaluates to a handle: `a.width` `a.height` `a.x` `a.y` `a.left` `a.top`
`a.right` `a.bottom` `a.center` `a.size`. `right` and `bottom` are exclusive edges, so
`a.right` is the first free column beside it. A coordinate has `.x` and `.y`.

## Helpers

```
belt (from (0, 0), via ((10, 0), (10, 6)), to (2, 6))   ; a path; each tile faces the next
belt (at (0, 0), east, length 20)
underground (from (4, 9) to (11, 9))                    ; typed entry/exit pair
```

Tier names are a closed vocabulary: `yellow` `red` `blue` `green` ≡ `transport-belt` …
`turbo-transport-belt`. Full entity names work too.

## Libraries

Nothing outside the language itself is in scope until it is asked for. `import` brings a
library's blocks and helpers into the same namespace as the entities — no prefix, no aliasing —
and using one of them without the import says where it lives rather than guessing at a typo.

```
import "stdlib"

balancer (at (0, 0), 4 to 4)
side-buffer (at (7, 0), size 4)
```

There is one library so far, `stdlib`:

| | |
| --- | --- |
| `balancer` | every N→M belt balancer from 1 to 8 |
| `side-buffer` | boxes in a row, fed and drained from the side |
| `line-buffer` | inserter, box, inserter, box — a chain along one line |

`balancer` is written in the interpreter — it expands a book of ready-made blueprints, which no
amount of fbl would express better — and `side-buffer` is written in fbl, in
`src/core/modules.ts`. Both arrive with the same import; which is which is an implementation
detail. A guard inside a library reports on **your** call and names the library, since its own
line numbers mean nothing to you.

## Balancers

```
import "stdlib"

balancer (4 to 8)                            ; four lanes in, eight out
balancer (at (0, 20), 8 to 4, right, green)  ; rotated, turbo belts
```

Every N→M from 1 to 8, lifted from a community blueprint book by
`npm run extract-balancers`. The book is built from belts, undergrounds and splitters alone,
so one geometry serves every tier — including turbo, which it predates by four years — and
the whole layout rotates with `dir`. A pair the library does not have is a compile error.

Directions also answer to screen words: `up` `right` `down` `left` are `north` `east` `south`
`west`.

## Contents, filters and priorities

```
belt (from (0, 0) to (8, 0), content (iron-ore left, copper-ore right))
steel-chest (at (9, 0), content (iron-plate, copper-plate))

fast-inserter (at (0, 2), filter (copper-plate, copper-ore))
fast-inserter (at (2, 2), filter (not copper-ore))

splitter (at (4, 2), filter copper-plate, in-priority right)
splitter (at (6, 2), in-priority left, out-priority right)
```

`content` is metadata: it never reaches the blueprint. It is what the preview draws — on the
lane the item rides, along every tile of the run — and what the throughput analysis will read.
A belt has two lanes; a chest holds as many kinds as it has stacks, and shows a count past
four.

Filters do reach the blueprint. `not` sits in front of an inserter's whole list, because the
game keeps one whitelist/blacklist switch per inserter rather than one per item. A splitter
filters a single item and prefers a side each way; naming a filter without `out-priority`
sends it left, which is what the game does with the field left empty.

## Functions

`repeat` `count` `min` `max` `abs` `floor` `ceil` `round` `print`, plus the ones that read the
game data: `ingredients (recipe)`, `craft-time (recipe)`, `module-slots (entity)`,
`width (entity)`, `height (entity)`.

`recipe` and `entity` are separate vocabularies that happen to share names — `steel-chest` is
both something you craft and something you place — so `to-entity` and `to-recipe` carry a name
from one to the other, and say so plainly when it has no twin:

```
defblock stash (recipe r) => {
  def entity box = to-entity (r)
  box (at (0, 0))
}
```

`width` and `height` are the footprint before it is turned. A block has no size of its own — it
is whatever it builds — so `measure (block ())` answers that instead.

## What the checker catches

Parse → **check** → run. The checker is a gate: if it reports an error nothing is placed, so
a program never half-builds a blueprint on the way to failing.

Errors, before anything runs:

- a slot the entity does not have, listing the ones it does
- a value of the wrong type for a slot, or for a declared local
- a name that is not a variable, entity, block or vocabulary member — with a "did you mean"
  drawn from the real entity list, tolerant of transposed letters
- a recipe the machine cannot craft (`assembling-machine-3` making `iron-plate`), naming
  where it *is* made
- more modules than the machine has slots
- a field a handle does not have
- arithmetic on something that is not a number, a `for` over something that is not a list

Warnings, which still produce a blueprint:

- an underground belt that overruns its tier's reach
- a `defaults` that the target entity cannot use
- overlapping footprints, highlighted in red on the canvas

Every diagnostic carries a line and column, and the location is clickable in the console.
