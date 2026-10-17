import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ProtoRegistry,
  applyEdit,
  callText,
  compile,
  decodeBlueprint,
  exportBlueprint,
  parse,
  planRemove,
  planSlotEdit,
  refused,
  sharedWith,
  walkPath,
} from '../dist-node/core.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const SPA = { id: 'spa', label: 'Space Age 2.0', directionScale: 2, moduleFormat: 'items-array', supportsQuality: true }
const V11 = { id: '1.1', label: 'Factorio 1.1', directionScale: 1, moduleFormat: 'items-map', supportsQuality: false }

async function registryFor(id, profile) {
  const data = JSON.parse(await readFile(join(ROOT, 'public/data', id, 'data.json'), 'utf8'))
  return new ProtoRegistry(data, profile)
}

const registry = await registryFor('spa', SPA)

/** Compiles and asserts the checker was happy. */
function run(source, reg = registry) {
  const result = compile(source, reg)
  const errors = result.diagnostics.filter((d) => d.severity === 'error')
  assert.deepEqual(
    errors.map((e) => `${e.loc?.line}:${e.loc?.col} ${e.message}`),
    [],
    'expected no errors',
  )
  return result
}

/** Compiles and returns only the errors. */
function errorsIn(source, reg = registry) {
  return compile(source, reg).diagnostics.filter((d) => d.severity === 'error')
}

/** A belt that cannot be routed is a warning, not an error: it is laid flat and shown. */
function warningsIn(source, reg = registry) {
  return compile(source, reg).diagnostics.filter((d) => d.severity === 'warning')
}

/** Compiles without asserting anything, for tests that inspect the failure. */
function compileFor(source, reg = registry) {
  return compile(source, reg)
}

const find = (scene, name) => scene.entities.filter((e) => e.proto.name === name)

// ── Syntax ────────────────────────────────────────────────────────────────────

test('commas are optional between arguments', () => {
  const withCommas = run('assembling-machine-3 (at (1, 0), recipe iron-gear-wheel)').scene
  const without = run('assembling-machine-3 (at (1 0) recipe iron-gear-wheel)').scene
  assert.deepEqual(
    [withCommas.entities[0].x, withCommas.entities[0].y],
    [without.entities[0].x, without.entities[0].y],
  )
})

test('a name followed by an operator is arithmetic, not a label', () => {
  // `lines - j` used to read as the label `lines` with the value `-j`, which silently threw
  // away the left-hand side and put the entity somewhere else entirely.
  const at = (source) => run(source).scene.entities.map((e) => [e.x, e.y])
  const expected = [
    [0, 4],
    [0, 3],
    [0, 2],
  ]
  assert.deepEqual(at('def lines = 4\nfor j in 0..3 => { steel-chest (at (0, lines - j)) }'), expected)
  assert.deepEqual(at('def lines = 4\nfor j in 0..3 => { steel-chest (at (0, (lines - j))) }'), expected)

  // The other operators never had the problem, and labels still read as labels.
  assert.deepEqual(at('def n = 2\nsteel-chest (at (n * 3, n + 1))'), [[6, 3]])
  assert.deepEqual(at('def n = 5\nbelt (at (0, 0), east, length n - 2, blue)').length, 3)
})

test('a comma separates two bare values from a label and its value', () => {
  // `(north, blue)` is two values; `(tier blue)` is one labelled value.
  const { scene } = run('belt (from (0, 0), to (3, 0), east, blue)')
  assert.equal(scene.entities.length, 4)
  assert.equal(scene.entities[0].proto.name, 'express-transport-belt')
})

test('a line break ends a statement, but not inside parentheses', () => {
  const { scene } = run(`
    assembling-machine-3 (
      at (0, 0),
      recipe iron-gear-wheel
    )
    steel-chest (at (4, 0))
  `)
  assert.equal(scene.entities.length, 2)
})

test('parentheses group a single value and build a tuple otherwise', () => {
  const module = parse('def a = (1 + 2) * 3\ndef b = (1, 2)')
  assert.equal(module.statements[0].value.kind, 'binary')
  assert.equal(module.statements[1].value.kind, 'tuple')
})

// ── Types and the checker ─────────────────────────────────────────────────────

test('a wrong slot type is an error, and nothing is placed', () => {
  const result = compile('assembling-machine-3 (at (0, 0), recipe north)', registry)
  assert.equal(result.ran, false)
  assert.equal(result.scene.entities.length, 0)
  assert.match(result.diagnostics[0].message, /is not a recipe/)
})

test('a misspelled entity is caught with a suggestion', () => {
  const [error] = errorsIn('assembling-machine-4 (at (0, 0))')
  assert.match(error.message, /unknown name 'assembling-machine-4'/)
  assert.match(error.hint, /assembling-machine-\d/)
  assert.equal(error.loc.line, 1)
})

test('an unknown slot names the ones that exist', () => {
  const [error] = errorsIn('steel-chest (at (0, 0), recipe iron-gear-wheel)')
  assert.match(error.message, /has no slot 'recipe'/)
  assert.match(error.hint, /it takes at/)
})

test('a recipe the machine cannot craft fails to compile', () => {
  const [error] = errorsIn('assembling-machine-3 (at (0, 0), recipe iron-plate)')
  assert.match(error.message, /cannot craft iron-plate/)
  assert.match(error.hint, /made in/)
})

test('too many modules fails to compile', () => {
  const [error] = errorsIn(`
    assembling-machine-3 (at (0, 0), modules
      (speed-module-3, speed-module-3, speed-module-3, speed-module-3, speed-module-3))
  `)
  assert.match(error.message, /4 module slot\(s\), 5 given/)
})

test('a declared type is enforced', () => {
  const [error] = errorsIn('coord c = 5')
  assert.match(error.message, /declared coord but the value is int/)
})

test('arithmetic on a non-number is caught', () => {
  const [error] = errorsIn('def x = north * 2')
  assert.match(error.message, /needs numbers, got direction/)
})

test('a handle field typo is caught', () => {
  const [error] = errorsIn(`
    def a = steel-chest (at (0, 0))
    def w = a.widht
  `)
  assert.match(error.message, /no field '.widht'/)
  assert.match(error.hint, /\.width/)
})

// ── Bare values ───────────────────────────────────────────────────────────────

test('a bare value picks its slot from its type', () => {
  const { scene } = run('bulk-inserter (at (0, 0), north)\nbelt (from (2, 0), to (4, 0), green)')
  assert.equal(scene.entities[0].dir, 0, 'north filled dir')
  assert.equal(scene.entities[1].proto.name, 'turbo-transport-belt', 'green filled tier')
})

test('a bare coordinate fills at, which belt accepts as a name for its start', () => {
  const { scene } = run('belt ((0, 0), to (3, 0), red)')
  assert.equal(scene.entities.length, 4)
  assert.deepEqual([scene.entities[0].x, scene.entities[0].y], [0, 0])
})

// ── Defaults ──────────────────────────────────────────────────────────────────

test('module defaults fill slots that were left blank', () => {
  const { scene } = run(`
    defaults (tier blue)
    belt (from (0, 0) to (2, 0))
  `)
  assert.equal(scene.entities[0].proto.name, 'express-transport-belt')
})

test('an explicit value beats the default', () => {
  const { scene } = run(`
    defaults (tier blue)
    belt (from (0, 0) to (2, 0), tier yellow)
  `)
  assert.equal(scene.entities[0].proto.name, 'transport-belt')
})

test('defaults can be narrowed to one entity or family', () => {
  const { scene } = run(`
    defaults (tier blue)
    defaults underground (tier green)
    belt        (from (0, 0) to (2, 0))
    underground (from (3, 0) to (7, 0))
  `)
  assert.equal(find(scene, 'express-transport-belt').length, 3)
  assert.equal(find(scene, 'turbo-underground-belt').length, 2)
})

test('a scoped defaults block only applies inside it', () => {
  const { scene } = run(`
    defaults (tier yellow)
    defaults (tier green) => {
      belt (from (0, 0) to (1, 0))
    }
    belt (from (0, 2) to (1, 2))
  `)
  assert.equal(find(scene, 'turbo-transport-belt').length, 2)
  assert.equal(find(scene, 'transport-belt').length, 2)
})

test('a default that the entity cannot use is flagged', () => {
  const { diagnostics } = compile('defaults steel-chest (tier blue)', registry)
  assert.match(diagnostics[0].message, /has no 'tier' slot/)
})

// ── Blocks ────────────────────────────────────────────────────────────────────

test('a block gets its own coordinate frame', () => {
  const { scene } = run(`
    defblock cell (recipe r) => {
      assembling-machine-3 (at (0, 0), recipe r)
      bulk-inserter (at (0, 3), south)
    }
    cell (at (10, 20), recipe iron-gear-wheel)
  `)
  assert.deepEqual([scene.entities[0].x, scene.entities[0].y], [10, 20])
  assert.deepEqual([scene.entities[1].x, scene.entities[1].y], [10, 23])
})

test('a parameter answers to its name and to its type', () => {
  const byType = run(`
    defblock cell (recipe r) => { assembling-machine-3 (at (0, 0), recipe r) }
    cell (recipe iron-gear-wheel)
  `).scene
  const byName = run(`
    defblock cell (recipe r) => { assembling-machine-3 (at (0, 0), recipe r) }
    cell (r iron-gear-wheel)
  `).scene
  assert.equal(byType.entities[0].recipe, 'iron-gear-wheel')
  assert.equal(byName.entities[0].recipe, 'iron-gear-wheel')
})

test('an array parameter answers to the plural of its type', () => {
  const { scene } = run(`
    defblock cell (module[] m = ()) => { assembling-machine-3 (at (0, 0), modules m) }
    cell (modules (speed-module-3, speed-module-3))
  `)
  assert.equal(scene.entities[0].modules.length, 2)
})

test('a missing required argument is an error', () => {
  const [error] = errorsIn(`
    defblock cell (recipe r) => { assembling-machine-3 (at (0, 0), recipe r) }
    cell (at (0, 0))
  `)
  assert.match(error.message, /needs r/)
})

test('a default parameter value is used when the slot is blank', () => {
  const { scene } = run(`
    defblock cell (tier t = green) => { belt (from (0, 0) to (1, 0), tier t) }
    cell ()
  `)
  assert.equal(scene.entities[0].proto.name, 'turbo-transport-belt')
})

// ── Layout ────────────────────────────────────────────────────────────────────

test('row packs children and expands a nested for', () => {
  const { scene } = run(`
    defblock cell () => { assembling-machine-3 (at (0, 0)) }
    row (gap 1) => {
      for i in 0..3 => { cell () }
    }
  `)
  assert.deepEqual(find(scene, 'assembling-machine-3').map((e) => e.x), [0, 4, 8])
})

test('at shifts the frame, and nests', () => {
  const { scene } = run('at (5, 5) => {\n steel-chest (at (1, 1))\n at (10, 0) => { steel-chest (at (0, 0)) }\n}')
  assert.deepEqual(scene.entities.map((e) => [e.x, e.y]), [[6, 6], [15, 5]])
})

test('measure reports a size without leaving anything behind', () => {
  const { scene, output } = run(`
    defblock cell () => {
      assembling-machine-3 (at (0, 0))
      belt (from (0, 3) to (2, 3), tier red)
    }
    def m = measure (cell ())
    print ("size ", m.width, "x", m.height)
  `)
  assert.equal(scene.entities.length, 0)
  assert.equal(output[0], 'size  3 x 4')
})

// ── Placement semantics ───────────────────────────────────────────────────────

test('an inserter drops toward dir and picks up from `from`', () => {
  // The vanilla prototype has pickup_position {0, 1} (south) and insert_position
  // {0, -1.2} (north) while facing north, so direction names the DROP tile.
  const { scene } = run('bulk-inserter (at (0, 0), north)\nbulk-inserter (at (2, 0), from south)')
  assert.equal(scene.entities[0].dir, 0)
  assert.equal(scene.entities[1].dir, 0)
})

test('a 3x3 machine exports at the centre of its footprint', () => {
  const { scene } = run('assembling-machine-3 (at (1, 0), recipe iron-gear-wheel)')
  const { json } = exportBlueprint(scene, registry)
  assert.deepEqual(json.blueprint.entities[0].position, { x: 2.5, y: 1.5 })
})

test('a splitter facing east swaps its footprint and uses the 16-point scale', () => {
  const { scene } = run('splitter (at (0, 0), east)')
  assert.deepEqual([scene.entities[0].w, scene.entities[0].h], [1, 2])
  const { json } = exportBlueprint(scene, registry)
  assert.equal(json.blueprint.entities[0].direction, 4)
})

test('1.1 halves directions and writes modules as a count map', async () => {
  const legacy = await registryFor('1.1', V11)
  const { scene } = run(
    'assembling-machine-3 (at (0, 0), east, modules (speed-module-3, speed-module-3))',
    legacy,
  )
  const [entity] = exportBlueprint(scene, legacy).json.blueprint.entities
  assert.equal(entity.direction, 2)
  assert.deepEqual(entity.items, { 'speed-module-3': 2 })
})

test('2.0 modules become insert plans with inventory and slot', () => {
  const { scene } = run(`
    assembling-machine-3 (at (0, 0), recipe iron-gear-wheel,
      modules ((quality-module-3, legendary), (quality-module-3, legendary), speed-module-3))
  `)
  const items = exportBlueprint(scene, registry).json.blueprint.entities[0].items
  assert.deepEqual(items[0].id, { name: 'quality-module-3', quality: 'legendary' })
  assert.deepEqual(items[0].items.in_inventory, [
    { inventory: 4, stack: 0, count: 1 },
    { inventory: 4, stack: 1, count: 1 },
  ])
  assert.deepEqual(items[1].id, { name: 'speed-module-3' })
})

test('belts follow a path and each tile faces the next', () => {
  const { scene } = run('belt (from (0, 0), via (4, 0), to (4, 3), tier red)')
  const belts = find(scene, 'fast-transport-belt')
  assert.equal(belts.length, 8)
  assert.equal(belts[0].dir, 4)
  assert.equal(belts.at(-1).dir, 8)
})

test('a diagonal belt leg is rejected with a hint', () => {
  const [error] = errorsIn('belt (from (0, 0) to (3, 3))')
  assert.match(error.message, /diagonal/)
  assert.match(error.hint, /via corner/)
})

test('both ends of an underground pair face the way items flow', () => {
  // Factorio does not turn the exit around: `direction` is the flow, and `type` is what
  // tells the two ends apart. Draftsman models them as independent fields, and the hood
  // sprite is indexed by direction — an exit facing west would show westward chevrons on
  // an eastward belt.
  const { scene } = run('underground (from (0, 0) to (5, 0), red)')
  const [entry, exit] = exportBlueprint(scene, registry).json.blueprint.entities
  assert.equal(entry.direction, 4, 'east')
  assert.equal(exit.direction, 4, 'east, not west')
  assert.equal(entry.type, 'input')
  assert.equal(exit.type, 'output')
})

test('an underground pair is typed and range-checked', () => {
  const { scene, diagnostics } = run('underground (from (0, 0) to (9, 0), tier yellow)')
  assert.deepEqual(scene.entities.map((e) => e.undergroundType), ['input', 'output'])
  assert.match(diagnostics[0].message, /spans 8 tiles but reaches 4/)
})

test('overlapping entities are reported', () => {
  const { scene } = run('assembling-machine-3 (at (0, 0))\nassembling-machine-3 (at (2, 2))')
  const clashes = scene.findCollisions()
  assert.equal(clashes.length, 1)
  assert.deepEqual([clashes[0].x, clashes[0].y], [2, 2])
})

test('blueprint strings round-trip', () => {
  const { scene } = run(`
    defaults (tier green)
    defblock cell (recipe r) => {
      assembling-machine-3 (at (1, 0), recipe r, modules repeat (4, productivity-module-3))
      belt (from (0, 0) to (0, 2))
    }
    row (gap 1) => {
      cell (recipe iron-gear-wheel)
      cell (recipe copper-cable)
    }
  `)
  const { json, text } = exportBlueprint(scene, registry, { label: 'round trip' })
  assert.equal(text[0], '0')
  assert.deepEqual(decodeBlueprint(text), json)
  assert.equal(json.blueprint.entities.length, scene.entities.length)
})

// ── row for ───────────────────────────────────────────────────────────────────

test('row for folds the loop into the layout', () => {
  const nested = run(`
    defblock cell () => { assembling-machine-3 (at (0, 0)) }
    row (gap 1) => { for i in 0..3 => { cell () } }
  `).scene
  const folded = run(`
    defblock cell () => { assembling-machine-3 (at (0, 0)) }
    row (gap 1) for i in 0..3 => { cell () }
  `).scene
  assert.deepEqual(folded.entities.map((e) => e.x), [0, 4, 8])
  assert.deepEqual(folded.entities.map((e) => e.x), nested.entities.map((e) => e.x))
})

test('the loop variable is visible inside row for', () => {
  const { scene } = run(`
    column for i in 0..3 => { belt (at (0, 0), east, length 1 + i) }
  `)
  assert.deepEqual(scene.entities.map((e) => e.y), [0, 1, 1, 2, 2, 2])
})

test('a bare for places everything at the same spot, and the overlap is reported', () => {
  const { scene } = run(`
    defblock cell () => { steel-chest (at (0, 0)) }
    for i in 0..3 => { cell () }
  `)
  assert.deepEqual(scene.entities.map((e) => [e.x, e.y]), [[0, 0], [0, 0], [0, 0]])
  assert.equal(scene.findCollisions().length, 2, 'this is what row is for')
})

// ── entity parameters ─────────────────────────────────────────────────────────

test('a building can be passed in as a parameter', () => {
  const { scene } = run(`
    defblock pad (entity machine, recipe r) => {
      machine (at (0, 0), recipe r)
      bulk-inserter (at (0, 3), north)
    }
    pad (at (0, 0), entity assembling-machine-3, recipe iron-gear-wheel)
    pad (at (5, 0), entity assembling-machine-2, recipe copper-cable)
  `)
  assert.deepEqual(
    scene.entities.filter((e) => e.recipe).map((e) => [e.proto.name, e.recipe]),
    [
      ['assembling-machine-3', 'iron-gear-wheel'],
      ['assembling-machine-2', 'copper-cable'],
    ],
  )
})

test('an entity parameter accepts a block too', () => {
  const { scene } = run(`
    defblock inner () => { steel-chest (at (0, 0)) }
    defblock outer (entity e) => { e (at (2, 2)) }
    outer (entity inner)
  `)
  assert.deepEqual([scene.entities[0].x, scene.entities[0].y], [2, 2])
})

test('a name that is not placeable is rejected where an entity is expected', () => {
  const [error] = errorsIn(`
    defblock pad (entity machine) => { machine (at (0, 0)) }
    pad (entity iron-plate)
  `)
  assert.match(error.message, /'iron-plate' is not an entity/)
})

test('an indirect placement still catches a slot typo', () => {
  const [error] = errorsIn(`
    defblock pad (entity machine) => { machine (at (0, 0), recipy iron-gear-wheel) }
    pad (entity assembling-machine-3)
  `)
  assert.match(error.message, /has no slot 'recipy'/)
})

test('an indirect placement that the real entity cannot support warns at run time', () => {
  const { diagnostics } = run(`
    defblock pad (entity machine) => { machine (at (0, 0), recipe iron-plate) }
    pad (entity assembling-machine-3)
  `)
  assert.match(diagnostics[0].message, /cannot craft iron-plate/)
})

test('a slot the real building lacks is dropped with a warning, not a failure', () => {
  const { scene, diagnostics } = run(`
    defblock pad (entity machine) => { machine (at (0, 0), modules (speed-module-3)) }
    pad (entity steel-furnace)
  `)
  assert.equal(scene.entities.length, 1, 'the blueprint still builds')
  assert.match(diagnostics[0].message, /has no 'modules' slot/)
})

test('an empty list for a missing slot is silent', () => {
  const { scene, diagnostics } = run(`
    defblock pad (entity machine, module[] mods = ()) => { machine (at (0, 0), modules mods) }
    pad (entity steel-furnace)
  `)
  assert.equal(scene.entities.length, 1)
  assert.deepEqual(diagnostics, [], 'nothing was actually requested')
})

test('a beacon takes modules even though the dataset has no machine record for it', () => {
  // FactorioLab is a ratio calculator and a beacon crafts nothing, so its slot count comes
  // from src/data/entity-geometry.ts instead.
  const { scene } = run('beacon (at (0, 0), modules ((speed-module-3, legendary), speed-module-3))')
  assert.equal(scene.entities[0].modules.length, 2)
  const items = exportBlueprint(scene, registry).json.blueprint.entities[0].items
  assert.deepEqual(items[0].items.in_inventory, [{ inventory: 1, stack: 0, count: 1 }], 'beacon inventory index')
})

test('a machine size from the dataset wins over the hand-written fallback', () => {
  // biolab is 5×5 in game; the fallback table used to claim 4×4.
  const { scene } = run('biolab (at (0, 0))')
  assert.deepEqual([scene.entities[0].w, scene.entities[0].h], [5, 5])
})

// ── Reading the game data ─────────────────────────────────────────────────────

test('width and height report the footprint before it is turned', () => {
  const { output } = run(`
    print (width (assembling-machine-3), height (assembling-machine-3))
    print (width (splitter), height (splitter))
    print (width (boiler), height (boiler))
  `)
  assert.deepEqual(output, ['3 3', '2 1', '3 2'])

  // They compose where a position is wanted, which is the point of having them.
  const { scene } = run(`
    defaults (tier blue)
    for i in 0..3 => { steel-chest (at (i * width (assembling-machine-3), 0)) }
  `)
  assert.deepEqual(scene.entities.map((e) => e.x), [0, 3, 6])

  // A block is whatever it builds, so it has no size of its own to give.
  const [error] = errorsIn('defblock pair () => { steel-chest (at (0, 0)) }\nprint (width (pair))')
  assert.match(error.message, /has no size of its own/)
  assert.match(error.hint, /measure/)
})

test('to-entity and to-recipe carry a name between the two vocabularies', () => {
  const { scene } = run(`
    defblock stash (recipe r) => {
      def entity box = to-entity (r)
      box (at (0, 0))
    }
    stash (at (0, 0), r steel-chest)
    stash (at (2, 0), r iron-chest)
  `)
  assert.deepEqual(scene.entities.map((e) => e.proto.name), ['steel-chest', 'iron-chest'])

  assert.deepEqual(run('print (to-recipe (steel-chest))').output, ['steel-chest'])
  assert.deepEqual(run('print (to-recipe (to-entity (steel-chest)))').output, ['steel-chest'])

  // A recipe with no building of the same name has nowhere to go.
  const [error] = errorsIn('print (to-entity (concrete))')
  assert.match(error.message, /nothing called 'concrete' to place/)
})

test('a function argument that is itself a call is read as one', () => {
  // `count (…)` inside `print (…)` is a nested call, not a label with a value — and the same
  // one level further down, inside a coordinate.
  assert.deepEqual(run('print (count (repeat (3, 1)))').output, ['3'])
  const { scene } = run('steel-chest (at (width (assembling-machine-3), 0))')
  assert.deepEqual([scene.entities[0].x, scene.entities[0].y], [3, 0])

  // The bracket slots that are not calls still read as themselves.
  const belt = run('belt (from (0, 0) to (3, 0), blue, content (iron-ore left, coal right))').scene
  assert.deepEqual(belt.entities[0].content, [
    { item: 'iron-ore', side: 'left' },
    { item: 'coal', side: 'right' },
  ])
})

// ── Choosing a value ──────────────────────────────────────────────────────────

test('a choice picks between two values', () => {
  const { output } = run(`
    for i in 0..5 => {
      def pos = i > 2 ? 3 : 1
      print (pos)
    }
  `)
  assert.deepEqual(output, ['1', '1', '1', '3', '3'])
})

test('a choice chains to the right and reads looser than the operators', () => {
  const { output } = run(`
    for i in 0..4 => { print (i < 1 ? "low" : i < 3 ? "mid" : "high") }
    print (1 + 1 == 2 ? "yes" : "no")
  `)
  assert.deepEqual(output, ['low', 'mid', 'mid', 'high', 'yes'])
})

test('the slot type reaches both halves, so members stay bare', () => {
  const { scene } = run(`
    defaults (tier blue)
    for i in 0..3 => { bulk-inserter (at (i, 0), i > 1 ? left : right) }
  `)
  assert.deepEqual(
    scene.entities.map((e) => directionName(e.dir)),
    ['east', 'east', 'west'],
  )

  // The same reach makes a declared type enough for an entity or a recipe.
  const boxes = run(`
    for i in 0..3 => {
      def entity box = i > 1 ? steel-chest : wooden-chest
      box (at (i, 0))
    }
  `).scene
  assert.deepEqual(
    boxes.entities.map((e) => e.proto.name),
    ['wooden-chest', 'wooden-chest', 'steel-chest'],
  )
})

test('a choice needs a condition and both halves', () => {
  assert.match(errorsIn('def x = 3 ? 1 : 2')[0].message, /needs a condition, got int/)
  assert.match(errorsIn('def x = true ? 1')[0].message, /expected ':'/)
})

// ── Libraries ─────────────────────────────────────────────────────────────────

test('a library brings its blocks and helpers in, and nothing before that', () => {
  // `balancer` is written in the interpreter, `side-buffer` in fbl; both arrive together.
  for (const source of ['balancer (4 to 4)', 'side-buffer (at (0, 0), size 3)']) {
    const [error] = errorsIn(source)
    assert.match(error.message, /unknown name/, source)
    assert.match(error.hint, /it comes from stdlib/, source)
  }

  const { scene } = run(`
    import "stdlib"
    balancer (at (0, 0), 4 to 4)
    side-buffer (at (7, 0), size 3)
  `)
  assert.ok(scene.entities.length > 20)
  assert.equal(scene.findCollisions().length, 0)
})

test('import takes a quoted name, and says which libraries there are', () => {
  assert.match(errorsIn('import "stdlibb"')[0].message, /no library called 'stdlibb'/)
  assert.match(errorsIn('import "stdlibb"')[0].hint, /"stdlib"/)
  assert.match(errorsIn('import stdlib')[0].message, /in quotes/)

  // A lone parenthesised value is grouping, so both spellings read the same.
  assert.equal(run('import ("stdlib")\nbalancer (4 to 4)').scene.findCollisions().length, 0)

  // Importing twice is not an error and does not define anything twice.
  const once = run('import "stdlib"\nside-buffer (at (0, 0), size 2)').scene
  const twice = run('import "stdlib"\nimport "stdlib"\nside-buffer (at (0, 0), size 2)').scene
  assert.equal(twice.entities.length, once.entities.length)
})

test("a library's own guard names the library, not one of its line numbers", () => {
  const [error] = errorsIn(`
    import "stdlib"
    side-buffer (at (0, 0), size 1)
  `)
  assert.equal(error.message, 'size must be at least 2')
  assert.equal(error.loc.line, 3, 'the error goes on the call, in the reader\'s own file')
  assert.match(error.hint, /thrown by 'side-buffer' from stdlib/)
})

const stdlibWidth = (source) => {
  const { scene } = run(`import "stdlib"\n${source}`)
  return [scene.bbox(0, scene.length).w, scene.findCollisions().length]
}

test('side-buffer spaces itself by the box it was given', () => {
  // A chest is 1 wide, so four of them with an inserter between each is 7.
  assert.deepEqual(stdlibWidth('side-buffer (at (0, 0), size 4)'), [7, 0])
  // A tank is 3 wide, so three of them come to 11.
  assert.deepEqual(stdlibWidth('side-buffer (at (0, 0), box storage-tank, size 3)'), [11, 0])
})

test('line-buffer alternates inserter and box, and ends on an inserter', () => {
  const { scene } = run('import "stdlib"\nline-buffer (at (0, 0), size 3)')
  assert.deepEqual(
    scene.entities.map((e) => [e.proto.name, e.x]),
    [
      ['bulk-inserter', 0],
      ['steel-chest', 1],
      ['bulk-inserter', 2],
      ['steel-chest', 3],
      ['bulk-inserter', 4],
      ['steel-chest', 5],
      ['bulk-inserter', 6],
    ],
  )
  assert.equal(scene.findCollisions().length, 0)

  // The trailing inserter follows the box's own width, not a fixed stride of two.
  assert.deepEqual(stdlibWidth('line-buffer (at (0, 0), box storage-tank, size 3)'), [13, 0])
  assert.match(errorsIn('import "stdlib"\nline-buffer (at (0, 0), size 0)')[0].message, /at least 1/)
})

test('the library examples build clean', () => {
  for (const file of ['stdlib.fbl', 'helpers.fbl']) {
    const source = readFileSync(join(ROOT, 'examples', file), 'utf8')
    const { scene } = run(source)
    assert.equal(scene.findCollisions().length, 0, file)
    assert.ok(scene.entities.length > 0, file)
  }
})

// ── transform ─────────────────────────────────────────────────────────────────

import { directionName } from '../dist-node/core.mjs'

const shape = (scene) =>
  scene.entities.map((e) => [e.proto.name, e.x, e.y, directionName(e.dir)])

test('a mirror moves positions and turns the directions with them', () => {
  const body = `
    bulk-inserter (at (0, 0), south)
    steel-chest (at (0, 1))
    bulk-inserter (at (1, 1), east)
    steel-chest (at (2, 1))
  `
  assert.deepEqual(shape(run(body).scene), [
    ['bulk-inserter', 0, 0, 'south'],
    ['steel-chest', 0, 1, 'north'],
    ['bulk-inserter', 1, 1, 'east'],
    ['steel-chest', 2, 1, 'north'],
  ])

  assert.deepEqual(shape(run(`transform (flip-h) => {${body}}`).scene), [
    ['bulk-inserter', 2, 0, 'south'],
    ['steel-chest', 2, 1, 'north'],
    ['bulk-inserter', 1, 1, 'west'],
    ['steel-chest', 0, 1, 'north'],
  ])

  // A chest cannot be turned, so it keeps facing north wherever it lands. Turning it would
  // put a direction on an entity the game does not accept one for.
  assert.deepEqual(shape(run(`transform (flip-v) => {${body}}`).scene), [
    ['bulk-inserter', 0, 1, 'north'],
    ['steel-chest', 0, 0, 'north'],
    ['bulk-inserter', 1, 0, 'east'],
    ['steel-chest', 2, 0, 'north'],
  ])

  // Both axes is a half turn, so every direction is its opposite.
  assert.deepEqual(shape(run(`transform (flip-hv) => {${body}}`).scene), [
    ['bulk-inserter', 2, 1, 'north'],
    ['steel-chest', 2, 0, 'north'],
    ['bulk-inserter', 1, 0, 'west'],
    ['steel-chest', 0, 0, 'north'],
  ])
})

test('a footprint reflects whole, so a wide entity lands where it would have been built', () => {
  // The splitter is 1×2 and the machine is 3×3, so the box is 8×3.
  const { scene } = run(`
    transform (flip-h) => {
      express-splitter (at (0, 0), east)
      assembling-machine-3 (at (5, 0), recipe iron-gear-wheel)
    }
  `)
  assert.deepEqual(shape(scene), [
    ['express-splitter', 7, 0, 'west'],
    ['assembling-machine-3', 0, 0, 'north'],
  ])
  assert.equal(scene.findCollisions().length, 0)
})

test('one mirror swaps handedness, two put it back', () => {
  const body = `
    express-splitter (at (0, 0), east, in-priority right, out-priority left)
    belt (from (0, 3) to (3, 3), blue, content (iron-ore left, coal right))
  `
  const handed = (apply) => {
    const { scene } = run(`defaults (tier blue)\n${apply ? `transform (${apply}) => {${body}}` : body}`)
    const splitter = scene.entities.find((e) => e.proto.kind === 'splitter')
    const belt = scene.entities.find((e) => e.proto.kind === 'belt')
    return [splitter.inPriority, splitter.outPriority, ...belt.content.map((c) => c.side)]
  }

  assert.deepEqual(handed(null), ['right', 'left', 'left', 'right'])
  assert.deepEqual(handed('flip-h'), ['left', 'right', 'right', 'left'])
  assert.deepEqual(handed('flip-v'), ['left', 'right', 'right', 'left'])
  assert.deepEqual(handed('flip-hv'), ['right', 'left', 'left', 'right'], 'mirrored twice is unmirrored')
  // A turn is not a mirror: left stays left, because the whole thing turned with it.
  assert.deepEqual(handed('rotate-cw'), ['right', 'left', 'left', 'right'])
  assert.deepEqual(handed('rotate-ccw'), ['right', 'left', 'left', 'right'])
})

test('a quarter turn swaps the box, and every footprint inside it', () => {
  const body = `
    express-splitter (at (0, 0), east)
    bulk-inserter (at (4, 0), east)
    assembling-machine-3 (at (5, 0), recipe iron-gear-wheel)
  `
  const box = (source) => {
    const { scene } = run(`defaults (tier blue)\n${source}`)
    const rect = scene.bbox(0, scene.length)
    return { rect: [rect.w, rect.h], shape: shape(scene), collisions: scene.findCollisions().length }
  }

  assert.deepEqual(box(body).rect, [8, 3])

  const cw = box(`transform (rotate-cw) => {${body}}`)
  assert.deepEqual(cw.rect, [3, 8], 'the box turns with its contents')
  assert.deepEqual(cw.shape, [
    // 1×2 facing east becomes 2×1 facing south, at the top where the left edge went.
    ['express-splitter', 1, 0, 'south'],
    ['bulk-inserter', 2, 4, 'south'],
    ['assembling-machine-3', 0, 5, 'east'],
  ])
  assert.equal(cw.collisions, 0)

  const ccw = box(`transform (rotate-ccw) => {${body}}`)
  assert.deepEqual(ccw.rect, [3, 8])
  assert.deepEqual(ccw.shape, [
    ['express-splitter', 0, 7, 'north'],
    ['bulk-inserter', 0, 3, 'north'],
    ['assembling-machine-3', 0, 0, 'west'],
  ])
  assert.equal(ccw.collisions, 0)

  // Four turns is where it started.
  const round = run(`defaults (tier blue)
    transform (rotate-cw) => { transform (rotate-cw) => { transform (rotate-cw) => { transform (rotate-cw) => {${body}} } } }
  `).scene
  assert.deepEqual(shape(round), box(body).shape)
})

test('transform needs one it knows', () => {
  assert.match(errorsIn('transform => { steel-chest (at (0, 0)) }')[0].message, /needs apply/)
  assert.match(errorsIn('transform (sideways) => { steel-chest (at (0, 0)) }')[1].message, /not a transform/)
})

test('a transform turns the auto belts inside it along with everything else', () => {
  // Routing happens once the program has finished, so it has to read the tiles where they
  // ended up — a path remembered from before the turn points at the wrong ground entirely.
  const body = `
    steel-chest (at (3, 0))
    steel-chest (at (3, 4))
    belt (from (0, 0) to (6, 0), blue, auto)
    belt (from (0, 4) to (6, 4), blue, auto)
  `
  const shape = (source) => {
    const { scene } = run(`defaults (tier blue)\n${source}`)
    return {
      tunnels: scene.entities.filter((e) => e.proto.kind === 'underground-belt').length,
      entities: scene.entities.length,
      collisions: scene.findCollisions().length,
    }
  }

  const plain = shape(body)
  assert.equal(plain.tunnels, 4, 'a pair under each chest')
  assert.equal(plain.collisions, 0)
  for (const apply of ['rotate-cw', 'rotate-ccw', 'flip-h', 'flip-v', 'flip-hv']) {
    assert.deepEqual(shape(`transform (${apply}) => {${body}}`), plain, apply)
  }
})

test('what a transform contains is built normally, auto and all', () => {
  const { scene } = run(`
    transform (flip-h) => {
      steel-chest (at (3, 0))
      belt (from (0, 0) to (6, 0), blue, auto)
    }
  `)
  const pair = scene.entities.filter((e) => e.proto.kind === 'underground-belt')
  assert.equal(pair.length, 2, 'the tunnel is planned before the mirror, and mirrors with it')
  assert.deepEqual(
    pair.map((e) => [e.x, e.undergroundType, directionName(e.dir)]),
    [
      [4, 'input', 'west'],
      [2, 'output', 'west'],
    ],
  )
  assert.equal(scene.findCollisions().length, 0)
})

// ── Belt topology ─────────────────────────────────────────────────────────────

import { beltOrientation, isBeltish, tileIndex } from '../dist-node/core.mjs'

/** The orientation name each belt tile resolves to, in placement order. */
function orientations(scene) {
  const belts = tileIndex(scene.entities, isBeltish)
  return scene.entities.filter(isBeltish).map((e) => beltOrientation(e, belts))
}

test('a straight run is straight all the way', () => {
  const { scene } = run('belt (from (0, 0) to (3, 0), red)')
  assert.deepEqual(orientations(scene), ['east', 'east', 'east', 'east'])
})

test('a corner is named by the side items arrive through, not by where they came from', () => {
  // Running east into the corner means arriving through its WEST edge, and it turns south.
  // Naming it `east-to-south` picks the mirrored sprite and bends the belt the wrong way.
  const { scene } = run('belt (from (0, 0), via (3, 0), to (3, 3), red)')
  assert.deepEqual(orientations(scene), [
    'east',
    'east',
    'east',
    'west-to-south',
    'south',
    'south',
    'south',
  ])
})

test('every quarter turn resolves to its own sprite', () => {
  const cases = [
    ['belt (from (0, 0), via (2, 0), to (2, 2), red)', 'west-to-south'],
    ['belt (from (0, 2), via (2, 2), to (2, 0), red)', 'west-to-north'],
    ['belt (from (2, 0), via (0, 0), to (0, 2), red)', 'east-to-south'],
    ['belt (from (2, 2), via (0, 2), to (0, 0), red)', 'east-to-north'],
    ['belt (from (0, 0), via (0, 2), to (2, 2), red)', 'north-to-east'],
    ['belt (from (2, 0), via (2, 2), to (0, 2), red)', 'north-to-west'],
    ['belt (from (0, 2), via (0, 0), to (2, 0), red)', 'south-to-east'],
    ['belt (from (2, 2), via (2, 0), to (0, 0), red)', 'south-to-west'],
  ]
  for (const [source, expected] of cases) {
    const found = orientations(run(source).scene).filter((o) => o.includes('-to-'))
    assert.deepEqual(found, [expected], source)
  }
})

test('a splitter feeds both its lanes, so a belt turning off either one bends', () => {
  // A splitter is two tiles wide and its position is only one of them. Deciding who feeds
  // whom by adding a direction to that origin missed whichever lane it was not on, and the
  // belt came out straight.
  const cases = [
    ['express-splitter (at (7, 0), west)\nbelt (at (6, 0), north)', 'east-to-north'],
    ['express-splitter (at (7, 0), west)\nbelt (at (6, 1), north)', 'east-to-north'],
    ['express-splitter (at (7, 0), west)\nbelt (at (6, 1), south)', 'east-to-south'],
    ['express-splitter (at (0, 0), east)\nbelt (at (1, 1), south)', 'west-to-south'],
    ['express-splitter (at (0, 1), north)\nbelt (at (1, 0), east)', 'south-to-east'],
    ['express-splitter (at (0, 0), south)\nbelt (at (0, 1), west)', 'north-to-west'],
  ]
  for (const [source, expected] of cases) {
    const { scene } = run(`defaults (tier blue)\n${source}`)
    const belts = tileIndex(scene.entities, isBeltish)
    const belt = scene.entities.find((e) => e.proto.kind === 'belt')
    assert.equal(beltOrientation(belt, belts), expected, source)
  }

  // Carrying straight on out of a splitter is not a corner, and neither is facing back into
  // one — that is a jam.
  for (const [source, expected] of [
    ['express-splitter (at (0, 0), east)\nbelt (at (1, 0), east)', 'east'],
    ['express-splitter (at (0, 0), east)\nbelt (at (1, 0), west)', 'west'],
  ]) {
    const { scene } = run(`defaults (tier blue)\n${source}`)
    const belts = tileIndex(scene.entities, isBeltish)
    assert.equal(beltOrientation(scene.entities.find((e) => e.proto.kind === 'belt'), belts), expected, source)
  }
})

test('an underground exit feeds the tile in front of it, its entry does not', () => {
  const { scene } = run(`
    belt        (from (0, 0) to (1, 0), red)
    underground (from (2, 0) to (5, 0), red)
    belt        (from (6, 0), via (7, 0), to (7, 2), red)
  `)
  const belts = tileIndex(scene.entities, isBeltish)
  const corner = scene.entities.find((e) => e.x === 7 && e.y === 0)
  assert.equal(beltOrientation(corner, belts), 'west-to-south')
})

test('the registry knows which items travel by pipe', () => {
  assert.ok(registry.fluids.has('water'))
  assert.ok(registry.fluids.has('petroleum-gas'))
  assert.ok(!registry.fluids.has('iron-plate'))

  // Which is what decides whether a machine grows a pipe stub in the preview.
  const fluidsIn = (id) => Object.keys(registry.recipes.get(id).in).filter((k) => registry.fluids.has(k)).length
  assert.equal(fluidsIn('concrete'), 1, 'concrete takes water')
  assert.equal(fluidsIn('iron-gear-wheel'), 0)
})

// ── Sprite variant names ──────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs'
import { spriteVariants, isPipeish } from '../dist-node/core.mjs'

test('an underground asks for in-/out-, not its blueprint input/output', () => {
  const { scene } = run('underground (from (0, 0) to (4, 0), red)')
  const belts = tileIndex(scene.entities, isBeltish)
  const pipes = tileIndex(scene.entities, isPipeish)
  const [entry, exit] = scene.entities
  assert.equal(spriteVariants(entry, belts, pipes)[0], 'in-east')
  assert.equal(spriteVariants(exit, belts, pipes)[0], 'out-east')
})

test('every entity in every example resolves to a sprite that exists', async (t) => {
  // The atlas is built from a local Factorio install, so it may not be there at all.
  const atlasPath = join(ROOT, 'public/sprites/atlas.json')
  if (!existsSync(atlasPath)) return t.skip('no sprite atlas — run `npm run extract-sprites`')

  const atlas = JSON.parse(await readFile(atlasPath, 'utf8'))
  const missing = []

  for (const file of ['assembler-line.fbl', 'belts.fbl', 'blocks.fbl']) {
    const { scene } = run(await readFile(join(ROOT, 'examples', file), 'utf8'))
    const belts = tileIndex(scene.entities, isBeltish)
    const pipes = tileIndex(scene.entities, isPipeish)

    for (const entity of scene.entities) {
      const variants = atlas.entities[entity.proto.name]
      if (!variants) continue

      const wanted = spriteVariants(entity, belts, pipes)
      // Belts, undergrounds and pipes name an exact orientation; anything else is allowed to
      // fall through from its facing to the single `default` sprite.
      const exact = ['belt', 'underground-belt', 'pipe'].includes(entity.proto.kind)
      const ok = exact ? Boolean(variants[wanted[0]]) : wanted.some((name) => variants[name])
      if (!ok) missing.push(`${file}: ${entity.proto.name} wanted '${wanted[0]}'`)
    }
  }

  assert.deepEqual([...new Set(missing)], [])
})

test('an underground exit is drawn as the mirror of its entry', async (t) => {
  // Factorio draws an output end rotated 180° — its hood faces back down the belt, so a pair
  // reads as two ramps facing each other. The two sprites otherwise differ only in the
  // chevrons painted on them, about 3% of their pixels, which is what this guards against.
  const atlasPath = join(ROOT, 'public/sprites/atlas.json')
  if (!existsSync(atlasPath)) return t.skip('no sprite atlas — run `npm run extract-sprites`')

  const { default: sharp } = await import('sharp')
  const atlas = JSON.parse(await readFile(atlasPath, 'utf8'))
  const png = join(ROOT, 'public/sprites/atlas.png')

  const pixels = async (rect) =>
    sharp(png).extract({ left: rect.x, top: rect.y, width: rect.w, height: rect.h }).raw().toBuffer()

  for (const name of ['underground-belt', 'express-underground-belt']) {
    for (const direction of ['north', 'east', 'south', 'west']) {
      const entry = await pixels(atlas.entities[name][`in-${direction}`])
      const exit = await pixels(atlas.entities[name][`out-${direction}`])

      let differing = 0
      for (let i = 0; i < entry.length; i += 4) {
        if (Math.abs(entry[i] - exit[i]) > 12 || Math.abs(entry[i + 3] - exit[i + 3]) > 12) differing++
      }
      // Mirrored, these differ by 13–16%. Sharing one orientation, only 2–5% — the chevrons.
      const share = (100 * differing) / (entry.length / 4)
      assert.ok(share > 10, `${name} ${direction}: entry and exit differ by only ${share.toFixed(1)}%`)
    }
  }
})

test('belt-family art covers the whole entity, never half of it', async (t) => {
  // A splitter's main structure only reaches over one of its two lanes; the other is covered
  // by `structure_patch`. Miss it and half the splitter renders as bare belt.
  const atlasPath = join(ROOT, 'public/sprites/atlas.json')
  if (!existsSync(atlasPath)) return t.skip('no sprite atlas — run `npm run extract-sprites`')

  const atlas = JSON.parse(await readFile(atlasPath, 'utf8'))
  const ppt = atlas.pixelsPerTile
  const short = []

  for (const [name, proto] of registry.entities) {
    if (!['belt', 'underground-belt', 'splitter'].includes(proto.kind)) continue
    const variants = atlas.entities[name]
    if (!variants) continue

    for (const [key, rect] of Object.entries(variants)) {
      // East and west swap the footprint's axes.
      const rotated = key.includes('east') || key.includes('west')
      const needed = rotated ? [proto.size.y, proto.size.x] : [proto.size.x, proto.size.y]
      if (rect.w / ppt < needed[0] || rect.h / ppt < needed[1]) {
        short.push(`${name} ${key}: ${(rect.w / ppt).toFixed(2)}×${(rect.h / ppt).toFixed(2)} covers ${needed[0]}×${needed[1]}`)
      }
    }
  }

  assert.deepEqual(short, [])
})

// ── Balancers ─────────────────────────────────────────────────────────────────

import { BALANCER_LIMIT, balancerSizes, hasBalancer } from '../dist-node/core.mjs'

/** `balancer` lives in the standard library, so every one of these has to let it in. */
const withStdlib = (source) => `import "stdlib"\n${source}`

test('a balancer expands into belts of the chosen tier', () => {
  const { scene } = run(withStdlib('balancer (4 to 8, left, red)'))
  const names = new Set(scene.entities.map((e) => e.proto.name))
  assert.deepEqual([...names].sort(), ['fast-splitter', 'fast-transport-belt', 'fast-underground-belt'])
})

test('the flow direction rotates the whole layout', () => {
  const north = run(withStdlib('balancer (4 to 4, north)')).scene.bbox()
  const east = run(withStdlib('balancer (4 to 4, east)')).scene.bbox()
  assert.deepEqual([east.w, east.h], [north.h, north.w])
})

test('`left` and `west` mean the same thing', () => {
  const left = run(withStdlib('balancer (2 to 4, left)')).scene
  const west = run(withStdlib('balancer (2 to 4, west)')).scene
  assert.deepEqual(
    left.entities.map((e) => [e.proto.name, e.x, e.y, e.dir]),
    west.entities.map((e) => [e.proto.name, e.x, e.y, e.dir]),
  )
})

test('a pair the library does not have is refused before anything is placed', () => {
  const result = compileFor(withStdlib('balancer (9 to 3)'))
  assert.equal(result.ran, false)
  assert.match(result.diagnostics[0].message, /no 9 to 3 balancer/)
  assert.match(result.diagnostics[0].hint, new RegExp(`1 to ${BALANCER_LIMIT}`))
})

test('a diagonal balancer is refused', () => {
  const [error] = errorsIn(withStdlib('balancer (4 to 4, northeast)'))
  assert.match(error.message, /runs along an axis/)
})

test('every balancer in the library places cleanly, in every direction', () => {
  const failures = []

  for (const key of balancerSizes()) {
    const [from, to] = key.split('-')
    if (!hasBalancer(Number(from), Number(to))) continue

    for (const direction of ['north', 'east', 'south', 'west']) {
      const result = compileFor(withStdlib(`balancer (${from} to ${to}, ${direction})`))
      if (!result.ran) {
        failures.push(`${key} ${direction}: ${result.diagnostics[0]?.message}`)
        continue
      }
      const clashes = result.scene.findCollisions()
      if (clashes.length) {
        failures.push(`${key} ${direction}: ${clashes.length} overlap(s) at (${clashes[0].x}, ${clashes[0].y})`)
      }
      // Rotation must not move anything off the balancer's own corner.
      const box = result.scene.bbox()
      if (box.x !== 0 || box.y !== 0) failures.push(`${key} ${direction}: corner at (${box.x}, ${box.y})`)
    }
  }

  assert.deepEqual(failures, [])
})

// ── auto routing ──────────────────────────────────────────────────────────────

test('auto leaves a clear path alone', () => {
  const { scene } = run('belt (from (0, 0) to (5, 0), red, auto)')
  assert.equal(scene.entities.length, 6)
  assert.ok(scene.entities.every((e) => e.proto.kind === 'belt'))
})

test('auto tunnels under what is in the way', () => {
  const { scene } = run(`
    steel-chest (at (3, 0))
    belt (from (0, 0) to (6, 0), red, auto)
  `)
  const pair = scene.entities.filter((e) => e.proto.kind === 'underground-belt')
  assert.deepEqual(pair.map((e) => [e.x, e.undergroundType]), [[2, 'input'], [4, 'output']])
  assert.equal(scene.findCollisions().length, 0, 'nothing is laid on top of the chest')
})

test('auto spans a whole machine, not just a tile', () => {
  const { scene } = run(`
    assembling-machine-3 (at (2, -1))
    belt (from (0, 0) to (8, 0), red, auto)
  `)
  const pair = scene.entities.filter((e) => e.proto.kind === 'underground-belt')
  assert.deepEqual(pair.map((e) => e.x), [1, 5], 'entry before the machine, exit after it')
  assert.equal(scene.findCollisions().length, 0)
})

test('a gap the tier cannot reach names a tier that can', () => {
  const source = `
    assembling-machine-3 (at (2, -1))
    electric-furnace (at (5, -1))
    belt (from (0, 0) to (10, 0), TIER, auto)
  `
  const [warning] = warningsIn(source.replace('TIER', 'yellow'))
  assert.match(warning.message, /but Underground belt reaches 4/)
  assert.match(warning.hint, /red reaches 6/)

  const { scene } = run(source.replace('TIER', 'blue'))
  assert.equal(scene.findCollisions().length, 0)
})

test('a belt auto cannot route is laid flat and said so, not thrown away', () => {
  const cases = [
    ['steel-chest (at (0, 0))\nbelt (from (0, 0) to (4, 0), red, auto)', /starts on Steel chest/],
    ['steel-chest (at (3, 0))\nbelt (from (0, 0), via (3, 0), to (3, 3), red, auto)', /turns at \(3, 0\)/],
  ]
  for (const [source, expected] of cases) {
    const result = compileFor(source)
    assert.equal(result.ran, true, source)
    assert.ok(result.scene.entities.length > 1, `${source}: the rest of the blueprint still stands`)

    const [warning] = result.diagnostics.filter((d) => d.severity === 'warning')
    assert.match(warning.message, expected, source)
    assert.match(warning.message, /laid flat/, source)
    // Which is exactly what makes it visible: the belt now clashes where it could not dive.
    assert.ok(result.scene.findCollisions().length > 0, source)
  }
})

test('a tunnel may dive from a belt it merged with, since they are one line', () => {
  // Every tile of the second run is already carrying the first, so there is no empty ground
  // to dive from anywhere. The shared tile becomes the entry: the two were the same line.
  const { scene } = run(`
    defaults (tier blue, auto)
    belt (from (0, 0) to (3, 0))
    assembling-machine-3 (at (4, 0), recipe iron-gear-wheel)
    belt (from (0, 0) to (10, 0))
  `)
  const pair = scene.entities.filter((e) => e.proto.kind === 'underground-belt')
  assert.deepEqual(
    pair.map((e) => [e.x, e.undergroundType]),
    [
      [3, 'input'],
      [7, 'output'],
    ],
    'the entry took the tile the first belt was on',
  )
  assert.equal(scene.findCollisions().length, 0, 'one line, one tile each')
  assert.equal(
    scene.entities.filter((e) => e.x === 3 && e.y === 0).length,
    1,
    'and the belt it replaced is gone rather than stacked under it',
  )

  // A splitter is a thing in its own right, not a stretch of belt, so it is never taken over.
  const [warning] = warningsIn(`
    defaults (tier blue, auto)
    express-splitter (at (3, 0), east)
    steel-chest (at (4, 0))
    belt (from (3, 0) to (8, 0))
  `)
  assert.match(warning.message, /starts on/)
})

test('a lane a run leaves off in is finished by the run that carries on', () => {
  // The first belt stops inside the machines; the second carries the same lane past them and
  // surfaces beyond. Read one run at a time the first belt is impossible, and the picture
  // plainly shows it working — so a run that fails is tried again with the whole thing in view.
  const { scene } = run(`
    defaults (tier blue, auto)
    assembling-machine-3 (at (0, 0), recipe iron-gear-wheel)
    belt (from (8, 1) to (0, 1))
    belt (from (8, 1) to (-2, 1))
  `)
  assert.equal(scene.findCollisions().length, 0)
  const pair = scene.entities.filter((e) => e.proto.kind === 'underground-belt')
  assert.deepEqual(
    pair.map((e) => [e.x, e.undergroundType]),
    [
      [3, 'input'],
      [-1, 'output'],
    ],
    'one tunnel under the machine, surfacing on the far side',
  )
})

test('what could be merged is merged even when the rest cannot be routed', () => {
  // The chest blocks the run and there is nowhere to dive from, so the belt stays flat — but
  // the stretch it shares with a belt going the same way was never a conflict.
  const { scene } = run(`
    defaults (tier blue, auto)
    belt (from (0, 0) to (10, 0))
    steel-chest (at (0, 4))
    belt (from (0, 4) to (10, 4))
    belt (from (3, 4) to (10, 4))
  `)
  const clash = scene.findCollisions()
  assert.ok(
    clash.every((pair) => pair.a.proto.kind === 'container' || pair.b.proto.kind === 'container'),
    'only the chest is left clashing; the two belts share their tiles',
  )
})

test('a line already going our way is joined, not tunnelled under', () => {
  // A splitter dropped into a run is part of the run: the belt feeds it and carries on.
  const inline = run(`
    express-splitter (at (5, 0), east)
    belt (from (0, 0) to (10, 0), blue, auto)
  `).scene
  assert.equal(inline.entities.filter((e) => e.proto.kind === 'underground-belt').length, 0)
  assert.equal(inline.findCollisions().length, 0)

  // Turned across the line it is an obstacle like any other.
  const across = run(`
    express-splitter (at (5, 0), north)
    belt (from (0, 0) to (10, 0), blue, auto)
  `).scene
  assert.equal(across.entities.filter((e) => e.proto.kind === 'underground-belt').length, 2)
  assert.equal(across.findCollisions().length, 0)
})

test('two auto belts along the same line merge', () => {
  const { scene } = run(`
    belt (from (0, 0) to (10, 0), blue, auto)
    belt (from (5, 0) to (15, 0), blue, auto)
  `)
  assert.equal(scene.entities.length, 16, 'one belt per tile, not two on the overlap')
  assert.equal(scene.entities.filter((e) => e.proto.kind === 'underground-belt').length, 0)
  assert.equal(scene.findCollisions().length, 0)

  // Pointing the other way they cannot both be there, and the error says which way it runs.
  const [warning] = warningsIn(`
    belt (from (10, 0) to (0, 0), blue, auto)
    belt (from (5, 0) to (15, 0), blue, auto)
  `)
  assert.match(warning.message, /starts on Express transport belt/)
  assert.match(warning.hint, /runs west/)
})

test('a tunnel surfaces before a splitter when there is room for it', () => {
  const { scene } = run(`
    steel-chest (at (3, 0))
    express-splitter (at (5, 0), east)
    belt (from (0, 0) to (10, 0), blue, auto)
  `)
  const pair = scene.entities.filter((e) => e.proto.kind === 'underground-belt')
  assert.deepEqual(
    pair.map((e) => [e.x, e.undergroundType]),
    [
      [2, 'input'],
      [4, 'output'],
    ],
    'under the chest, up on the free tile, then straight into the splitter',
  )
  assert.equal(scene.findCollisions().length, 0)
})

test('obstacles a tile apart share one longer tunnel', () => {
  // The tile between the chests cannot surface: it would have to be the exit of one pair and
  // the entry of the next at once. So the belt stays under it.
  const { scene } = run(`
    steel-chest (at (2, 0))
    steel-chest (at (4, 0))
    steel-chest (at (6, 0))
    belt (from (0, 0) to (8, 0), blue, auto)
  `)
  const pair = scene.entities.filter((e) => e.proto.kind === 'underground-belt')
  assert.equal(pair.length, 2, 'one pair, not three')
  assert.deepEqual(
    pair.map((e) => [e.x, e.undergroundType]),
    [
      [1, 'input'],
      [7, 'output'],
    ],
  )
  assert.equal(scene.findCollisions().length, 0)

  // Merging does not buy reach: a tier that cannot span the whole thing still says so.
  const [warning] = warningsIn(`
    steel-chest (at (2, 0))
    steel-chest (at (4, 0))
    steel-chest (at (6, 0))
    belt (from (0, 0) to (8, 0), yellow, auto)
  `)
  assert.match(warning.message, /5 tiles to tunnel .* reaches 4/)
})

test('route can be defaulted, so a bus need not say auto on every line', () => {
  const obstacles = `
    steel-chest (at (3, 0))
    steel-chest (at (3, 4))
  `
  const tunnels = (source) => {
    const { scene } = run(source)
    return [scene.entities.filter((e) => e.proto.kind === 'underground-belt').length, scene.findCollisions().length]
  }

  const runs = `${obstacles}
    belt (from (0, 0) to (6, 0))
    belt (from (0, 4) to (6, 4))
  `
  assert.deepEqual(tunnels(`defaults (tier blue)\n${runs}`), [0, 2], 'without it they lie over the chests')
  assert.deepEqual(tunnels(`defaults (tier blue, route auto)\n${runs}`), [4, 0])

  // A value can find its own slot, the way it does everywhere else in the language.
  assert.deepEqual(tunnels(`defaults (blue, auto)\n${runs}`), [4, 0])
  assert.deepEqual(tunnels(`defaults belt (auto)\ndefaults (tier blue)\n${runs}`), [4, 0])

  // The call still wins.
  assert.deepEqual(
    tunnels(`defaults (tier blue, auto)\n${obstacles}\nbelt (from (0, 0) to (6, 0), direct)`),
    [0, 1],
  )

  // A bare value that resolves to nothing is still a mistake, not the first slot going.
  assert.match(errorsIn('defaults (wat)')[1].message, /slot value/)
})

test('auto reads the finished blueprint, not the half of it written above', () => {
  // Routing waits for the program to end, so where the obstacle is written cannot matter.
  const before = run(`
    steel-chest (at (3, 0))
    belt (from (0, 0) to (6, 0), red, auto)
  `).scene
  const after = run(`
    belt (from (0, 0) to (6, 0), red, auto)
    steel-chest (at (3, 0))
  `).scene

  const shape = (scene) =>
    scene.entities.map((e) => [e.proto.name, e.x, e.y, e.undergroundType ?? '']).sort()
  assert.deepEqual(shape(after), shape(before))
  assert.equal(after.entities.filter((e) => e.proto.kind === 'underground-belt').length, 2)
  assert.equal(after.findCollisions().length, 0)

  // Same for a splitter dropped into the run: written either side, it merges.
  const merged = (source) => {
    const { scene } = run(`defaults (tier blue, auto)\n${source}`)
    return [scene.entities.length, scene.entities.filter((e) => e.proto.kind === 'underground-belt').length, scene.findCollisions().length]
  }
  const first = 'express-splitter (at (5, 0), east)\nbelt (from (0, 0) to (10, 0))'
  const last = 'belt (from (0, 0) to (10, 0))\nexpress-splitter (at (5, 0), east)'
  assert.deepEqual(merged(last), merged(first))
  assert.deepEqual(merged(last), [11, 0, 0])

  // Without `auto` a belt is laid exactly as written, and still collides.
  const plain = run(`
    belt (from (0, 0) to (6, 0), red)
    steel-chest (at (3, 0))
  `).scene
  assert.equal(plain.findCollisions().length, 1)
})

// ── throw ─────────────────────────────────────────────────────────────────────

test('throw stops the build with the author\'s own message', () => {
  const result = compileFor('throw "size must be at least 2"')
  assert.equal(result.ran, false)
  assert.equal(result.scene.entities.length, 0)
  assert.deepEqual(
    result.diagnostics.map((d) => [d.severity, d.message, d.loc.line]),
    [['error', 'size must be at least 2', 1]],
  )
})

test('a guard inside a block reports at the call, and names the block', () => {
  const source = `
    defblock bank (int size) => {
      if size < 2 => { throw "size must be at least 2" }
      for i in 0..size => { steel-chest (at (i, 0)) }
    }
    bank (at (0, 0), size 4)
    bank (at (0, 2), size 1)
  `
  const [error] = errorsIn(source)
  assert.equal(error.message, 'size must be at least 2')
  // Line 7 is the offending call; line 3 is the guard that caught it.
  assert.equal(error.loc.line, 7, 'the error goes where the fix goes')
  assert.match(error.hint, /thrown by 'bank' on line 3/)

  // The same block is fine when the guard passes, and nothing is left behind by the failure.
  const { scene } = run(source.replace('size 1', 'size 3'))
  assert.equal(scene.entities.length, 7)
})

test('a thrown message joins a list the way print does', () => {
  const [error] = errorsIn(`
    defblock bank (int size) => {
      if size < 2 => { throw ("size must be at least 2, got", size) }
      steel-chest (at (0, 0))
    }
    bank (size 1)
  `)
  assert.equal(error.message, 'size must be at least 2, got 1')
})

test('throw needs something to say', () => {
  const [error] = errorsIn('throw')
  assert.match(error.message, /throw needs a message/)
})

// ── Cost ──────────────────────────────────────────────────────────────────────

import { computeCost } from '../dist-node/core.mjs'

const rawOf = (source) => {
  const { scene } = run(source)
  const cost = computeCost(scene, registry)
  return Object.fromEntries(cost.raw.map((e) => [e.item, e.amount]))
}

test('a belt costs one and a half ore, because the recipe makes two', () => {
  const raw = rawOf('transport-belt (at (0, 0))')
  // 1 belt = ½ iron plate + ½ gear (1 plate) = 1.5 plate = 1.5 ore.
  assert.equal(raw['iron-ore'], 1.5)
})

test('an item nothing makes is where the trail stops, not a hole', async () => {
  // Wood is chopped from trees and holmium ore comes out of scrap, which the model does not
  // follow. Neither is a gap in the data: both are simply inputs.
  for (const id of ['2x1', '1.1']) {
    const reg = await registryFor(id, id === '1.1' ? V11 : { ...SPA, id })
    const names = [...reg.entities.keys()]
    const scene = compileFor(names.map((n, i) => `${n} (at (${i * 12}, 0))`).join('\n'), reg).scene
    const raw = new Set(computeCost(scene, reg).raw.map((e) => e.item))
    assert.ok(raw.has('wood'), `${id}: wood is an input`)
  }
})

test('the trail stops at what the game extracts, not at what has no recipe', () => {
  // In Space Age `iron-ore` has a recipe of its own that grows it from bacteria. Following
  // that would price a transport belt in biochambers.
  const raw = rawOf('transport-belt (at (0, 0))')
  assert.deepEqual(Object.keys(raw), ['iron-ore'])
})

test('modules are counted, and they dominate', () => {
  const bare = rawOf('assembling-machine-3 (at (0, 0))')
  const loaded = rawOf('assembling-machine-3 (at (0, 0), modules (productivity-module-3))')
  assert.ok(loaded['copper-ore'] > bare['copper-ore'] * 5, 'a productivity 3 is not cheap')
})

test('everything an example places has a known cost', () => {
  for (const file of ['assembler-line.fbl', 'belts.fbl', 'blocks.fbl']) {
    const source = readFileSync(join(ROOT, 'examples', file), 'utf8')
    const { scene } = run(source)
    const cost = computeCost(scene, registry)
    assert.ok(cost.raw.length > 0, file)
    assert.ok(
      cost.items.reduce((n, e) => n + e.amount, 0) >= scene.entities.length,
      `${file}: every entity is billed`,
    )
  }
})

const basicOf = (source) => {
  const { scene } = run(source)
  return Object.fromEntries(computeCost(scene, registry).basic.map((e) => [e.item, e.amount]))
}

test('basic stops at the materials, one tier above the ore', () => {
  // A belt is ½ plate plus a gear, which is another plate. The ore behind them is not shown.
  assert.deepEqual(basicOf('transport-belt (at (0, 0))'), { 'iron-plate': 1.5 })

  const furnace = basicOf('electric-furnace (at (0, 0))')
  assert.deepEqual(Object.keys(furnace).sort(), [
    'copper-plate',
    'iron-plate',
    'plastic-bar',
    'steel-plate',
    'stone-brick',
  ])
})

test('a material is processed, not assembled, and made only of materials', () => {
  // The foundry casts a turbo belt, but out of gears and plates — so it is not a material,
  // and the panel keeps breaking it down.
  const turbo = basicOf('turbo-transport-belt (at (0, 0))')
  assert.equal(turbo['turbo-transport-belt'], undefined)
  assert.ok(turbo['tungsten-plate'] > 0, 'the foundry casting the plate is a material')

  // A gear runs in an assembler, so it is not where the trail stops either.
  assert.deepEqual(basicOf('iron-chest (at (0, 0))'), { 'iron-plate': 8 })
})

test('growing counts as extraction, so fruit is raw', () => {
  // Turbo belts need carbon fibre, which a biochamber grows the ingredients for.
  const source = readFileSync(join(ROOT, 'examples', 'smelters-array.fbl'), 'utf8')
  const cost = computeCost(run(source).scene, registry)
  const raw = new Set(cost.raw.map((e) => e.item))

  assert.ok(raw.has('yumako') && raw.has('jellynut'), 'the fruit is where the trail stops')
  // A seed grows fruit that yields the seed back; without the plant flag that loop is what
  // the walk would bottom out on.
  for (const list of [cost.raw, cost.basic]) {
    assert.deepEqual(list.filter((e) => e.item.endsWith('-seed')), [])
  }
})

// ── Power coverage ────────────────────────────────────────────────────────────

import { powerCoverage } from '../dist-node/core.mjs'

const coverageOf = (source) => powerCoverage(run(source).scene.entities)

test('a pole powers the square the game says it does', () => {
  // These are supply areas, not wire reach — a big pole throws a wire 32 tiles and powers 4×4.
  const cases = [
    ['small-electric-pole', 5],
    ['medium-electric-pole', 7],
    ['big-electric-pole', 4],
    ['substation', 18],
  ]
  for (const [pole, side] of cases) {
    const report = coverageOf(`${pole} (at (0, 0))`)
    assert.equal(report.covered.size, side * side, pole)
  }
})

test('the supply square is centred on the pole', () => {
  const report = coverageOf('medium-electric-pole (at (0, 0))')
  for (const [x, y, lit] of [
    [0, 0, true],
    [3, 3, true],
    [-3, -3, true],
    [4, 0, false],
    [0, -4, false],
  ]) {
    assert.equal(report.covered.has(`${x},${y}`), lit, `(${x}, ${y})`)
  }
})

test('one tile inside the area is enough to power a machine', () => {
  // The assembler spans (0,0)–(2,2); the pole's area only reaches its far corner.
  const powered = coverageOf('assembling-machine-3 (at (0, 0))\nmedium-electric-pole (at (5, 5))')
  assert.equal(powered.unpowered.length, 0)

  const dark = coverageOf('assembling-machine-3 (at (0, 0))\nmedium-electric-pole (at (6, 6))')
  assert.equal(dark.unpowered.length, 1)
})

test('only things that draw power are counted', () => {
  const report = coverageOf(`
    transport-belt (at (0, 0))
    steel-chest (at (1, 0))
    splitter (at (2, 0))
    burner-inserter (at (4, 0))
    bulk-inserter (at (5, 0))
    small-lamp (at (6, 0))
  `)
  assert.equal(report.consumers, 2, 'the inserter and the lamp; belts and chests need nothing')
  assert.equal(report.poles, 0)
})

test('the assembler-line example is fully powered', () => {
  const source = readFileSync(join(ROOT, 'examples', 'assembler-line.fbl'), 'utf8')
  const report = coverageOf(source)
  assert.ok(report.poles > 0)
  assert.equal(report.unpowered.length, 0, 'every inserter and machine reaches a substation')
})

test('an unlabelled coordinate fills at, and says so when a parameter wanted it', () => {
  // The trap: a block with its own `coord` parameter. `f ((1, 2))` looks like it passes the
  // coordinate to that parameter, but an unlabelled coordinate always means position.
  const source = `
    defblock pad (coord s) => { at (s) => { steel-chest (at (0, 0)) } }
    pad ((1, 2))
  `
  const [error] = errorsIn(source)
  assert.match(error.message, /'pad' needs s/)
  assert.match(error.hint, /unlabelled coordinate fills 'at'/)
  assert.ok(error.loc, 'the error points at the call')

  // Labelling it reaches the parameter; and `at` alone does the same job with no parameter.
  const labelled = run(`
    defblock pad (coord s) => { at (s) => { steel-chest (at (0, 0)) } }
    pad (s (1, 2))
  `).scene
  const builtin = run(`
    defblock pad () => { steel-chest (at (0, 0)) }
    pad (at (1, 2))
  `).scene
  assert.deepEqual(
    labelled.entities.map((e) => [e.x, e.y]),
    builtin.entities.map((e) => [e.x, e.y]),
  )
})

test('a bare name is a value when it is bound, and a bare label when it is not', () => {
  // `stack-inserter (dir)` passes the variable `dir`; only an unbound name that happens to
  // match a slot is a label that lost its argument.
  const { scene } = run(`
    defblock pad (direction dir = left) => { stack-inserter (at (0, 0), dir) }
    pad (right)
  `)
  assert.equal(scene.entities[0].dir, 4, 'east')

  const [error] = errorsIn('stack-inserter (at (0, 0), dir)')
  assert.match(error.message, /'dir' has no value/)
  assert.match(error.hint, /dir takes direction/)
})

test('a default is read as the type it was declared', () => {
  // Entities, recipes and items are too large a vocabulary to guess a bare name from, so the
  // declared type is what tells the checker how to read it. Without that the default for an
  // `entity` parameter was rejected as an unknown name.
  const { scene } = run(`
    defblock bay (entity box = steel-chest, recipe r = iron-gear-wheel, item fuel = coal) => {
      box (at (0, 0))
      assembling-machine-3 (at (1, 0), recipe r)
    }
    bay (at (0, 0))
    bay (at (0, 4), box iron-chest)
    bay (at (0, 8), entity wooden-chest)
  `)
  assert.deepEqual(
    scene.entities.filter((e) => e.proto.kind === 'container').map((e) => e.proto.name),
    ['steel-chest', 'iron-chest', 'wooden-chest'],
    'the slot answers to its own name and to its type',
  )
  assert.equal(scene.findCollisions().length, 0)
})

test('naming a parameter after its slot lets a bare value find it', () => {
  // A bare direction fills `dir`. A parameter called `d` is reachable only by label.
  const [error] = errorsIn(`
    defblock pad (direction d = left) => { stack-inserter (at (0, 0), dir d) }
    pad (right)
  `)
  assert.match(error.message, /needs a label here/)
  assert.match(error.hint, /at, d/)

  const { scene } = run(`
    defblock pad (direction dir = left) => { stack-inserter (at (0, 0), dir) }
    pad (right)
  `)
  assert.equal(scene.entities[0].dir, 4)
})

test('a layout packs along its axis and leaves the other one alone', () => {
  // The plant sits above the line and the inserter on it. A row that flattened the group to
  // its bounding box would drop both onto the belt, and the belt would start inside a plant.
  const { scene } = run(`
    defaults (tier blue)
    row (gap 2) for i in 0..4 => {
      electromagnetic-plant (at (-5, -3), recipe quality-module)
      bulk-inserter (at (-1, 0), west)
    }
    belt (from (24, 0) to (-12, 0), auto)
  `)

  assert.deepEqual(
    find(scene, 'electromagnetic-plant').map((e) => [e.x, e.y]),
    [
      [-5, -3],
      [2, -3],
      [9, -3],
      [16, -3],
    ],
    'each group keeps its own shape and starts a gap past the one before',
  )

  const tunnels = scene.entities.filter((e) => e.proto.kind === 'underground-belt')
  assert.equal(tunnels.length, 8, 'one pair under each group')
  assert.equal(scene.findCollisions().length, 0)
})

test('align opts into moving things across the axis', () => {
  const of = (source) => run(source).scene.entities.map((e) => e.y)

  // Two items of different heights, the second deliberately dropped a tile.
  const source = (align) => `
    row (${align}) => {
      steel-chest (at (0, 0))
      assembling-machine-3 (at (0, 1))
    }
  `
  assert.deepEqual(of(source('gap 1')), [0, 1], 'left where they were written')
  assert.deepEqual(of(source('gap 1, align start')), [0, 0], 'flush to the leading edge')
  assert.deepEqual(of(source('gap 1, align end')), [2, 0], 'flush to the trailing edge')
})

test('auto sees its neighbours where a layout will actually put them', () => {
  // Layout forms used to evaluate every child at the frame origin and shift them afterwards,
  // so a belt routing inside one saw the previous child sitting on top of it.
  const source = `
    defblock cell () => {
      steel-chest (at (1, 0))
      belt (from (0, 0) to (3, 0), red, auto)
    }
    LAYOUT
  `
  const stacked = run(source.replace('LAYOUT', 'column for i in 0..3 => { cell () }')).scene
  const spread = run(source.replace('LAYOUT', 'for i in 0..3 => { cell (at (0, i)) }')).scene

  assert.equal(stacked.entities.length, spread.entities.length)
  assert.equal(
    stacked.entities.filter((e) => e.proto.kind === 'underground-belt').length,
    6,
    'each of the three rows tunnels under its own chest',
  )
  assert.equal(stacked.findCollisions().length, 0)
})

test('the smelters array example builds clean', () => {
  const source = readFileSync(join(ROOT, 'examples', 'smelters-array.fbl'), 'utf8')
  const { scene } = run(source)
  assert.equal(scene.findCollisions().length, 0)
  const power = powerCoverage(scene.entities)
  assert.equal(power.unpowered.length, 0, 'one substation per block covers it')
  assert.equal(scene.entities.filter((e) => e.proto.name === 'electric-furnace').length, 36)
})

// ── Contents, filters and priorities ──────────────────────────────────────────

test('content names the lane an item rides on, and never reaches the blueprint', () => {
  const { scene } = run('belt (from (0, 0), to (3, 0), content (iron-ore left, coal right))')
  for (const entity of scene.entities) {
    assert.deepEqual(entity.content, [
      { item: 'iron-ore', side: 'left' },
      { item: 'coal', side: 'right' },
    ])
  }

  const json = exportBlueprint(scene, registry).json.blueprint
  assert.equal(JSON.stringify(json).includes('iron-ore'), false, 'content is metadata only')
})

test('a chest lists items without sides, up to the stacks it has', () => {
  const { scene } = run('steel-chest (at (0, 0), content (iron-plate, copper-plate))')
  assert.deepEqual(scene.entities[0].content, [{ item: 'iron-plate' }, { item: 'copper-plate' }])

  assert.match(errorsIn('wooden-chest (at (0, 0), content (iron-plate left))')[0].message, /no sides/)
  // A wooden chest holds 16 stacks, so the cap is the chest's, not a fixed number.
  const many = Array.from({ length: 17 }, () => 'iron-plate').join(', ')
  assert.match(errorsIn(`wooden-chest (at (0, 0), content (${many}))`)[0].message, /holds 16 stacks/)
})

test('a belt carries two items, one per lane', () => {
  assert.match(errorsIn('belt (at (0, 0), content (iron-ore, coal, stone))')[0].message, /two lanes/)
  assert.match(errorsIn('belt (at (0, 0), content (iron-ore left, coal left))')[0].message, /left lane/)
  assert.match(errorsIn('belt (at (0, 0), content (iron-ore up))')[0].message, /not a side/)
  assert.match(errorsIn('belt (at (0, 0), content (iron-plat))')[0].message, /not an item/)
})

test('an inserter filter is a whitelist, and not makes the whole list a blacklist', () => {
  const pass = run('fast-inserter (at (0, 0), filter (copper-plate, copper-ore))').scene
  assert.deepEqual(pass.entities[0].filters, { items: ['copper-plate', 'copper-ore'], negated: false })

  const block = run('fast-inserter (at (0, 0), filter (not copper-ore))').scene
  assert.deepEqual(block.entities[0].filters, { items: ['copper-ore'], negated: true })

  // The mode belongs to the inserter, so `not` only makes sense in front of the list.
  assert.match(errorsIn('fast-inserter (at (0, 0), filter (copper-ore, not coal))')[0].message, /whole list/)
})

test('inserter filters export as a numbered list with the blacklist switch', async () => {
  const { scene } = run('fast-inserter (at (0, 0), filter (not copper-plate, copper-ore))')
  const entity = exportBlueprint(scene, registry).json.blueprint.entities[0]
  assert.equal(entity.use_filters, true)
  assert.equal(entity.filter_mode, 'blacklist')
  assert.deepEqual(entity.filters, [
    { index: 1, name: 'copper-plate', quality: 'normal', comparator: '=' },
    { index: 2, name: 'copper-ore', quality: 'normal', comparator: '=' },
  ])

  // 1.1 has dedicated filter inserters, so there is no switch to turn on and no quality.
  const old = await registryFor('1.1', V11)
  const legacy = exportBlueprint(run('filter-inserter (at (0, 0), filter (copper-plate))', old).scene, old)
  const first = legacy.json.blueprint.entities[0]
  assert.equal(first.use_filters, undefined)
  assert.deepEqual(first.filters, [{ index: 1, name: 'copper-plate' }])
})

test('a splitter filters one item and prefers a side each way', () => {
  const { scene } = run('splitter (at (0, 0), filter copper-plate, in-priority right)')
  const entity = exportBlueprint(scene, registry).json.blueprint.entities[0]
  assert.equal(entity.input_priority, 'right')
  assert.deepEqual(entity.filter, { name: 'copper-plate', quality: 'normal', comparator: '=' })
  // The game sends a filtered item left when no output side was named.
  assert.equal(entity.output_priority, 'left')

  const plain = exportBlueprint(run('splitter (at (0, 0), out-priority right)').scene, registry)
  assert.equal(plain.json.blueprint.entities[0].output_priority, 'right')
  assert.equal(plain.json.blueprint.entities[0].filter, undefined)

  assert.match(errorsIn('splitter (at (0, 0), filter (copper-plate, coal))')[0].message, /a single item/)
  assert.match(errorsIn('splitter (at (0, 0), in-priority up)')[0].message, /not a side/)
})

test('the records example builds clean', () => {
  const source = readFileSync(join(ROOT, 'examples', 'records.fbl'), 'utf8')
  const { scene } = run(source)
  assert.equal(scene.findCollisions().length, 0)
  const belts = scene.entities.filter((e) => e.proto.kind === 'belt')
  assert.equal(belts.filter((b) => b.content?.length).length, 32, 'both written-out lanes carry what they were given')
})

test('the sorting example builds clean', () => {
  const source = readFileSync(join(ROOT, 'examples', 'sorting.fbl'), 'utf8')
  const { scene } = run(source)
  assert.equal(scene.findCollisions().length, 0)
  assert.equal(scene.entities.filter((e) => e.content?.length).length, 31, 'every belt tile and chest carries its declaration')
})

test('only the entities that can hold them accept content and filters', () => {
  assert.match(errorsIn('assembling-machine-3 (at (0, 0), content (iron-plate))')[0].message, /no slot 'content'/)
  assert.match(errorsIn('steel-chest (at (0, 0), filter (iron-plate))')[0].message, /no slot 'filter'/)
})

// ── Rates ─────────────────────────────────────────────────────────────────────

import { computeRates } from '../dist-node/core.mjs'

const ratesOf = (source) => {
  const rates = computeRates(run(source).scene, registry)
  return {
    ...rates,
    consumption: Object.fromEntries(rates.consumption.map((e) => [e.item, e.perSecond])),
    production: Object.fromEntries(rates.production.map((e) => [e.item, e.perSecond])),
  }
}

test('a machine eats and makes what its recipe says, at its own speed', () => {
  // An assembling machine 3 crafts at 1.25, and a gear takes half a second: 2.5 crafts a second.
  const rates = ratesOf('assembling-machine-3 (at (0, 0), recipe iron-gear-wheel)')
  assert.equal(rates.consumption['iron-plate'], 5)
  assert.equal(rates.production['iron-gear-wheel'], 2.5)
  assert.equal(rates.crafting, 1)
})

test('speed modules move both sides of the ledger, productivity only the output', () => {
  const speed = ratesOf(`assembling-machine-3 (at (0, 0), recipe iron-gear-wheel,
    modules (speed-module-3, speed-module-3, speed-module-3, speed-module-3))`)
  // Four speed 3s are +200%, so 1.25 becomes 3.75 — three times the crafts, three times both.
  assert.equal(speed.consumption['iron-plate'], 15)
  assert.equal(speed.production['iron-gear-wheel'], 7.5)

  const prod = ratesOf(`assembling-machine-3 (at (0, 0), recipe iron-gear-wheel,
    modules (productivity-module-3, productivity-module-3))`)
  // Two productivity 3s: −30% speed, +20% output. The plates in drop, the gears out do not.
  assert.equal(prod.consumption['iron-plate'], 3.5)
  assert.equal(Number(prod.production['iron-gear-wheel'].toFixed(4)), 2.1)
})

test('a machine crafts faster for being built well', () => {
  const rates = ratesOf('assembling-machine-3 (at (0, 0), recipe iron-gear-wheel, quality legendary)')
  // A legendary assembler runs at 3.125 rather than 1.25.
  assert.equal(rates.production['iron-gear-wheel'], 6.25)
})

test('a foundry casts half again as much for nothing, because that is what a foundry does', () => {
  const rates = ratesOf('foundry (at (0, 0), recipe casting-iron-gear-wheel)')
  assert.equal(rates.consumption['molten-iron'], 40)
  assert.equal(rates.production['iron-gear-wheel'], 6)
})

test('a beacon reaches the machines around it, and empty ones are not in the way', () => {
  const bare = 'assembling-machine-3 (at (0, 0), recipe iron-gear-wheel)'
  const beacon = 'beacon (at (0, 4), modules (speed-module-3, speed-module-3))'

  // One beacon with two speed 3s hands over 1.5 × 100%, so 1.25 becomes 3.125.
  assert.equal(ratesOf(`${bare} ${beacon}`).production['iron-gear-wheel'], 6.25)

  // Out of range: a beacon covers three tiles past its own footprint, and this one is four away.
  assert.equal(ratesOf(`${bare} beacon (at (0, 8), modules (speed-module-3))`).production['iron-gear-wheel'], 2.5)

  // An empty beacon standing next to a full one gives nothing and takes nothing away.
  assert.equal(ratesOf(`${bare} ${beacon} beacon (at (4, 4))`).production['iron-gear-wheel'], 6.25)
})

test('a machine with nothing to craft is counted apart rather than as a zero', () => {
  const rates = ratesOf('electric-furnace (at (0, 0)) assembling-machine-3 (at (4, 0))')
  assert.equal(rates.crafting, 0)
  assert.equal(rates.idle, 2)
  assert.deepEqual(rates.consumption, {})
})

test('belts and chests have no rate at all', () => {
  const rates = ratesOf('transport-belt (at (0, 0), east) steel-chest (at (2, 0))')
  assert.equal(rates.crafting, 0)
  assert.equal(rates.idle, 0)
})

// ── Records ───────────────────────────────────────────────────────────────────

const LINE = 'defrecord line (direction dir = east, item[] content = ())\n'

/** Runs a program whose block prints what it was handed. */
const printed = (source) => run(source).output

test('a record is filled the way a call is, by label or by type', () => {
  const body = 'defblock b (line[] ls = 1) => { print (count (ls), ls[0].dir) }\n'
  assert.deepEqual(printed(`${LINE}${body}b (ls (dir west))`), ['1 west'])
  // A bare value finds the only field it could be, exactly as it does in an entity's slots.
  assert.deepEqual(printed(`${LINE}${body}b (ls (west))`), ['1 west'])
})

test('groups of their own are the elements of a list, anything else is one record', () => {
  const body = 'defblock b (line[] ls = 1) => { for l, i in ls => { print (i, l.dir) } }\n'
  assert.deepEqual(printed(`${LINE}${body}b (ls ((dir west), (dir south)))`), ['0 west', '1 south'])
  assert.deepEqual(printed(`${LINE}${body}b (ls (dir west))`), ['0 west'])
  assert.deepEqual(printed(`${LINE}${body}b (ls ())`), [])
})

test('a count is that many records at their defaults', () => {
  const body = 'defblock b (line[] ls = 2) => { print (count (ls), ls[1].dir) }\n'
  assert.deepEqual(printed(`${LINE}${body}b (ls 3)`), ['3 east'])
  // Including when the count is the parameter's own default.
  assert.deepEqual(printed(`${LINE}${body}b ()`), ['2 east'])

  // Only when there is a default for every field, or the count would be inventing values.
  const errors = errorsIn('defrecord p (int n)\ndefblock b (p[] ps = ()) => {}\nb (ps 3)')
  assert.match(errors[0].message, /a count only says how many/)
})

test('a field is a slot: unknown names and wrong types read the same way', () => {
  const body = 'defblock b (line[] ls = 1) => {}\n'
  assert.match(errorsIn(`${LINE}${body}b (ls (dirr west))`)[0].message, /'line' has no slot 'dirr'/)
  assert.match(errorsIn(`${LINE}${body}b (ls (dir 3))`)[0].message, /dir expects direction/)
  assert.match(
    errorsIn(`${LINE}defblock b (line[] ls = 1) => { print (ls[0].direction) }\nb ()`)[0].message,
    /'line' has no field '.direction'/,
  )
})

test('a record travels: a variable, another block, a field of its own', () => {
  const source = `${LINE}defblock inner (line[] ls = 1) => { print (ls[0].dir) }
defblock outer (line[] ls = 1) => { inner (ls ls) }
outer (ls (dir south))`
  assert.deepEqual(printed(source), ['south'])

  const nested = `defrecord inner (int k = 1)
defrecord outer (inner part = (), text t = "x")
defblock b (outer o = ()) => { print (o.part.k, o.t) }
b (o (part (k 7)))`
  assert.deepEqual(printed(nested), ['7 x'])
  // `()` in a default is the record at its own defaults, since a literal cannot be written there.
  assert.deepEqual(printed(`${nested.split('\nb (o')[0]}\nb ()`), ['1 x'])
})

test('a record cannot hold one of its own kind, however far around', () => {
  assert.match(errorsIn('defrecord a (a x = ())')[0].message, /contains itself/)
  assert.match(errorsIn('defrecord a (b y = ())\ndefrecord b (a x = ())')[0].message, /contains itself/)
  assert.match(errorsIn('defrecord a (int n = 1)\ndefrecord a (int n = 1)')[0].message, /defined twice/)
})

test('content can arrive as a value, which is the only way a field can carry it', () => {
  const source = `${LINE}defblock b (line[] ls = 1) => {
  for l, i in ls => { belt (from (0, i) to (3, i), content l.content) }
}
b (ls (dir east, content (coal)))`
  const { scene } = run(source)
  const belts = scene.entities.filter((e) => e.proto.kind === 'belt')
  assert.equal(belts.length, 4)
  assert.deepEqual(belts[0].content, [{ item: 'coal' }])
})

test('an index reads one item out of a list, and says so when there is none', () => {
  assert.deepEqual(printed('def xs = (10, 20, 30)\nprint (xs[1], xs[2])'), ['20 30'])
  // A coordinate is a list of two, so it indexes as well as it takes .x and .y.
  assert.deepEqual(printed('def c = (3, 7)\nprint (c[0], c.y)'), ['3 7'])

  const { diagnostics } = compileFor('def xs = (1, 2)\nprint (xs[5])')
  assert.match(diagnostics[0].message, /outside a list of 2/)
  assert.match(errorsIn('def n = 3\nprint (n[0])')[0].message, /int cannot be indexed/)
})

test('a loop can count its own passes', () => {
  assert.deepEqual(printed('for x, i in (10, 20) => { print (i, x) }'), ['0 10', '1 20'])
  // The layout form folds the same loop in, and hands over the same index.
  const laid = run(`row (gap 0) for x, i in (10, 20, 30) => {
    print (i, x)
    steel-chest ()
  }`)
  assert.deepEqual(laid.output, ['0 10', '1 20', '2 30'])
  assert.deepEqual(laid.scene.entities.map((e) => e.x), [0, 1, 2])
})

test('every entity remembers the path it was placed by', () => {
  const laid = run(`defblock cell (int n) => {
  row for i in 0..n => { steel-chest () }
}

cell (n 3)
cell (at (0, 5), n 2)
steel-chest (at (0, 9))`)

  const path = (entity) =>
    (entity.trace?.steps ?? [])
      .map((step) => (step.kind === 'loop' ? `${step.name}=${step.at}/${step.of}` : `${step.name}()@${step.loc.line}`))
      .join(' ')

  const all = laid.scene.entities
  assert.equal(all.length, 6)

  // Two calls of one block, told apart by where each was called from — which is the whole
  // point: nothing else about the two rows differs.
  assert.deepEqual(all.slice(0, 3).map(path), ['cell()@5 i=0/3', 'cell()@5 i=1/3', 'cell()@5 i=2/3'])
  assert.deepEqual(all.slice(3, 5).map(path), ['cell()@6 i=0/2', 'cell()@6 i=1/2'])

  // A statement at the top of the file came by no path at all, and says so.
  assert.deepEqual(all[5].trace.steps, [])

  // The frame is stamped too: the second call was placed five tiles down, and a tile on
  // screen has to be read back through that to mean anything in the source.
  assert.deepEqual(all[0].trace.origin, { x: 0, y: 0 })
  assert.deepEqual(all[3].trace.origin, { x: 0, y: 5 })

  // And every one of them knows the line it was written on.
  assert.deepEqual([...new Set(all.map((e) => e.loc.line))], [2, 7])
})

test('a belt drawn on the map covers the tiles the compiler places on', () => {
  // The studio draws its ghost from `walkPath` and the compiler places from the same call, so
  // this is the promise that a preview is a promise: one corner, six tiles, no diagonals.
  const corners = [{ x: 3, y: 2 }, { x: 6, y: 2 }, { x: 6, y: 4 }]
  const tiles = walkPath(corners)
  assert.deepEqual(tiles, [
    { x: 3, y: 2 }, { x: 4, y: 2 }, { x: 5, y: 2 },
    { x: 6, y: 2 }, { x: 6, y: 3 }, { x: 6, y: 4 },
  ])

  const scene = run('belt (from (3, 2), via ((6, 2)), to (6, 4))').scene
  assert.deepEqual(scene.entities.map((e) => ({ x: e.x, y: e.y })), tiles)

  // A diagonal leg is not a belt, and comes back as nothing rather than as a guess.
  assert.equal(walkPath([{ x: 0, y: 0 }, { x: 2, y: 3 }]), undefined)
})

test('what is written can be changed by pointing at it; what is worked out cannot', () => {
  const source = `defblock pair (recipe r) => {
  row for i in 0..2 => { assembling-machine-3 (recipe r, dir south) }
}

assembling-machine-3 (at (0, 0), recipe iron-gear-wheel, dir north)
steel-chest ()
pair (at (0, 5), r electronic-circuit)`

  const scene = run(source).scene
  const [inner, other, plain, chest] = [scene.entities[2], scene.entities[3], scene.entities[0], scene.entities[1]]

  // A literal standing in the call is replaced where it stands.
  const replace = planSlotEdit(plain, 'recipe', 'iron-plate')
  assert.equal(refused(replace), false)
  assert.equal(replace.kind, 'replace')
  assert.match(applyEdit(source, replace).split('\n')[4], /recipe iron-plate, dir north/)

  // A slot the call never mentioned is added, before the bracket that closes it.
  const insert = planSlotEdit(plain, 'quality', 'legendary')
  assert.equal(insert.kind, 'insert')
  assert.match(applyEdit(source, insert).split('\n')[4], /dir north, quality legendary\)$/)

  // …and into empty brackets without a comma nobody wrote.
  assert.match(applyEdit(source, planSlotEdit(chest, 'quality', 'rare')).split('\n')[5], /^steel-chest \(quality rare\)$/)

  // A value handed in by name is not a literal, however much it looks like one: replacing the
  // text would rename the parameter and change every entity the block makes.
  const handed = planSlotEdit(inner, 'recipe', 'iron-plate')
  assert.equal(refused(handed), true)
  assert.match(handed.reason, /'r'/)

  // A position is a tuple, so there is no one token to put another in the place of.
  assert.equal(refused(planSlotEdit(plain, 'at', '(9, 9)')), true)

  // The call as written, brackets and all — what Ctrl+C on the map puts on the clipboard.
  assert.equal(callText(source, plain.trace.call), 'assembling-machine-3 (at (0, 0), recipe iron-gear-wheel, dir north)')
  assert.equal(callText(source, chest.trace.call), 'steel-chest ()')

  // And the count of what a change would take with it, which is what the reader is warned by.
  // Runs, not entities: a loop read twice is two, and a belt of many tiles laid once is one.
  assert.equal(sharedWith(scene.entities, plain), 1)
  assert.equal(sharedWith(scene.entities, inner), 2)
  assert.equal(sharedWith(scene.entities, other), 2)

  const laid = run('belt (from (0, 0), to (12, 0))').scene.entities
  assert.equal(laid.length, 13)
  assert.equal(sharedWith(laid, laid[6]), 1, 'thirteen tiles, one belt, one thing to remove')
})

test('an entity can be taken off the map when its statement made only it', () => {
  const source = `defblock pair (recipe r) => {
  row for i in 0..2 => { assembling-machine-3 (recipe r, dir south) }
}

assembling-machine-3 (at (0, 0), recipe iron-gear-wheel)
belt (from (0, 6), to (4, 6))
pair (at (0, 9), r electronic-circuit)`

  const entities = run(source).scene.entities
  const of = (name, line) => entities.find((e) => e.proto.name === name && e.loc.line === line)

  // A statement alone on its line goes, and takes the line with it.
  const plan = planRemove(of('assembling-machine-3', 5), sharedWith(entities, of('assembling-machine-3', 5)))
  assert.equal(refused(plan), false)
  const without = applyEdit(source, plan)
  assert.equal(without.includes('iron-gear-wheel'), false)
  assert.equal(without.split('\n').length, source.split('\n').length - 1)

  // A belt is one statement however many tiles it laid, so it goes whole.
  const belt = of('express-transport-belt', 6) ?? entities.find((e) => e.loc.line === 6)
  const gone = applyEdit(source, planRemove(belt, sharedWith(entities, belt)))
  assert.equal(gone.includes('belt (from'), false)

  // One out of a loop is the same argument as editing one out of a loop: there is no way to
  // say it, so it is refused rather than written around.
  const inLoop = entities.find((e) => e.loc.line === 2)
  const refusal = planRemove(inLoop, sharedWith(entities, inLoop))
  assert.equal(refused(refusal), true)
  assert.match(refusal.reason, /made 2 of these/)
})

test('after a label, brackets make a list — and say so when they were meant to group', () => {
  const errors = errorsIn('assembling-machine-3 (at (0, 0), recipe iron-gear-wheel, modules (repeat (2, speed-module-3)))')
  assert.match(errors[0].message, /modules expects module\[\]/)
  assert.match(errors[0].hint ?? '', /drop the outer brackets/)
})

test('the schema that asked for all this builds', () => {
  const source = `defrecord line (direction dir = east, item[] content = ())

defblock through-factory-line (
  entity factory = assembling-machine-1,
  recipe r,
  int n = 4,
  line[] lines = 1,
  entity inserter-in = bulk-inserter,
  entity inserter-out = bulk-inserter,
  module[] mods = ()
) => {
  def h = height (factory)
  def w = width (factory)
  def e = (w + 3) * n - 2

  if (count (lines) > h) => { throw "lines should be less or equal then factory height" }

  row (gap 2) for i in 0..n => {
    at (0, 0) => {
      factory (at (1, 0), recipe r, modules mods)
      for l, j in lines => { inserter-in (at (0, h - j - 1), east) }
      inserter-out (at (1, -1))
    }
  }

  for l, j in lines => {
    def y = h - j - 1
    belt (from (l.dir == east ? -1 : e, y) to (l.dir == east ? e : -1, y), content l.content)
  }
}

through-factory-line (
  at (4, -14),
  r quality-module-3,
  factory electromagnetic-plant,
  lines (dir west, content (speed-module-2)),
  inserter-out fast-inserter,
  n 2,
  mods repeat (5, speed-module-2)
)`
  const { scene } = run(source)
  const belts = scene.entities.filter((e) => e.proto.kind === 'belt')
  // One line, running west, carrying what the record said.
  assert.ok(belts.length > 0)
  assert.ok(belts.every((b) => b.dir === 12))
  assert.deepEqual(belts[0].content, [{ item: 'speed-module-2' }])
})
