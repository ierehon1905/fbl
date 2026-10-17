import './style.css'

import {
  ProtoRegistry,
  compile,
  computeCost,
  computeRates,
  exportBlueprint,
  powerCoverage,
  type BlockSignature,
  type Diagnostic,
  type PlacedEntity,
} from '../core'
import { loadDataset } from '../data/loader'
import { fetchBytes, type OnProgress } from '../data/progress'
import { loadAtlas } from '../data/sprites'
import { DEFAULT_VERSION, VERSIONS } from '../data/versions'
import { BlueprintCanvas } from './canvas'
import { parseCostView, renderCost, type CostSection, type CostView } from './cost-panel'
import { type IconSheet, type PanelDeps, type PanelView } from './panel'
import { parseRateView, renderRates, type RateSection, type RateView } from './rate-panel'
import { renderDocs } from './docs'
import { createEditor, type Editor } from './editor'
import { Drawer } from './drawer'
import { EXAMPLES } from './examples'
import { Builder } from './builder'
import { Preloader } from './preloader'
import { crumbs, madeOnLine } from './provenance'

const STORAGE_SOURCE = 'fbl.source'
const STORAGE_VERSION = 'fbl.version'
const STORAGE_NAME = 'fbl.schema'

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id)
  if (!found) throw new Error(`#${id} is missing from index.html`)
  return found as T
}

const dom = {
  editor: el('editor'),
  canvas: el<HTMLCanvasElement>('canvas'),
  tooltip: el('tooltip'),
  gate: el('gate'),
  gateRows: el('gate-rows'),
  gateNote: el('gate-note'),
  app: el('app'),
  console: el('console'),
  docs: el('docs'),
  cost: el('cost'),
  rates: el('rates'),
  tabs: el('tabs'),
  version: el<HTMLSelectElement>('version'),
  menu: el('menu'),
  drawer: el('drawer'),
  scrim: el('scrim'),
  copy: el<HTMLButtonElement>('copy'),
  fit: el<HTMLButtonElement>('fit'),
  power: el<HTMLButtonElement>('power'),
  stats: el('stats'),
  art: el('art'),
  trail: el('trail'),
  build: el('build'),
  entity: el('entity'),
  splitter: el('splitter'),
  panes: document.querySelector<HTMLElement>('.panes')!,
}

const preview = new BlueprintCanvas(dom.canvas, dom.tooltip)
const preloader = new Preloader(dom.gate, dom.gateRows, dom.gateNote, dom.app)

/** Shared with the language providers, which read it on every keystroke. */
const host: { registry: ProtoRegistry | null; blocks: BlockSignature[] } = { registry: null, blocks: [] }

let source = readStorage(STORAGE_SOURCE) ?? EXAMPLES[0].source
let blueprintText = ''
/** The last scene drawn, so the caret and the breadcrumb can be answered without rebuilding. */
let placed: PlacedEntity[] = []
/** The line the caret is on, and whose entities are lit. */
let litLine: number | null = null
let costView: CostView = parseCostView(readStorage('fbl.cost'))
let rateView: RateView = parseRateView(readStorage('fbl.rates'))
let showPower = readStorage('fbl.power') === 'on'
let iconSheet: IconSheet | null = null
/** Kept so the panels can redraw when a section opens, without recompiling. */
let lastCost: ReturnType<typeof computeCost> | null = null
let lastRates: ReturnType<typeof computeRates> | null = null
/** Bumped on every dataset load so a slow one cannot clobber a newer one. */
let generation = 0

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private windows and blocked site data are fine; the editor just will not persist.
  }
}

// ── Console ───────────────────────────────────────────────────────────────────

function log(
  kind: 'error' | 'warning' | 'out',
  text: string,
  loc?: { line: number; col: number },
  hint?: string,
): void {
  const row = document.createElement('div')
  row.className = `msg msg-${kind}`

  const where = document.createElement('span')
  where.className = 'where'
  if (loc) {
    where.textContent = `${loc.line}:${loc.col}`
    where.classList.add('clickable')
    where.title = 'jump to this line'
    where.addEventListener('click', () => editor.reveal(loc.line, loc.col))
  } else {
    where.textContent = kind === 'out' ? '›' : ''
  }

  const body = document.createElement('span')
  body.textContent = text
  if (hint) {
    const note = document.createElement('span')
    note.className = 'hint'
    note.textContent = ` — ${hint}`
    body.append(note)
  }

  row.append(where, body)
  dom.console.append(row)
}

// ── Compile ───────────────────────────────────────────────────────────────────

function build(): void {
  if (!host.registry) return
  dom.console.replaceChildren()

  const clashing = new Set<PlacedEntity>()
  blueprintText = ''

  const { scene, output, diagnostics, ran, blocks } = compile(source, host.registry)
  host.blocks = blocks
  const all: Diagnostic[] = [...diagnostics]

  if (ran) {
    for (const clash of scene.findCollisions()) {
      clashing.add(clash.a)
      clashing.add(clash.b)
      all.push({
        severity: 'warning',
        message: `${clash.a.proto.label} and ${clash.b.proto.label} overlap at (${clash.x}, ${clash.y})`,
        loc: clash.b.loc,
      })
    }
    blueprintText = exportBlueprint(scene, host.registry, { label: 'fbl blueprint' }).text
    for (const line of output) log('out', line)
  }

  const power = ran && scene.entities.length ? powerCoverage(scene.entities) : null
  preview.setPower(power)
  // Only worth saying when there are poles at all — plenty of blueprints leave power out.
  if (power && power.poles > 0 && power.unpowered.length > 0) {
    all.push({
      severity: 'warning',
      message: `${power.unpowered.length} of ${power.consumers} powered entities are outside every supply area`,
      loc: power.unpowered[0].loc,
    })
  }

  const worth = ran && scene.entities.length > 0
  lastCost = worth ? computeCost(scene, host.registry) : null
  lastRates = worth ? computeRates(scene, host.registry) : null
  drawPanels()

  for (const diagnostic of all) log(diagnostic.severity, diagnostic.message, diagnostic.loc, diagnostic.hint)
  editor.setDiagnostics(all)

  placed = scene.entities
  preview.setScene(scene.entities, clashing)
  drawTrail(preview.selection)
  builder.show(preview.selection)
  // The caret has not moved, but what its line makes may have; light it again from the new scene.
  litLine = ran ? litLine : null
  if (litLine !== null) preview.setLit(madeOnLine(placed, litLine))
  dom.copy.disabled = blueprintText === ''

  const errors = all.filter((d) => d.severity === 'error').length
  const warnings = all.length - errors
  dom.stats.textContent = errors
    ? `${errors} error${errors === 1 ? '' : 's'}`
    : scene.entities.length
      ? `${scene.entities.length} entities · ${warnings} warning${warnings === 1 ? '' : 's'}`
      : ''
}

/**
 * The chain a selected entity came by, along the bottom of the canvas. Every crumb jumps to
 * its own line, which is the whole point: a generated blueprint has no other way of telling
 * you which of twenty-four you clicked on.
 */
function drawTrail(entity: PlacedEntity | null): void {
  dom.trail.replaceChildren()
  dom.trail.hidden = entity === null
  if (!entity) return

  const path = crumbs(entity)
  for (const [at, crumb] of path.entries()) {
    if (at > 0) {
      const sep = document.createElement('span')
      sep.className = 'sep'
      sep.textContent = '›'
      dom.trail.append(sep)
    }
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = crumb.label
    button.title = `go to line ${crumb.line}`
    button.addEventListener('click', () => editor.reveal(crumb.line, crumb.column))
    dom.trail.append(button)
  }

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'trail-x'
  close.textContent = '×'
  close.title = 'clear the selection'
  close.addEventListener('click', () => preview.select(null))
  dom.trail.append(close)
}

function panelDeps(): PanelDeps | null {
  const registry = host.registry
  if (!registry) return null
  return {
    icon: (name) => registry.icons.get(name),
    label: (name) => registry.itemLabels.get(name) ?? name,
    sheet: iconSheet,
  }
}

/** Fills a panel, and hides it when it has nothing to say. */
function fill(element: HTMLElement, html: string): void {
  element.innerHTML = html
  element.hidden = html.trim() === ''
}

function drawPanels(): void {
  const deps = panelDeps()
  fill(dom.cost, lastCost && deps ? renderCost(lastCost, costView, deps) : '')
  fill(dom.rates, lastRates && deps ? renderRates(lastRates, rateView, deps) : '')
}

/**
 * Both panels fold and switch section the same way, and both remember where they were left.
 */
function bindPanel<Section extends string>(
  element: HTMLElement,
  key: string,
  read: () => PanelView<Section>,
  write: (view: PanelView<Section>) => void,
): void {
  element.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('button')
    if (!button) return

    const view = read()
    if (button.dataset.panelToggle !== undefined) {
      write({ ...view, collapsed: !view.collapsed })
    } else if (button.dataset.panelSection) {
      write({ ...view, section: button.dataset.panelSection as Section })
    } else {
      return
    }

    writeStorage(key, JSON.stringify(read()))
    drawPanels()
  })
}

bindPanel<CostSection>(dom.cost, 'fbl.cost', () => costView, (view) => (costView = view))
bindPanel<RateSection>(dom.rates, 'fbl.rates', () => rateView, (view) => (rateView = view))

// ── Dataset ───────────────────────────────────────────────────────────────────

async function selectVersion(id: string): Promise<void> {
  const mine = ++generation
  // Named before it is asked for, so the gate lists what it is waiting on from the first
  // frame rather than growing a row at a time as each request gets going.
  preloader.track('dataset', 'game data')
  preloader.track(`icons:${id}`, 'item icons')
  writeStorage(STORAGE_VERSION, id)

  let loaded
  try {
    loaded = await loadDataset(id)
  } catch (error) {
    if (mine !== generation) return
    preloader.failed('dataset', error instanceof Error ? error.message : String(error), true)
    return
  }
  if (mine !== generation) return
  preloader.finish('dataset', loaded.profile.label)

  // The dataset is all that compiling needs, so the studio opens now and the art catches up.
  host.registry = new ProtoRegistry(loaded.data, loaded.profile)
  preview.setFluids((name) => {
    const recipe = host.registry?.recipes.get(name)
    const fluids = host.registry?.fluids
    if (!recipe || !fluids) return undefined
    const count = (side?: Record<string, number>) => Object.keys(side ?? {}).filter((id) => fluids.has(id)).length
    return { inputs: count(recipe.in), outputs: count(recipe.out) }
  })
  dom.docs.innerHTML = renderDocs(host.registry)
  build()
  preview.fit()

  const iconsUrl = loaded.iconsUrl
  void loadImage(iconsUrl, preloader.feed(`icons:${id}`)).then((icons) => {
    if (mine !== generation) return
    iconSheet = icons ? { url: iconsUrl, width: icons.naturalWidth, height: icons.naturalHeight } : null
    preview.setIcons(icons, (name: string) => host.registry?.icons.get(name))
    drawPanels()
    if (icons) preloader.finish(`icons:${id}`)
    else preloader.failed(`icons:${id}`, 'not available')
  })
}

async function loadImage(url: string, onProgress?: OnProgress): Promise<HTMLImageElement | null> {
  const blob = await fetchBytes(url, onProgress)
  // Missing art is not fatal — entities still render as tinted footprints.
  if (!blob) return null

  const objectUrl = URL.createObjectURL(blob)
  const image = await new Promise<HTMLImageElement | null>((resolve) => {
    const element = new Image()
    element.onload = () => resolve(element)
    element.onerror = () => resolve(null)
    element.src = objectUrl
  })
  URL.revokeObjectURL(objectUrl)
  return image
}

// ── Wiring ────────────────────────────────────────────────────────────────────

for (const version of VERSIONS) dom.version.append(new Option(version.label, version.id))
dom.version.value = readStorage(STORAGE_VERSION) ?? DEFAULT_VERSION.id

let debounce = 0
const editor: Editor = createEditor(dom.editor, source, host)
editor.onChange((next) => {
  source = next
  writeStorage(STORAGE_SOURCE, next)
  window.clearTimeout(debounce)
  debounce = window.setTimeout(build, 200)
})

// ── The picture and the source, pointing at each other ──────────────────────
// Clicking an entity says where it was written; putting the caret in a line says what that
// line built. The second direction is the one that surprises people: a statement inside a
// loop lights up two dozen machines at once, which is the fact a generated blueprint is
// otherwise unable to tell you.
const builder = new Builder(dom.entity, dom.build, {
  registry: () => host.registry,
  sheet: () => iconSheet,
  source: () => source,
  entities: () => placed,
  patch: (start, end, text, label) => editor.patch(start, end, text, label),
  complain: (message) => log('warning', message),
  undo: () => editor.undo(),
  deselect: () => preview.select(null),
  note: (message) => log('out', message),
  hold: (tool) => preview.setTool(tool),
  // At the end of the file, on a line of its own, and through the editor so it is one undo.
  append: (statement) => {
    const lines = source.split('\n')
    const last = lines.length
    const column = lines[last - 1].length + 1
    const lead = lines[last - 1].trim() === '' ? '' : '\n'
    editor.patch({ line: last, col: column }, { line: last, col: column }, `${lead}${statement}\n`, 'draw')
  },
})

preview.onDraw((run) => builder.onDrawn(run))
preview.onPlace((at, room) => builder.placed(at, room))
preview.onHover((entity) => builder.hover(entity))
preview.onMine((entity) => builder.mined(entity))

preview.onSelectionChange((entity) => {
  drawTrail(entity)
  builder.show(entity)
  // Shown, not handed over: the keyboard belongs to the map while something on it is selected.
  if (entity?.loc) editor.reveal(entity.loc.line, entity.loc.col, false)
})

editor.onCaretLine((line) => {
  litLine = line
  preview.setLit(madeOnLine(placed, line))
})

dom.version.addEventListener('change', () => void selectVersion(dom.version.value))

/** The name the buffer was last saved or opened under, so the drawer opens on it again. */
let schemaName: string | null = readStorage(STORAGE_NAME) || null

const drawer = new Drawer(dom.drawer, dom.scrim, dom.menu, {
  open: (next) => {
    editor.setValue(next)
    source = next
    writeStorage(STORAGE_SOURCE, next)
    build()
    window.setTimeout(() => preview.fit(), 60)
  },
  current: () => ({ source, name: schemaName }),
  remember: (name) => {
    schemaName = name
    writeStorage(STORAGE_NAME, name ?? '')
  },
})
drawer.setName(schemaName)

dom.fit.addEventListener('click', () => preview.fit())

function setPower(on: boolean): void {
  showPower = on
  preview.setPowerVisible(on)
  dom.power.classList.toggle('active', on)
  writeStorage('fbl.power', on ? 'on' : 'off')
}

dom.power.addEventListener('click', () => setPower(!showPower))
setPower(showPower)

dom.copy.addEventListener('click', async () => {
  if (!blueprintText) return
  try {
    await navigator.clipboard.writeText(blueprintText)
    dom.copy.textContent = 'copied ✓'
    dom.copy.classList.add('copied')
  } catch {
    dom.copy.textContent = 'copy failed'
  }
  window.setTimeout(() => {
    dom.copy.textContent = 'copy blueprint'
    dom.copy.classList.remove('copied')
  }, 1400)
})

// ── Tabs ──────────────────────────────────────────────────────────────────────

dom.tabs.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('button')
  const tab = button?.dataset.tab
  if (!tab) return
  for (const other of dom.tabs.querySelectorAll('button')) {
    other.classList.toggle('active', other.dataset.tab === tab)
  }
  el('tab-blueprint').hidden = tab !== 'blueprint'
  el('tab-docs').hidden = tab !== 'docs'
  if (tab === 'blueprint') preview.requestRender()
})

// ── The game's art ────────────────────────────────────────────────────────────

void loadAtlas(preloader.track('sprites', 'entity sprites')).then((atlas) => {
  preview.setAtlas(atlas)

  // Without a local install there is no art, and the canvas falls back to footprints on its
  // own. Saying so once beats leaving someone to wonder why the game looks like a diagram.
  if (!atlas) {
    preloader.failed('sprites', 'no local install')
    log('warning', 'no entity sprites — run `npm run extract-sprites` with Factorio installed')
    return
  }
  preloader.finish('sprites', `Factorio ${atlas.manifest.gameVersion}`)
  dom.art.textContent = `Factorio ${atlas.manifest.gameVersion}`
})

window.addEventListener('keydown', (event) => {
  const inEditor = dom.editor.contains(document.activeElement)
  if (event.metaKey || event.ctrlKey || inEditor) return
  if (event.key === 'f') preview.fit()
  if (event.key === 'p') setPower(!showPower)
})

// Draggable split between code and preview.
dom.splitter.addEventListener('pointerdown', (event) => {
  dom.splitter.setPointerCapture(event.pointerId)
  dom.splitter.classList.add('dragging')

  const move = (moved: PointerEvent) => {
    const rect = dom.panes.getBoundingClientRect()
    const ratio = ((moved.clientX - rect.left) / rect.width) * 100
    dom.panes.style.setProperty('--split', `${Math.max(20, Math.min(80, ratio))}%`)
  }
  const up = () => {
    dom.splitter.classList.remove('dragging')
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }

  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
})

void selectVersion(dom.version.value)
