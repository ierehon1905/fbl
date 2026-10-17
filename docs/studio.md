# The studio

The editor page: code on the left, blueprint on the right, no backend. What the editor knows,
what the preview draws, and the panels that read numbers off the scene.

## Opening it

Nothing is usable until everything is in. The game data, the item icons and the entity art all
load behind one gate across the whole page, listed with what each has downloaded so far, and the
studio appears when the last of them lands.

It used to let you in as soon as the dataset arrived and let the art catch up. That works, and
it means a reader who opens the page mid-download watches the blueprint change under them twice
— footprints, then icons, then sprites. Waiting is the lesser surprise.

The gate never holds the page hostage. An asset that cannot be had at all is marked and the rest
opens anyway; only the dataset is fatal, because without recipes and footprints there is nothing
to compile. And anything still going after thirty seconds gives up its claim on the gate and
finishes in the background, landing on the canvas when it arrives — so a request that never
answers costs half a minute rather than the session.

## Preview

The game's own art, drawn in the game's render order — belts and pipes on the ground, machines
above them, inserters and poles over everything — positioned by each sprite's own `shift` so
overhang lands where it does in game. Belts pick their orientation from their neighbours, so
corners get the curve sprite and undergrounds get the entry and exit structures. Machines carry
a floating recipe icon, and a badge along the bottom edge for the modules inside them: one icon
per module in slot order, each with its quality mark, because the sprite itself cannot show what
is in the slots.

There is no second view to switch to. There used to be a schematic one — flat footprints and
direction chevrons — and it was removed: the point of this preview is to look like the game, and
a toggle offering to make it look less like the game is a choice nobody needed to be given.

What survives of it is a **fallback**, not a view. An entity the atlas has no picture of is
drawn as a colour-coded footprint rather than left invisible, and so is everything if there is
no atlas at all — which the console says out loud when it happens, because a studio that quietly
looks like a diagram is a studio that looks broken.

## Which line built this

A generated blueprint cannot answer the question the eye keeps asking. Twenty-four assemblers
are one statement read twenty-four times; nothing about the picture says which reading you are
looking at, or where to go and change it.

So every entity is stamped, as it is placed, with the path it came by — the blocks that were
called, the turn of the loop it was on, and the frame it landed in. That buys two things, and
the second one is the one people keep:

- **Click an entity** and the editor jumps to the statement that placed it. Its tooltip gains a
  last line — *line 19 · 3rd of 4* — and a breadcrumb appears along the top of the canvas with
  the whole chain: `feed () › for i · 3 of 4 › :19 assembling-machine-3`. Every crumb jumps to
  its own line, so a block call is one click away from the loop inside it.
- **Put the caret in a line** and everything that line built lights up. All twenty-four at once,
  washed rather than ringed, because two dozen rings is a fence. This is the direction that
  turns "what does this statement actually do" from a guess into a look.

Both work in the ordinary view — they change nothing and need no mode.

## Builder mode

Everything that writes to the source lives behind **build** in the toolbar, or **B**. Without
it the page is what it always was: the left button pans, nothing is editable, and looking at
where an entity came from still works, because looking changes nothing.

With it, a selected entity opens a panel — its recipe, what it was built to, and which way it
faces. **R** rotates it and Shift+R goes back, as in the game. Every change is written into the
source at the exact spot the value stands, and lands on Monaco's undo stack as one step, so
Ctrl+Z takes back one action whether the keyboard belongs to the map or to the text.

What can be changed is decided by the source rather than by the panel, and the panel says which
case it is before anything is clicked:

- a value written as a literal is replaced where it stands;
- a slot the call never mentioned is added, before the bracket that closes it;
- a value handed in under a name — `recipe r` inside a block — is refused, pointing at the call
  that can actually change it;
- an entity from a loop or a block called more than once carries a warning that one statement
  made all of them, so a change here changes all of them.

It follows the game's hands rather than a menu's. **R** turns whatever is under the pointer with
nothing clicked, and **Q** is the pipette: with an empty hand it takes what you are pointing at,
with a full one it puts it down. **E** opens the build menu. While something is held, its own
sprite stands see-through on the tile under the pointer, outlined amber where it fits and red
where it does not, and a click on red is refused rather than written and complained about
afterwards.

**Right click mines**: the statement behind the entity comes out of the source, and its line
with it. What decides whether that is allowed is how many times the statement was *run* rather
than how many entities it left — one belt of thirteen tiles is one run and goes whole, while one
machine out of a loop of three is refused, because taking a single reading out of a generator
means writing a condition into it.

**1** puts a belt in the cursor, and then dragging on the map lays a run: along the axis the
drag moved furthest in first, then the other, which is one corner and no diagonals. The ghost
under the pointer is expanded by the same call the compiler places from, and marks in red the
tiles that already hold something — that is where `auto` will tunnel under. On release it
writes one statement at the end of the file, `belt (from (3, 2), via ((6, 2)), to (6, 4), auto)`,
in the coordinates you were pointing at.

**Esc** empties the cursor, then drops the selection, then leaves the mode — one layer a press.
**Ctrl+C** with something selected puts the call that placed it on the clipboard: the one thing
worth copying out of a generated blueprint is the line that generated it, and that works in
either mode.

Placing and deleting are not in yet; the design for them is [map-editing.md](map-editing.md),
which also has the keys that are still owed.

## The editor

Monaco, wired to the language rather than to a syntax file:

- **completion by type** — after `recipe ` it offers only what that machine can craft; after
  `tier ` the four belt tiers; after `entity ` every building and every block you have
  defined; at a slot position, the slots that entity actually has.
- **errors inline** — the checker's diagnostics become squiggles, with the hint in the tooltip.
- **hover** — a machine's footprint, module slots and crafting speed; a recipe's ingredients
  and time; a block's parameters.
- **argument names painted apart** — a slot name and its value sit side by side with nothing
  but a space between them, so `recipe iron-gear-wheel` would read as two words. Semantic
  tokens colour the names, at the call and at the definition both, and a block's own
  parameters light up exactly like the built-in ones because it comes off the syntax tree
  rather than a list. `src/core/labels.ts` collects the spans; the provider is in
  `src/ui/lang/providers.ts`.

Hold **Alt** over the preview and the tile under the cursor lights up with its coordinate,
which is the fastest way to get a number out of the picture and into the source.

## Power overlay

**power** in the toolbar (or <kbd>P</kbd>) washes everything the poles reach in blue and outlines
the edge of the region. Anything that draws power and sits outside it gets a lightning badge in
its corner, the way the game marks one — not a ring around its footprint, because the accent
colour means "what you are pointing at or have picked" everywhere else on this canvas, and an
outline in it around every dark machine read as a selection of all of them. When there is at
least one pole, the console also totals what is left dark.

The number that matters is the **supply area**, which is not the wire reach usually quoted:

| pole | powers | wire reaches |
| --- | --- | --- |
| `small-electric-pole` | 5×5 | 7.5 |
| `medium-electric-pole` | 7×7 | 9 |
| `big-electric-pole` | 4×4 | 32 |
| `substation` | **18×18** | 18 |

A big electric pole throws a wire 32 tiles and powers almost nothing; the one that covers
ground is the `substation`. Writing this overlay immediately found the bug in this project's
own assembler-line example: medium poles on row 7 were never going to reach the inserters on
row 1, and eight of them had been sitting dark since the example was written.

## Cost

The overlay in the corner of the preview totals the blueprint three ways. The × puts it away;
clicking the pill that is left brings it back.

| section | what it counts |
| --- | --- |
| `items` | what the schema places, modules included |
| `basic` | those, followed down to the materials they are made of |
| `raw` | those, followed all the way to what the game extracts |

"Extracts" is not the same as "has no recipe". In Space Age `iron-ore` has a recipe of its own
that grows it from bacteria — follow it and a transport belt is priced in biochambers. The
trail stops wherever something *mines* an item or *grows* it or makes it from nothing, which is
also why sulfuric acid and heavy oil turn up as raw: on some planets they are.

It also stops at anything nothing makes at all. Wood is chopped from trees and holmium ore
comes out of scrap, which this model does not follow; both are inputs, not gaps in the data,
and they are listed as such rather than flagged.

A **material** is an item that is *processed* rather than assembled — its recipe runs in a
furnace, a foundry, a chemical plant, a refinery — and that is made of nothing but raw
resources and other materials. Both halves are load-bearing: a foundry casts turbo belts too,
but out of gears and plates, so a belt is not a material. What survives is the tier you would
actually shop for. For the smelters array that turns

```
raw     lava 17.4k · crude oil 15.1k · iron ore 12.7k · heavy oil 6240 · tungsten ore 3480
basic   iron plate 10.7k · lubricant 6240 · copper plate 4728 · tungsten plate 870 · plastic 678
```

## Rates

The second panel: what the machines on screen eat and make per second, running flat out. It is
the number you size a bus against — every machine crafting without pause, so the belts feeding
it have to keep up with the answer.

A craft takes `recipe.time` seconds at speed 1, so a machine finishes
`speed × (1 + speed bonus) ÷ time` of them each second. Ingredients are drawn once per craft;
products come out multiplied by productivity, which is why speed modules move both columns and
productivity modules move only the second. Everything that changes those numbers is read off
the entity: the recipe and its `disallowedEffects`, the modules and the quality of each, the
quality of the machine, whatever the machine does for free — a foundry casts half again as
much — and the beacons, by where they stand.

Beacons are the part worth stating. A beacon reaches every machine whose footprint touches its
area — its own footprint grown by `range` on every side — and hands over `effectivity` of its
modules' effect, shared down by the crowding profile once several of them reach the same
machine. An empty beacon is left out entirely rather than counted and multiplied by nothing,
because it would otherwise dilute the share of the beacons around it.

A machine with no recipe is not a machine making nothing; it is a machine whose output nobody
has stated, and a furnace has no recipe to set at all. Those are counted apart and said under
the list rather than folded into the total as a zero.

The arithmetic lives in `src/core/rates.ts`, and the formula it uses is the same one the
calculator uses backwards — both call `throughputOf` in `src/core/calc/machine.ts`, because a
plan and the thing built from it must not disagree about the same factory.

## Keeping your own schemas

The menu behind the burger holds the examples and whatever you have saved. Type a name and press
**save** to keep the buffer under it; saving again under the same name replaces it rather than
growing a second copy, and the × beside one forgets it. The name of whatever is open comes back
after a reload, along with the buffer itself.

It is all `localStorage` in the reader's own browser — the studio has no server to send anything
to. A schema is a few kilobytes of text, the whole library is read every time the menu opens,
and a synchronous read means there is never a moment where the list is on screen but not yet
loaded, which is what IndexedDB would have bought at the price of async. Clearing site data
clears the schemas.

## Overlapping entities

When two things land on the same tile the preview draws **everything** and marks the overlaps
red, rather than showing an empty view with an error. Debugging a collision means seeing what
collided.
