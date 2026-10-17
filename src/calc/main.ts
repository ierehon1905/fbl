import {
  ProtoRegistry,
  bestMachine,
  consumersOf,
  loopRecipeFor,
  planQuality,
  recipeGraph,
  solve,
  type QualityPlan,
  type QualitySetup,
  type Solution,
} from '../core'
import { loadDataset } from '../data/loader'
import { fetchBytes } from '../data/progress'
import { DEFAULT_VERSION, VERSIONS, versionById } from '../data/versions'
import type { IconSheet } from '../ui/icons'
import type { SankeyLayout } from '../ui/sankey'
import '../ui/base.css'
import './style.css'

import { cardHtml, machineShare, type CardContext } from './cards'
import { bindZoomPan, clamp, drawDiagram, fitView, type DiagramRefs, type DiagramView } from './diagram'
import { perMinute, qualityCard, qualityDiagram, type QualityContext } from './quality-view'
import { qualityRailHtml } from './quality-rail'
import { railHtml, type RailContext } from './rail'
import { labelOf as labelOfItem } from './view'
import { beltOptions, itemOptions, machineOptions, moduleOptions, qualityOptions, recipeOptions } from './options'
import { openPicker, type PickerOption } from '../ui/picker'
import { emptyState, readLink, readState, rungOf, setNode, setRung, settingsOf, writeLink, writeState, type CalcState } from './state'
import { diagramOf, type Carrier } from './view'

/**
 * The calculator page.
 *
 * It holds one piece of state — what you asked for and every choice you have made — and one
 * pipeline: solve it, turn it into a diagram, draw it. Every control on the page does the
 * same thing, which is change one field and run that pipeline again. There is nothing
 * incremental here on purpose; a whole plan solves in milliseconds, and a rebuild that cannot
 * disagree with itself is worth more than one that is quick.
 */

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id)
  if (!found) throw new Error(`#${id} is missing from calc.html`)
  return found as T
}

const dom = {
  rail: el('rail'),
  stage: el('stage'),
  frame: el('board'),
  svg: el<HTMLElement>('ribbons') as unknown as SVGSVGElement,
  cards: el('cards'),
  empty: el('empty'),
  version: el<HTMLSelectElement>('version'),
  stats: el('stats'),
  fit: el<HTMLButtonElement>('fit'),
  share: el<HTMLButtonElement>('share'),
  zoom: el('zoom'),
  tabs: el('tabs'),
  loading: el('loading'),
}

const refs: DiagramRefs = { stage: dom.stage, frame: dom.frame, svg: dom.svg, cards: dom.cards }

let state: CalcState = readLink(DEFAULT_VERSION.id) ?? readState(DEFAULT_VERSION.id)
let registry: ProtoRegistry | null = null
let sheet: IconSheet | null = null
let solution: Solution | null = null
/** Kept so the pickers can read the ladder back without solving it again. */
let quality: QualityPlan | null = null
void quality
let layout: SankeyLayout | null = null
/** Bumped on every dataset load so a slow one cannot clobber a newer one. */
let generation = 0
/** The last fragment this page wrote, so a change from anywhere else can be told apart. */
let ourLink = ''

/**
 * Where you are looking, as one object that is never replaced.
 *
 * Panning holds on to this and writes into it as the pointer moves, so anything that swaps it
 * for a fresh object — fitting, the zoom buttons, following a link — would leave the pan
 * writing into something nothing else reads. That showed up as a drag after a fit snapping the
 * zoom back to whatever it was when the page loaded.
 */
const view: DiagramView = { ...state.view }
state.view = view

// ── The pipeline ──────────────────────────────────────────────────────────────

function carrierOf(reg: ProtoRegistry): Carrier {
  return {
    belt: reg.entities.get(state.belt)?.beltSpeed ?? 15,
    isFluid: (item) => reg.fluids.has(item),
  }
}

function rebuild(refit = false): void {
  if (!registry) return
  for (const button of dom.tabs.querySelectorAll<HTMLElement>('[data-mode]')) {
    button.classList.toggle('active', button.dataset.mode === state.mode)
  }
  if (state.mode === 'recycling') return rebuildQuality(registry, refit)

  const graph = recipeGraph(registry)
  solution = solve(registry, state)

  const carrier = carrierOf(registry)
  const model = diagramOf(solution, carrier)
  const ctx: CardContext = { registry, graph, sheet, state, carrier, solution }

  dom.empty.hidden = model.cards.length > 0
  layout = drawDiagram(refs, model, {
    registry,
    sheet,
    carrier,
    card: (card) => cardHtml(card, ctx),
    note: (flow, split) => machineShare(flow, ctx, split),
  })

  const rail: RailContext = { registry, sheet, state, solution, carrier }
  dom.rail.innerHTML = railHtml(rail)

  const machines = solution.nodes.reduce((sum, node) => sum + Math.ceil(node.machines - 1e-6), 0)
  dom.stats.textContent = solution.nodes.length
    ? `${solution.nodes.length} recipes · ${machines} machines${solution.shortfalls.length ? ` · ${solution.shortfalls.length} short` : ''}`
    : ''

  writeState(state)
  ourLink = writeLink(state)
  if (refit && layout) applyView(fitView(refs, layout, view))
}

function rebuildQuality(reg: ProtoRegistry, refit: boolean): void {
  const held = state.quality
  const recipe = ladderRecipe(reg) ?? ''

  const setup: QualitySetup = {
    recipe,
    item: held.item || undefined,
    base: held.base,
    target: held.target,
    crafters: held.crafters,
    recyclers: held.recyclers,
  }

  const plan = planQuality(reg, setup, held.by === 'machines' ? { machines: held.machines } : { output: held.output / 60 })
  quality = plan
  solution = null

  const item = held.item || Object.keys(reg.recipes.get(recipe)?.out ?? {})[0] || ''
  const carrier = carrierOf(reg)
  const ctx: QualityContext = { registry: reg, sheet, carrier, setup, plan, item }
  const model = held.item && !plan.problem ? qualityDiagram(ctx) : { cards: [], nodes: [], links: [], flows: new Map() }

  dom.empty.hidden = model.cards.length > 0
  layout = drawDiagram(
    refs,
    model,
    { registry: reg, sheet, carrier, card: (card) => qualityCard(card, ctx), rate: perMinute },
    // The rungs are narrow boxes in fixed columns, so they can sit closer together.
    { nodeWidth: 176, columnGap: 120 },
  )
  dom.rail.innerHTML = qualityRailHtml({ registry: reg, sheet, settings: held, plan, item })

  dom.stats.textContent = plan.problem
    ? ''
    : plan.output > 0
      ? `${(plan.output * 60).toFixed(1)} ${held.target} a minute`
      : ''

  writeState(state)
  ourLink = writeLink(state)
  if (refit && layout) applyView(fitView(refs, layout, view))
}

function applyView(next: DiagramView): void {
  Object.assign(view, next)
  dom.frame.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`
  writeState(state)
}

// ── Controls ──────────────────────────────────────────────────────────────────

/**
 * Everything that is chosen is chosen the same way: a control on the page says what kind of
 * thing it wants, and this decides what to offer and what to do with the answer.
 */
function openFor(button: HTMLElement): void {
  if (!registry) return
  const reg = registry
  const graph = recipeGraph(reg)
  const kind = button.dataset.pickOpen
  const id = button.dataset.for ?? ''
  const sheet_ = sheet

  const show = (title: string, options: PickerOption[], chosen: string | undefined, onPick: (picked: string | null) => void, clear?: { label: string }) =>
    openPicker(button, { title, options, chosen, sheet: sheet_, clear, onPick })

  /** The tier row, where the version has tiers at all. */
  const tiers = (of: 'machine' | 'module', chosen: string, onPick: (id: string) => void) =>
    reg.profile.supportsQuality
      ? { label: 'quality', options: qualityOptions(reg, of), chosen, onPick }
      : undefined

  switch (kind) {
    case 'target':
      return show('What do you want', itemOptions(reg), undefined, (item) => {
        if (!item) return
        // One a second to start with; the number beside it in the list is where it is changed.
        state.targets = [...state.targets.filter((t) => t.item !== item), { item, rate: 1 }]
        rebuild(true)
      })

    case 'belt':
      return show('Counted in', beltOptions(reg), state.belt, (belt) => {
        if (!belt) return
        state.belt = belt
        rebuild()
      })

    case 'machine': {
      const recipe = graph.usable.get(id)
      const node = solution?.nodes.find((n) => n.recipe === id)
      if (!recipe) return

      return openPicker(button, {
        title: 'Which machine',
        options: machineOptions(reg, recipe),
        chosen: node?.machine,
        sheet: sheet_,
        quality: tiers('machine', settingsOf(state, id).quality ?? 'normal', (quality) => {
          setNode(state, id, { quality: quality === 'normal' ? undefined : quality })
          rebuild()
        }),
        onPick: (machine) => {
          // A different machine has different slots, so what was in the old ones cannot stand.
          setNode(state, id, { machine: machine ?? undefined, modules: undefined, beacon: undefined })
          rebuild()
        },
      })
    }

    case 'module': {
      const at = Number(button.dataset.slot ?? 0)
      const slot = settingsOf(state, id).modules?.[at]
      return openPicker(button, {
        title: 'Modules',
        options: moduleOptions(reg),
        chosen: slot?.name,
        sheet: sheet_,
        clear: { label: 'empty the slot' },
        everySlot: { label: 'every slot', on: everySlot, onToggle: (on) => (everySlot = on) },
        // The tier of what is in *this* slot, not a setting of the machine: one legendary
        // productivity module beside three ordinary ones is a real thing to build. A slot with
        // a module in it shows that module's tier — an ordinary one is ordinary, not whatever
        // was picked last — and only an empty slot offers the tier the next one would take.
        quality: tiers('module', slot ? (slot.quality ?? 'normal') : moduleQuality, (quality) => {
          moduleQuality = quality
          stampQuality(id, at, quality)
        }),
        onPick: (module) => setModule(id, at, module),
      })
    }

    case 'beacon-module': {
      const beacon = settingsOf(state, id).beacon
      const build = (module: string, quality: string) => {
        const slots = reg.beacons.get('beacon')?.modules ?? 2
        setNode(state, id, {
          beacon: {
            name: 'beacon',
            count: Math.max(1, beacon?.count ?? 1),
            quality: tierOf(quality),
            modules: Array.from({ length: slots }, () => ({ name: module, quality: tierOf(quality) })),
          },
        })
        rebuild()
      }

      return openPicker(button, {
        title: 'What is in the beacons',
        options: moduleOptions(reg),
        chosen: beacon?.modules[0]?.name,
        sheet: sheet_,
        clear: { label: 'no beacons' },
        // A beacon and what is in it are built together, so one tier settles both.
        quality: tiers('module', beacon?.quality ?? 'normal', (quality) => {
          if (beacon?.modules[0]?.name) build(beacon.modules[0].name, quality)
        }),
        onPick: (module) => {
          if (!module) return setNode(state, id, { beacon: undefined }), rebuild()
          build(module, beacon?.quality ?? 'normal')
        },
      })
    }

    case 'recipe':
      return show('How to make it', recipeOptions(reg, graph, graph.producers.get(id) ?? []), state.choice[id], (recipe) => {
        if (!recipe) return
        state.choice[id] = recipe
        rebuild()
      })

    case 'quality-item':
      return show('What are you farming', itemOptions(reg), state.quality.item, (item) => {
        if (!item) return
        // A different item is a different recipe and different machines, so what was said
        // about the old one's rungs goes with it.
        state.quality = { ...state.quality, item, recipe: undefined, crafters: {}, recyclers: {} }
        rebuild(true)
      })

    case 'quality-base':
    case 'quality-target': {
      const which = kind === 'quality-base' ? 'base' : 'target'
      return show(
        which === 'base' ? 'Ingredients start at' : 'Farming for',
        qualityOptions(reg, 'machine'),
        state.quality[which],
        (tier) => {
          if (!tier) return
          state.quality = { ...state.quality, [which]: tier }
          rebuild()
        },
      )
    }

    // ── One rung of the ladder ──────────────────────────────────────────────
    // `data-for` is the tier; which side it is comes from the kind. Every rung is settled on
    // its own card, which is where you are looking when you want to change it.
    case 'rung-machine': {
      const rung = rungOf(state.quality.crafters, id)
      const recipe = ladderRecipe(reg)
      const known = recipe ? reg.recipes.get(recipe) : undefined
      if (!known) return

      return openPicker(button, {
        title: `The ${id} assemblers`,
        options: machineOptions(reg, known),
        chosen: rung.machine ?? bestMachine(reg, known),
        sheet: sheet_,
        quality: tiers('machine', rung.quality ?? 'normal', (tier) => {
          setRung(state.quality.crafters, id, { quality: tier === 'normal' ? undefined : tier })
          rebuild()
        }),
        onPick: (machine) => {
          // A different machine has different slots, so what was in the old ones cannot stand.
          setRung(state.quality.crafters, id, { machine: machine ?? undefined, modules: undefined })
          rebuild()
        },
      })
    }

    case 'rung-recycler': {
      const rung = rungOf(state.quality.recyclers, id)
      return openPicker(button, {
        title: `The ${id} recyclers`,
        options: [
          {
            id: 'recycler',
            label: labelOfItem(reg, 'recycler'),
            detail: 'the only thing that shreds',
            icon: reg.icons.get('recycler'),
          },
        ],
        chosen: 'recycler',
        sheet: sheet_,
        quality: tiers('machine', rung.quality ?? 'normal', (tier) => {
          setRung(state.quality.recyclers, id, { quality: tier === 'normal' ? undefined : tier })
          rebuild()
        }),
        onPick: () => rebuild(),
      })
    }

    // ── Every rung at once ───────────────────────────────────────────────────
    // Nine machines with the same four modules in them is what a ladder nearly always is, and
    // filling them one slot at a time is thirty-six clicks to say one thing.
    case 'rung-fill': {
      const side = id === 'recyclers' ? 'recyclers' : 'crafters'
      const held = heldEverywhere(side)

      return openPicker(button, {
        title: side === 'recyclers' ? 'Every recycler' : 'Every assembler',
        options: moduleOptions(reg),
        chosen: held?.name,
        sheet: sheet_,
        clear: { label: 'empty them all' },
        quality: tiers('module', held?.quality ?? moduleQuality, (tier) => {
          moduleQuality = tier
          // Re-tier what is already in them, so the tier reads as a property of the modules
          // rather than of the next click.
          if (held?.name) fillRungs(side, held.name, tier)
        }),
        onPick: (module) => fillRungs(side, module, moduleQuality),
      })
    }

    case 'rung-module': {
      const side = button.dataset.side === 'recycler' ? 'recyclers' : 'crafters'
      const at = Number(button.dataset.slot ?? 0)
      const rung = rungOf(state.quality[side], id)
      const slot = rung.modules?.[at]

      return openPicker(button, {
        title: 'Modules',
        options: moduleOptions(reg),
        chosen: slot?.name,
        sheet: sheet_,
        clear: { label: 'empty the slot' },
        everySlot: { label: 'every slot', on: everySlot, onToggle: (on) => (everySlot = on) },
        quality: tiers('module', slot ? (slot.quality ?? 'normal') : moduleQuality, (tier) => {
          moduleQuality = tier
          stampRung(side, id, at, tier)
        }),
        onPick: (module) => setRungModule(side, id, at, module),
      })
    }

    case 'use':
      return show(
        'What to do with it',
        recipeOptions(reg, graph, consumersOf(graph, id)),
        state.extra[id],
        (recipe) => {
          if (recipe) state.extra[id] = recipe
          else delete state.extra[id]
          rebuild()
        },
        { label: 'leave it' },
      )
  }
}

/** How many module slots a rung's machine has. */
function rungSlots(side: 'crafters' | 'recyclers', tier: string): number {
  const rung = rungOf(state.quality[side], tier)
  const machine = side === 'recyclers' ? 'recycler' : (rung.machine ?? defaultCrafter())
  return machine ? (registry?.machines.get(machine)?.modules ?? 0) : 0
}

/**
 * The recipe the ladder runs on.
 *
 * Not the one a factory would be built with: what closes the loop is the recipe a recycler
 * reverses. Shredding nutrients hands back spoilage, so the ladder is built on the recipe made
 * *from* spoilage, whichever one is cheapest to run.
 */
function ladderRecipe(reg: ProtoRegistry): string | undefined {
  const held = state.quality
  if (held.recipe) return held.recipe
  if (!held.item) return undefined
  return loopRecipeFor(reg, held.item) ?? recipeGraph(reg).producers.get(held.item)?.[0]
}

/** The machine a rung runs when nobody has said otherwise: the best one for the recipe. */
function defaultCrafter(): string | undefined {
  if (!registry) return undefined
  const recipe = ladderRecipe(registry)
  const known = recipe ? registry.recipes.get(recipe) : undefined
  return known ? bestMachine(registry, known) : undefined
}

function setRungModule(side: 'crafters' | 'recyclers', tier: string, at: number, module: string | null): void {
  const slots = rungSlots(side, tier)
  const held = [...(rungOf(state.quality[side], tier).modules ?? [])]

  if (everySlot) {
    setRung(state.quality[side], tier, {
      modules: module ? Array.from({ length: slots }, () => ({ name: module, quality: tierOf(moduleQuality) })) : undefined,
    })
    return rebuild()
  }

  held.length = slots
  held[at] = module ? { name: module, quality: tierOf(moduleQuality) } : (undefined as never)
  const kept = held.filter(Boolean)
  setRung(state.quality[side], tier, { modules: kept.length ? kept : undefined })
  rebuild()
}

/**
 * What every rung on one side holds, when they all hold the same thing — and nothing when they
 * differ, because there is no one module to show for a mixed ladder.
 */
function heldEverywhere(side: 'crafters' | 'recyclers'): { name: string; quality?: string } | undefined {
  const tiers = registry?.qualities ?? []
  let same: { name: string; quality?: string } | undefined

  for (const tier of tiers) {
    const slots = rungSlots(side, tier)
    if (slots === 0) continue

    const modules = rungOf(state.quality[side], tier).modules ?? []
    if (modules.length !== slots) return undefined

    for (const module of modules) {
      if (!same) same = { name: module.name, quality: module.quality }
      else if (same.name !== module.name || same.quality !== module.quality) return undefined
    }
  }
  return same
}

/** The same module in every slot of every rung, which is the setup people actually build. */
function fillRungs(side: 'crafters' | 'recyclers', module: string | null, quality: string): void {
  for (const tier of registry?.qualities ?? []) {
    const slots = rungSlots(side, tier)
    setRung(state.quality[side], tier, {
      modules:
        module && slots > 0
          ? Array.from({ length: slots }, () => ({ name: module, quality: tierOf(quality) }))
          : undefined,
    })
  }
  rebuild()
}

function stampRung(side: 'crafters' | 'recyclers', tier: string, at: number, quality: string): void {
  const held = rungOf(state.quality[side], tier).modules
  if (!held?.length) return

  const built = tierOf(quality)
  setRung(state.quality[side], tier, {
    modules: everySlot
      ? held.map((module) => ({ ...module, quality: built }))
      : held.map((module, slot) => (slot === at ? { ...module, quality: built } : module)),
  })
  rebuild()
}

/** Whether picking a module fills the machine or only the slot that was clicked. */
let everySlot = true
/** The tier new modules are built to, until it is changed again. */
let moduleQuality = 'normal'

const tierOf = (quality: string) => (quality === 'normal' ? undefined : quality)

/**
 * Re-tiers what is already in the machine — every slot, or the one that was clicked.
 *
 * The toggle governs this as much as it governs which module: it says whether a choice made
 * here is about the machine or about the slot, and quality is a choice like any other. It used
 * to re-stamp everything whatever the toggle said, which made a mixed loadout impossible to
 * express.
 */
function stampQuality(recipe: string, at: number, quality: string): void {
  const held = settingsOf(state, recipe).modules
  if (!held?.length) return

  const tier = tierOf(quality)
  setNode(state, recipe, {
    modules: everySlot
      ? held.map((module) => ({ ...module, quality: tier }))
      : held.map((module, slot) => (slot === at ? { ...module, quality: tier } : module)),
  })
  rebuild()
}

function setModule(recipe: string, at: number, module: string | null): void {
  const slots = registry?.machines.get(solution?.nodes.find((n) => n.recipe === recipe)?.machine ?? '')?.modules ?? 0
  const held = [...(settingsOf(state, recipe).modules ?? [])]

  if (everySlot) {
    setNode(state, recipe, {
      modules: module
        ? Array.from({ length: slots }, () => ({ name: module, quality: tierOf(moduleQuality) }))
        : undefined,
    })
    return rebuild()
  }

  held.length = slots
  held[at] = module ? { name: module, quality: tierOf(moduleQuality) } : (undefined as never)
  const kept = held.filter(Boolean)
  setNode(state, recipe, { modules: kept.length ? kept : undefined })
  rebuild()
}

document.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-pick-open]')
  if (button) openFor(button)
})

dom.rail.addEventListener('change', (event) => {
  const target = event.target as HTMLElement

  if (target.id === 'quality-drive') {
    const value = Math.max(0, Number((target as HTMLInputElement).value))
    state.quality = { ...state.quality, [state.quality.by === 'machines' ? 'machines' : 'output']: value }
    return rebuild()
  }

  const at = target.closest<HTMLElement>('[data-target-rate]')?.dataset.targetRate
  if (at === undefined) return

  const rate = Number((target as HTMLInputElement).value)
  state.targets = state.targets.map((entry, i) => (i === Number(at) ? { ...entry, rate } : entry))
  rebuild()
})

dom.rail.addEventListener('click', (event) => {
  const target = event.target as HTMLElement

  const drop = target.closest<HTMLElement>('[data-target-drop]')?.dataset.targetDrop
  if (drop !== undefined) {
    state.targets = state.targets.filter((_, i) => i !== Number(drop))
    return rebuild()
  }

  const by = target.closest<HTMLElement>('[data-quality-by]')?.dataset.qualityBy
  if (by === 'machines' || by === 'output') {
    state.quality = { ...state.quality, by }
    return rebuild()
  }

  const step = target.closest<HTMLElement>('[data-quality-count]')
  if (step?.dataset.qualityCount) {
    return rebuild()
  }

  const forget = target.closest<HTMLElement>('[data-forget]')?.dataset.forget
  if (forget) {
    delete state.frontier[forget]
    return rebuild()
  }

  if (target.id === 'reset') {
    state = emptyState(state.version)
    state.view = view
    return rebuild(true)
  }
})

dom.cards.addEventListener('click', (event) => {
  const target = event.target as HTMLElement

  const expand = target.closest<HTMLElement>('[data-expand]')?.dataset.expand
  if (expand) {
    state.frontier[expand] = 'expand'
    return rebuild()
  }

  const collapse = target.closest<HTMLElement>('[data-collapse]')?.dataset.collapse
  if (collapse) {
    // Everything that was only there to feed this falls away with it, which is the point.
    state.frontier[collapse] = 'raw'
    return rebuild()
  }

  const step = target.closest<HTMLElement>('[data-beacon-step]')
  if (step?.dataset.beaconStep) {
    const recipe = step.dataset.beaconStep
    const held = settingsOf(state, recipe).beacon
    const count = Math.max(0, Math.min(12, (held?.count ?? 0) + Number(step.dataset.by ?? 1)))
    setNode(state, recipe, {
      beacon: count > 0 ? { name: 'beacon', count, modules: held?.modules ?? beaconModules() } : undefined,
    })
    return rebuild()
  }

  const pin = target.closest<HTMLElement>('[data-pin]')?.dataset.pin
  if (pin) {
    const node = solution?.nodes.find((n) => n.recipe === pin)
    const already = state.nodes[pin]?.pin !== undefined
    setNode(state, pin, { pin: already ? undefined : Math.ceil((node?.machines ?? 1) - 1e-6) })
    return rebuild()
  }
})

/** What goes in a beacon by default: the best speed module there is. */
function beaconModules() {
  const slots = registry?.beacons.get('beacon')?.modules ?? 2
  const best = [...(registry?.modules ?? [])]
    .filter((id) => (registry?.moduleEffects.get(id)?.speed ?? 0) > 0)
    .sort((a, b) => (registry!.moduleEffects.get(b)!.speed ?? 0) - (registry!.moduleEffects.get(a)!.speed ?? 0))[0]
  return best ? Array.from({ length: slots }, () => ({ name: best })) : []
}

dom.tabs.addEventListener('click', (event) => {
  const mode = (event.target as HTMLElement).closest<HTMLElement>('[data-mode]')?.dataset.mode
  if (!mode || mode === state.mode) return
  state.mode = mode as CalcState['mode']
  rebuild(true)
})

dom.zoom.addEventListener('click', (event) => {
  const how = (event.target as HTMLElement).dataset.zoom
  if (!how) return
  if (how === 'reset') return applyView({ ...view, scale: 1 })

  const box = dom.stage.getBoundingClientRect()
  const next = clamp(view.scale * (how === 'in' ? 1.25 : 0.8))
  applyView({
    scale: next,
    x: box.width / 2 - ((box.width / 2 - view.x) * next) / view.scale,
    y: box.height / 2 - ((box.height / 2 - view.y) * next) / view.scale,
  })
})

dom.fit.addEventListener('click', () => {
  if (layout) applyView(fitView(refs, layout, view))
})

dom.share.addEventListener('click', () => {
  void navigator.clipboard.writeText(window.location.href).then(
    () => flash('link copied'),
    () => flash('could not copy — the link is in the address bar'),
  )
})

function flash(message: string): void {
  const held = dom.share.textContent
  dom.share.textContent = message
  window.setTimeout(() => (dom.share.textContent = held), 1600)
}

// A fragment this page did not write is someone pasting a plan in, and they mean to see it.
window.addEventListener('hashchange', () => {
  if (window.location.hash === ourLink) return

  const shared = readLink(state.version)
  if (!shared) return

  state = shared
  state.view = view
  dom.version.value = state.version
  void selectVersion(state.version)
})

document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return
  if (event.key === 'f' && layout) applyView(fitView(refs, layout, view))
})

// ── Dataset ───────────────────────────────────────────────────────────────────

dom.version.innerHTML = VERSIONS.map(
  (version) => `<option value="${version.id}">${version.label}</option>`,
).join('')
dom.version.value = state.version

dom.version.addEventListener('change', () => {
  // A plan is written in one version's vocabulary; carrying it across would name ghosts.
  state = emptyState(dom.version.value)
  state.view = view
  void selectVersion(state.version)
})

async function selectVersion(id: string): Promise<void> {
  const mine = ++generation
  dom.loading.hidden = false
  dom.loading.textContent = 'loading game data…'

  try {
    const loaded = await loadDataset(id)
    if (mine !== generation) return

    registry = new ProtoRegistry(loaded.data, versionById(id))
    state.version = id
    if (!registry.entities.has(state.belt)) state.belt = 'transport-belt'
    dom.loading.hidden = true
    rebuild(true)

    const blob = await fetchBytes(loaded.iconsUrl)
    if (mine !== generation || !blob) return
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => {
      sheet = { url, width: image.naturalWidth, height: image.naturalHeight }
      rebuild()
    }
    image.src = url
  } catch (error) {
    dom.loading.hidden = false
    dom.loading.textContent = error instanceof Error ? error.message : 'could not load the game data'
  }
}

bindZoomPan(refs, view, () => writeState(state))
void selectVersion(state.version)
