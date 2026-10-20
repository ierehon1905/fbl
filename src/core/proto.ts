import type { LabBeacon, LabDataset, LabIcon, LabItem, LabMachine, LabRecipe } from '../data/dataset'
import {
  ENTITY_GEOMETRY,
  ROTATABLE_MACHINES,
  moduleInventoryFor,
  type EntityKind,
} from '../data/entity-geometry'
import type { VersionProfile } from '../data/versions'
import { vec, type Vec } from './geometry'
import { closestNames } from './suggest'

export interface Prototype {
  name: string
  label: string
  /** Footprint facing north, in tiles. */
  size: Vec
  rotatable: boolean
  kind: EntityKind
  moduleSlots: number
  moduleInventory: number
  undergroundReach?: number
  icon?: LabIcon
  craftingSpeed?: number
  /** Items per second for a belt tier. */
  beltSpeed?: number
  /** Half the width of the square this pole powers, from its centre. */
  supplyArea?: number
  /** How far this pole throws a copper wire, centre to centre. */
  wireReach?: number
  /** Draws electricity from the grid. */
  needsPower: boolean
  /** Inventory slots, for chests. */
  slots?: number
}

/** Friendly tier aliases, so `:green` works as well as `turbo-transport-belt`. */
const TIER_ALIASES: Record<string, Record<string, string>> = {
  belt: {
    yellow: 'transport-belt',
    normal: 'transport-belt',
    basic: 'transport-belt',
    red: 'fast-transport-belt',
    fast: 'fast-transport-belt',
    blue: 'express-transport-belt',
    express: 'express-transport-belt',
    green: 'turbo-transport-belt',
    turbo: 'turbo-transport-belt',
  },
  underground: {
    yellow: 'underground-belt',
    normal: 'underground-belt',
    red: 'fast-underground-belt',
    fast: 'fast-underground-belt',
    blue: 'express-underground-belt',
    express: 'express-underground-belt',
    green: 'turbo-underground-belt',
    turbo: 'turbo-underground-belt',
  },
  splitter: {
    yellow: 'splitter',
    normal: 'splitter',
    red: 'fast-splitter',
    fast: 'fast-splitter',
    blue: 'express-splitter',
    express: 'express-splitter',
    green: 'turbo-splitter',
    turbo: 'turbo-splitter',
  },
}

export class ProtoRegistry {
  readonly entities = new Map<string, Prototype>()
  readonly recipes = new Map<string, LabRecipe>()
  readonly icons = new Map<string, LabIcon>()
  readonly qualities: string[]
  readonly modules = new Set<string>()
  readonly itemLabels = new Map<string, string>()
  /** Fluids move by pipe, not by belt, which is what makes a machine grow one. */
  readonly fluids = new Set<string>()
  /** Crafting machines, for working out what a blueprint eats and makes. */
  readonly machines = new Map<string, LabMachine>()
  /** What each module does, including at every quality above normal. */
  readonly moduleEffects = new Map<string, NonNullable<LabItem['module']>>()
  /** Beacons, which hand their modules' effect to whatever stands near them. */
  readonly beacons = new Map<string, LabBeacon>()

  constructor(
    readonly dataset: LabDataset,
    readonly profile: VersionProfile,
  ) {
    for (const icon of dataset.icons) this.icons.set(icon.id, icon)
    for (const recipe of dataset.recipes) this.recipes.set(recipe.id, recipe)
    this.qualities = (dataset.qualities ?? []).map((q) => q.id)

    for (const item of dataset.items) {
      this.itemLabels.set(item.id, item.name)
      if (item.module) this.modules.add(item.id)
      if (item.category === 'fluids') this.fluids.add(item.id)
      if (item.machine) this.machines.set(item.id, item.machine)
      if (item.module) this.moduleEffects.set(item.id, item.module)
      if (item.beacon) this.beacons.set(item.id, item.beacon)

      const overrides = ENTITY_GEOMETRY[item.id]
      const machineSize = item.machine?.size
      if (!overrides && !machineSize) continue

      // The dataset comes from the real prototypes, so it wins wherever it has an answer.
      const size = machineSize ?? overrides!.size
      this.entities.set(item.id, {
        name: item.id,
        label: item.name,
        size: vec(size[0], size[1]),
        rotatable: overrides?.rotatable ?? ROTATABLE_MACHINES.has(item.id),
        kind: overrides?.kind ?? (item.machine ? 'machine' : 'misc'),
        moduleSlots: item.machine?.modules ?? overrides?.moduleSlots ?? 0,
        moduleInventory: overrides?.moduleInventory ?? moduleInventoryFor(item.id),
        undergroundReach: overrides?.undergroundReach,
        icon: this.icons.get(item.id),
        craftingSpeed: item.machine?.speed,
        beltSpeed: item.belt?.speed,
        supplyArea: overrides?.supplyArea,
        wireReach: overrides?.wireReach,
        needsPower: overrides?.powered ?? item.machine?.type === 'electric',
        slots: overrides?.slots,
      })
    }
  }

  /** Resolves `:fast` / `:red` / `fast-transport-belt` to a prototype of the given family. */
  resolveTier(family: keyof typeof TIER_ALIASES, tier: string): string | undefined {
    const aliased = TIER_ALIASES[family]?.[tier]
    if (aliased && this.entities.has(aliased)) return aliased
    return this.entities.has(tier) ? tier : undefined
  }

  /** Entity names close to `name`, for "did you mean" hints. */
  suggest(name: string, limit = 3): string[] {
    return closestNames(name, this.entities.keys(), limit)
  }
}
