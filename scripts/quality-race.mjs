#!/usr/bin/env node
/**
 * Two players, one clock: does bothering with quality from the start ever pay?
 *
 * Player A takes quality seriously from the first quality module — modules in the chain,
 * modules in the drills, upgraded as the tech allows. Player B ignores it entirely, builds
 * and researches, and only converts once the legendary tier is unlocked.
 *
 * Everything about *quality* here is read from the game data: what a module gives, what a
 * machine's slots are, what a ladder yields, and how a chain of moduled machines compounds.
 * Everything about *time* is a dial, because the dataset has no research costs and no build
 * rates — a technology recipe lists its science packs and not how many units of research it
 * takes. So the clock below is a model, and it is stated rather than implied:
 *
 *   - a factory grows by reinvesting what it makes, which is exponential;
 *   - research is a fixed share of output, and the gates are fractions of the way to legendary;
 *   - a player converting to quality diverts a fixed share of output into it.
 *
 * The ordering the model produces does not depend on those dials, and `sweep` is the proof:
 * every setting of them that was tried puts B ahead, because nothing A does before the gate
 * produces a legendary item and all of it slows the research that opens the gate.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = JSON.parse(await readFile(join(ROOT, 'docs/images/quality-strategy.json'), 'utf8'))

/** Read from the data by `quality-charts.mjs`: sets of ingredients per legendary item. */
const COST = {
  ordinary: DATA.cost.q3em.legendary, // a farm on ordinary quality 3 modules
  legendary: DATA.cost.q3L.legendary, // the same farm once its modules are legendary
}
/** What a machine gives up to hold quality modules instead of productivity ones. */
const PRODUCTIVITY = 0.04 // productivity module 1, per slot, from the module data
const SLOTS = 2 // assembling machine 2, the machine of that era

/** Research thresholds, as fractions of the way to the legendary tier. */
const GATES = { quality1: 0.02, quality2: 0.25, quality3: 0.55, legendary: 1 }

/**
 * Everything below runs on one clock and one unit: a factory's size is what it turns out in an
 * *hour*, and the step is in hours too, so nothing needs converting until it is displayed.
 */
const DIALS = {
  hours: 260,
  step: 0.05,
  /** New factory per hour per unit of output reinvested — the growth rate. */
  reinvest: 0.075,
  /** Share of output going into science. */
  science: 0.15,
  /** Research needed to reach the legendary tier, in the same units science is produced in. */
  research: 54000,
  /** A: how much of the factory runs quality modules rather than productivity ones. */
  moduled: 0.6,
  /** A: how much output goes into building and running the quality chain, from the first module. */
  earlyQuality: 0.15,
  /** Both: how much output goes into the farm once the legendary tier is open. */
  lateQuality: 0.5,
  /** Legendary modules needed to convert a farm, per unit of output pointed at it. */
  moduleStock: 40,
}

function race(dials = DIALS) {
  const { step } = dials
  const player = (name, early) => ({
    name,
    early,
    factory: 1,
    research: 0,
    modules: 0,
    legendary: 0,
    banked: 0, // items above normal made before the legendary tier — what A has to show for it
    gate: null,
  })

  const A = player('A · quality from the start', true)
  const B = player('B · scale first, convert late', false)
  const series = []

  for (let t = 0; t <= dials.hours; t += step) {
    for (const p of [A, B]) {
      const open = p.research >= dials.research
      if (open && p.gate === null) p.gate = t

      // Holding quality modules means not holding productivity ones, and that is the standing
      // cost of A's strategy: the same machines turn less material into product all game.
      const forgone = p.early && !open ? dials.moduled * PRODUCTIVITY * SLOTS : 0
      const output = p.factory * (1 - forgone)

      const toQuality = open ? dials.lateQuality : p.early && p.research > dials.research * GATES.quality1 ? dials.earlyQuality : 0
      const toScience = dials.science * output
      const toGrowth = output - toScience - toQuality * output

      p.research += toScience * step
      p.factory += dials.reinvest * toGrowth * step

      const spend = toQuality * output
      if (open) {
        // The takeoff is the farm feeding itself better modules: it starts on ordinary quality
        // 3s at 246 sets an item and ends on legendary ones at 29.6, and everything in between
        // is the stock it has built so far.
        const need = dials.moduleStock * spend
        const filled = need > 0 ? Math.min(1, p.modules / need) : 1
        const yieldNow = 1 / COST.ordinary + filled * (1 / COST.legendary - 1 / COST.ordinary)
        const made = spend * yieldNow
        // Modules first, product second, until the farm is holding what it needs.
        const toModules = filled < 1 ? made * 0.5 : 0
        p.modules += toModules * step
        p.legendary += (made - toModules) * step
        p.rate = made - toModules
      } else {
        // Nothing legendary exists yet. What the early player is making is uncommon and rare,
        // and it is worth counting so the comparison is not rigged: it is real, it is just not
        // the thing being raced for.
        p.banked += spend * (1 / DATA.cost.q1.uncommon) * step
        p.rate = 0
      }
    }

    if (Math.abs(t / 0.5 - Math.round(t / 0.5)) < 1e-9) {
      series.push({
        t: Number(t.toFixed(2)),
        factoryA: A.factory, factoryB: B.factory,
        rateA: A.rate / 60, rateB: B.rate / 60,
        totalA: A.legendary, totalB: B.legendary,
        bankedA: A.banked, bankedB: B.banked,
      })
    }
  }

  return { series, gateA: A.gate, gateB: B.gate, bankedA: A.banked, bankedB: B.banked }
}

const run = race()

// Does the answer depend on the dials? Try the ones that could plausibly be argued about.
const sweep = []
for (const earlyQuality of [0.05, 0.15, 0.3]) {
  for (const reinvest of [0.05, 0.075, 0.12]) {
    for (const moduled of [0.3, 0.6, 1]) {
      const one = race({ ...DIALS, earlyQuality, reinvest, moduled })
      const last = one.series[one.series.length - 1]
      sweep.push({
        earlyQuality, reinvest, moduled,
        gateA: one.gateA, gateB: one.gateB,
        aheadHours: one.gateA !== null && one.gateB !== null ? Number((one.gateA - one.gateB).toFixed(1)) : null,
        ratio: last.totalB > 0 ? Number((last.totalA / last.totalB).toFixed(3)) : null,
      })
    }
  }
}

const out = { dials: DIALS, gates: GATES, cost: COST, ...run, sweep }
await writeFile(join(ROOT, 'docs/images/quality-race.json'), JSON.stringify(out, null, 1))

const last = run.series[run.series.length - 1]
console.log(`B opens the legendary tier at ${run.gateB?.toFixed(1)}h, A at ${run.gateA?.toFixed(1)}h`)
console.log(`after ${DIALS.hours}h: A has ${last.totalA.toFixed(0)} legendary items, B has ${last.totalB.toFixed(0)}`)
console.log(`   rates at the end: A ${last.rateA.toFixed(1)}/min, B ${last.rateB.toFixed(1)}/min`)
console.log(`   factories: A ${last.factoryA.toFixed(0)}, B ${last.factoryB.toFixed(0)} (B is ${(last.factoryB / last.factoryA).toFixed(2)}× bigger)`)
console.log(`A also banked ${run.bankedA.toFixed(0)} uncommon items on the way`)
console.log(`sweep: A ahead in ${sweep.filter((s) => s.ratio > 1).length} of ${sweep.length} settings`)
