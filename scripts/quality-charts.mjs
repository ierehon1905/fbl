#!/usr/bin/env node
/**
 * The numbers behind `docs/quality-strategy.md`, worked out by the calculator itself.
 *
 * The question the document answers — invest in quality early, or scale first and rush it
 * later — is one the recycling tab can settle with arithmetic rather than opinion, so nothing
 * here is typed in by hand: every figure comes out of `planQuality`, and the unlock table comes
 * out of the dataset's own technology recipes. Re-run it and the charts move with the data.
 *
 * It writes a JSON blob; `scripts/quality-charts.py` draws it. The two are split because
 * matplotlib is the one thing in this repository that is not JavaScript, and keeping the
 * modelling on this side means the drawing has no opinions in it.
 *
 *   npm run charts
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ProtoRegistry, planQuality, spread } from '../dist-node/core.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE = { id: '2x1', label: 'Space Age 2.1', directionScale: 2, moduleFormat: 'items-array', supportsQuality: true }

/** The item everything is measured in: cheap, universal, and what anybody farms first. */
const RECIPE = 'electronic-circuit'
const TARGETS = ['uncommon', 'rare', 'epic', 'legendary']

/**
 * Five points on the way from "quality modules exist" to "the endgame farm", each one a real
 * configuration rather than a curve: the machine, its slots, and what is in them.
 */
const SETUPS = [
  { key: 'q1', label: 'Q1 · assembler 2', machine: 'assembling-machine-2', module: 'quality-module', slots: 2 },
  { key: 'q2', label: 'Q2 · assembler 3', machine: 'assembling-machine-3', module: 'quality-module-2', slots: 4 },
  { key: 'q3a', label: 'Q3 · assembler 3', machine: 'assembling-machine-3', module: 'quality-module-3', slots: 4 },
  { key: 'q3em', label: 'Q3 · EM plant', machine: 'electromagnetic-plant', module: 'quality-module-3', slots: 5 },
  { key: 'q3L', label: 'Q3 legendary · EM plant', machine: 'electromagnetic-plant', module: 'quality-module-3', slots: 5, quality: 'legendary' },
]

const raw = JSON.parse(await readFile(join(ROOT, 'public/data/2x1/data.json'), 'utf8'))
const registry = new ProtoRegistry(raw, PROFILE)
const tiers = registry.qualities

const mods = (name, count, quality) => Array.from({ length: count }, () => ({ name, quality }))
const everyRung = (side) => Object.fromEntries(tiers.map((tier) => [tier, side]))

const ladder = (setup, target, { recyclers = true } = {}) =>
  planQuality(
    registry,
    {
      recipe: RECIPE,
      base: 'normal',
      target,
      crafters: everyRung({ machine: setup.machine, modules: mods(setup.module, setup.slots, setup.quality) }),
      // A recycler with nothing in it still shreds; it just never upgrades anything.
      recyclers: everyRung(recyclers ? { modules: mods(setup.module, 4, setup.quality) } : {}),
    },
    { machines: 20 },
  )

const out = { recipe: RECIPE, setups: SETUPS.map(({ key, label }) => ({ key, label })), targets: TARGETS, chance: {}, cost: {}, machines: {}, loop: {} }

for (const setup of SETUPS) {
  out.cost[setup.key] = {}
  out.machines[setup.key] = {}
  out.loop[setup.key] = {}

  for (const target of TARGETS) {
    const full = ladder(setup, target)
    const bare = ladder(setup, target, { recyclers: false })

    // Before Fulgora there is no recycler at all, and then a ladder is not a ladder: what you
    // get is the roll and nothing else. That is not a plan the model can make, so it is worked
    // out from the roll directly — everything at or above the target, times what the machine's
    // own productivity adds.
    const at = tiers.indexOf(target)
    const productivity = full.tiers[0].items / (full.tiers[0].crafts || 1)
    const direct = spread(full.craftChance, 0, tiers.length).slice(at).reduce((sum, share) => sum + share, 0) * productivity

    out.chance[setup.key] = full.craftChance
    out.cost[setup.key][target] = 1 / full.yield
    out.machines[setup.key][target] =
      full.output > 0 ? full.tiers.reduce((sum, tier) => sum + tier.crafters + tier.recyclers, 0) / (full.output * 60) : null
    out.loop[setup.key][target] = { full: 1 / full.yield, bare: 1 / bare.yield, none: 1 / direct }
  }
}

// What a farm of a fixed size actually eats, which is the part that decides when to build one.
out.farm = {}
for (const key of ['q3em', 'q3L']) {
  const setup = SETUPS.find((each) => each.key === key)
  const plan = planQuality(
    registry,
    {
      recipe: RECIPE,
      base: 'normal',
      target: 'legendary',
      crafters: everyRung({ machine: setup.machine, modules: mods(setup.module, setup.slots, setup.quality) }),
      recyclers: everyRung({ modules: mods(setup.module, 4, setup.quality) }),
    },
    { output: 1 },
  )
  out.farm[key] = {
    label: setup.label,
    ingredients: Object.fromEntries([...plan.ingredients].map(([item, rate]) => [item, rate * 60])),
    crafters: plan.tiers.reduce((sum, tier) => sum + tier.crafters, 0),
    recyclers: plan.tiers.reduce((sum, tier) => sum + tier.recyclers, 0),
  }
}

/**
 * The other way to make a legendary: not one recipe re-rolled through a recycler, but a chain
 * of machines with quality modules in every one of them, from the drill down.
 *
 * Quality carries through a craft — legendary plates make legendary gears — and a machine's
 * modules can bump what it was fed one tier further. So a chain is a row of lotteries on the
 * same material, and the shares compound with its length. `spread` already knows where a roll
 * from a given tier lands; this is that, applied over and over, with no recycler anywhere.
 */
const chainStep = (distribution, chance) => {
  const next = new Array(tiers.length).fill(0)
  for (const [from, share] of distribution.entries()) {
    if (share <= 0) continue
    for (const [to, part] of spread(chance, from, tiers.length).entries()) next[to] += share * part
  }
  return next
}

out.chainSteps = [1, 2, 3, 4, 5, 6]
out.chain = []
for (const [chance, label] of [[0.02, 'Q1 ×2'], [0.10, 'Q3 ×4'], [0.125, 'Q3 ×5'], [0.25, 'Q3 legendary ×4'], [0.3125, 'Q3 legendary ×5']]) {
  let distribution = tiers.map((_, at) => (at === 0 ? 1 : 0))
  const legendary = []
  for (const _ of out.chainSteps) {
    distribution = chainStep(distribution, chance)
    legendary.push(distribution[tiers.length - 1])
  }
  out.chain.push({ label, chance, legendary })
}

/**
 * What a quality machine is worth as a way of building a bigger factory, against the obvious
 * alternative: spending the same materials on more ordinary machines.
 *
 * A quality machine is faster — an assembling machine 3 goes 1.25 → 3.125 by the top tier — and
 * the ladder says what one costs. The comparison is the whole "is early quality an investment"
 * question in one ratio.
 */
const machine = registry.machines.get('assembling-machine-3')
out.speed = tiers.map((tier) => (tier === 'normal' ? machine.speed : machine.qualityRecord?.[tier]?.speed ?? machine.speed))
out.perMaterial = {}
for (const key of ['q1', 'q3L']) {
  out.perMaterial[key] = tiers.map((tier, at) => {
    if (at === 0) return 1
    const cost = out.cost[key][tier]
    // Throughput bought per unit of material, against one bought by building more of the plain
    // machine. Above 1 quality would be the cheaper way to grow; it never is.
    return out.speed[at] / out.speed[0] / cost
  })
}

// When each step of quality becomes possible at all, read off the technology recipes.
const science = (id) => Object.keys(raw.recipes.find((recipe) => recipe.id === id)?.in ?? {})
out.unlocks = [
  ['Quality module 1', science('quality-module-technology')],
  ['Quality module 2', science('quality-module-2-technology')],
  ['Quality module 3', science('quality-module-3-technology')],
  ['Epic tier', science('epic-quality')],
  ['Legendary tier', science('legendary-quality')],
]
out.packs = [
  'automation-science-pack', 'logistic-science-pack', 'military-science-pack', 'chemical-science-pack',
  'production-science-pack', 'utility-science-pack', 'space-science-pack', 'metallurgic-science-pack',
  'agricultural-science-pack', 'electromagnetic-science-pack', 'cryogenic-science-pack', 'promethium-science-pack',
]

const where = join(ROOT, 'docs/images/quality-strategy.json')
await writeFile(where, JSON.stringify(out, null, 1))
console.log(`one legendary ${RECIPE} costs, in sets of ingredients:`)
for (const setup of SETUPS) console.log(`   ${setup.label.padEnd(26)} ${out.cost[setup.key].legendary.toFixed(1)}`)
console.log(`\nwritten to ${where}`)
