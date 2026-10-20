import pako from 'pako'

import { packGameVersion } from '../data/versions'
import { gameDirection } from './geometry'
import type { VersionProfile } from '../data/versions'
import type { ProtoRegistry } from './proto'
import type { PlacedEntity, Scene } from './scene'

export interface BlueprintOptions {
  label?: string
  description?: string
}

interface BlueprintEntity {
  entity_number: number
  name: string
  position: { x: number; y: number }
  direction?: number
  recipe?: string
  quality?: string
  type?: string
  items?: unknown
  use_filters?: boolean
  filters?: unknown[]
  filter_mode?: string
  filter?: unknown
  input_priority?: string
  output_priority?: string
  /** 1.1 keeps a pole's copper wires on the pole itself, as the entity numbers it reaches. */
  neighbours?: number[]
}

/** The connector a pole's copper wire hangs on, in 2.0's `wires` array. */
const POLE_COPPER = 5

/**
 * Copper wires between the blueprint's poles: a minimum spanning tree over every pair close
 * enough to reach each other, so each group of poles in range is joined with the fewest and
 * shortest wires. A blueprint that carries no wires leaves the joining to the game, which
 * links a pasted pole to only some of its neighbours — whole rows of a build came out cut off.
 */
function poleWires(scene: Scene): Array<[number, number]> {
  const poles = scene.entities
    .map((entity, index) => ({ entity, number: index + 1 }))
    .filter(({ entity }) => entity.proto.wireReach !== undefined)
  const centre = (e: PlacedEntity) => ({ x: e.x + e.w / 2, y: e.y + e.h / 2 })

  const edges: Array<{ a: number; b: number; length: number }> = []
  for (let i = 0; i < poles.length; i++) {
    for (let j = i + 1; j < poles.length; j++) {
      const p = centre(poles[i].entity)
      const q = centre(poles[j].entity)
      const length = Math.hypot(p.x - q.x, p.y - q.y)
      const reach = Math.min(poles[i].entity.proto.wireReach!, poles[j].entity.proto.wireReach!)
      if (length <= reach) edges.push({ a: i, b: j, length })
    }
  }
  edges.sort((p, q) => p.length - q.length)

  const parent = poles.map((_, i) => i)
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])))
  const wires: Array<[number, number]> = []
  for (const { a, b } of edges) {
    const [ra, rb] = [root(a), root(b)]
    if (ra === rb) continue
    parent[ra] = rb
    wires.push([poles[a].number, poles[b].number])
  }
  return wires
}

/**
 * An item reference inside a filter. 2.0 spells these out as signals with a quality and a
 * comparator; 1.1 filters carry the bare name.
 */
function filterRef(name: string, profile: VersionProfile): unknown {
  return profile.supportsQuality ? { name, quality: 'normal', comparator: '=' } : { name }
}

/** Inserter filters, and the whitelist/blacklist switch behind them. */
function encodeFilters(entity: PlacedEntity, out: BlueprintEntity, profile: VersionProfile): void {
  const spec = entity.filters
  if (!spec || spec.items.length === 0) return

  out.filters = spec.items.map((name, index) => ({ index: index + 1, ...(filterRef(name, profile) as object) }))
  // A blacklist is the setting; a whitelist is what an inserter does by default.
  if (spec.negated) out.filter_mode = 'blacklist'
  // 1.1 has dedicated filter inserters, so there is no switch to turn on.
  if (profile.supportsQuality) out.use_filters = true
}

/** Splitter filter and lane priorities, which are three independent fields in the game. */
function encodeSplitter(entity: PlacedEntity, out: BlueprintEntity, profile: VersionProfile): void {
  if (entity.inPriority) out.input_priority = entity.inPriority
  if (entity.outPriority) out.output_priority = entity.outPriority
  if (!entity.splitterFilter) return

  out.filter = profile.supportsQuality ? filterRef(entity.splitterFilter, profile) : entity.splitterFilter
  // The game holds a filter on one output side, and picks the left one when none was named.
  if (!out.output_priority) out.output_priority = 'left'
}

/**
 * Module requests changed shape in 2.0: a map of counts became a list of insert plans that
 * name the target inventory and slot. `defines.inventory` indices come from the prototype
 * (crafting machines 4, mining drills 2, beacons 1, labs 3).
 */
function encodeModules(entity: PlacedEntity, profile: VersionProfile): unknown | undefined {
  const modules = entity.modules
  if (!modules?.length) return undefined

  if (profile.moduleFormat === 'items-map') {
    const counts: Record<string, number> = {}
    for (const module of modules) counts[module.name] = (counts[module.name] ?? 0) + 1
    return counts
  }

  const inventory = entity.proto.moduleInventory
  const plans = new Map<string, { name: string; quality?: string; slots: number[] }>()

  modules.forEach((module, slot) => {
    const quality = profile.supportsQuality && module.quality && module.quality !== 'normal' ? module.quality : undefined
    const key = `${module.name}|${quality ?? ''}`
    const plan = plans.get(key) ?? { name: module.name, quality, slots: [] }
    plan.slots.push(slot)
    plans.set(key, plan)
  })

  return [...plans.values()].map((plan) => ({
    id: plan.quality ? { name: plan.name, quality: plan.quality } : { name: plan.name },
    items: {
      in_inventory: plan.slots.map((stack) => ({ inventory, stack, count: 1 })),
    },
  }))
}

/**
 * Recipes the dataset renamed, keyed by its id, with the name the game knows them by. The
 * game's ore-melting recipes share their name with the fluid they make, and the dataset gives
 * them ids of their own; a blueprint carrying that id is a recipe the game has never heard
 * of, and it drops every foundry that names it.
 */
const GAME_RECIPE_NAMES: Record<string, string> = {
  'iron-ore-melting': 'molten-iron',
  'copper-ore-melting': 'molten-copper',
}

const gameRecipe = (id: string): string => GAME_RECIPE_NAMES[id] ?? id

/**
 * Up to four icons for the blueprint thumbnail, taken from the recipes it builds. 2.0 has
 * recipe signals; 1.1 does not, and there a recipe that is not also an item shows blank.
 */
function buildIcons(scene: Scene, profile: VersionProfile): unknown[] {
  const recipes = new Set<string>()
  for (const entity of scene.entities) if (entity.recipe) recipes.add(gameRecipe(entity.recipe))
  if (recipes.size === 0) {
    const names = [...new Set(scene.entities.map((e) => e.proto.name))]
    return names.slice(0, 4).map((name, index) => ({ signal: { type: 'item', name }, index: index + 1 }))
  }
  const type = profile.directionScale === 2 ? 'recipe' : 'item'
  return [...recipes].slice(0, 4).map((name, index) => ({ signal: { type, name }, index: index + 1 }))
}

export function toBlueprintJSON(scene: Scene, registry: ProtoRegistry, options: BlueprintOptions = {}): unknown {
  const profile = registry.profile

  const entities: BlueprintEntity[] = scene.entities.map((entity, index) => {
    const dir = gameDirection(entity.proto.kind, entity.dir)
    const direction = dir / (profile.directionScale === 2 ? 1 : 2)

    const out: BlueprintEntity = {
      entity_number: index + 1,
      name: entity.proto.name,
      // Blueprints store the centre of the footprint, so odd sizes land on .5 coordinates.
      position: { x: entity.x + entity.w / 2, y: entity.y + entity.h / 2 },
    }

    if (dir !== 0) out.direction = direction
    if (entity.recipe) out.recipe = gameRecipe(entity.recipe)
    if (entity.undergroundType) out.type = entity.undergroundType
    if (entity.quality && entity.quality !== 'normal' && profile.supportsQuality) out.quality = entity.quality

    const items = encodeModules(entity, profile)
    if (items) out.items = items

    if (entity.proto.kind === 'inserter') encodeFilters(entity, out, profile)
    if (entity.proto.kind === 'splitter') encodeSplitter(entity, out, profile)

    return out
  })

  // 2.0 lists wires once for the whole blueprint; 1.1 writes them on both ends.
  const wires = poleWires(scene)
  if (profile.directionScale !== 2) {
    for (const [a, b] of wires) {
      ;(entities[a - 1].neighbours ??= []).push(b)
      ;(entities[b - 1].neighbours ??= []).push(a)
    }
  }

  return {
    blueprint: {
      item: 'blueprint',
      label: options.label ?? 'Untitled',
      ...(options.description ? { description: options.description } : {}),
      icons: buildIcons(scene, profile),
      entities,
      ...(profile.directionScale === 2 && wires.length
        ? { wires: wires.map(([a, b]) => [a, POLE_COPPER, b, POLE_COPPER]) }
        : {}),
      version: packGameVersion(registry.dataset),
    },
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Version byte '0', then base64 of the zlib-deflated JSON. */
export function encodeBlueprint(json: unknown): string {
  return '0' + toBase64(pako.deflate(JSON.stringify(json), { level: 9 }))
}

export function decodeBlueprint(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith('0')) throw new Error(`unsupported blueprint version byte '${trimmed[0] ?? ''}'`)
  return JSON.parse(pako.inflate(fromBase64(trimmed.slice(1)), { to: 'string' }))
}

export function exportBlueprint(
  scene: Scene,
  registry: ProtoRegistry,
  options: BlueprintOptions = {},
): { json: unknown; text: string } {
  const json = toBlueprintJSON(scene, registry, options)
  return { json, text: encodeBlueprint(json) }
}
