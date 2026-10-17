import type { LabRecipe } from '../data/dataset'
import type { ProtoRegistry, RecipeGraph } from '../core'
import { machinesRunning } from '../core'
import type { PickerOption } from '../ui/picker'
import { labelOf } from './view'

/**
 * What goes in a picker, and what it says when you hover it.
 *
 * The detail line is the point. A grid of machine icons tells you which is which; what you
 * actually want to know before choosing one is how fast it is and how many modules it holds,
 * and that is a fact about the machine rather than about this plan, so it belongs here next to
 * the name rather than on a card.
 */

const round = (value: number) => Number(value.toFixed(2))

export function machineOptions(registry: ProtoRegistry, recipe: LabRecipe): PickerOption[] {
  return machinesRunning(registry, recipe).map((id) => {
    const spec = registry.machines.get(id)
    const bits = [`speed ${round(spec?.speed ?? 0)}`]
    if (spec?.modules) bits.push(`${spec.modules} module slot${spec.modules === 1 ? '' : 's'}`)
    if (spec?.baseEffect?.productivity) bits.push(`+${Math.round(spec.baseEffect.productivity * 100)}% productivity`)
    if (spec?.usage) bits.push(`${spec.usage >= 1000 ? `${round(spec.usage / 1000)} MW` : `${Math.round(spec.usage)} kW`}`)

    return { id, label: labelOf(registry, id), detail: bits.join(' · '), icon: registry.icons.get(id) }
  })
}

export function moduleOptions(registry: ProtoRegistry): PickerOption[] {
  return [...registry.modules].map((id) => {
    const effect = registry.moduleEffects.get(id)
    const bits: string[] = []
    for (const [name, value] of Object.entries(effect ?? {})) {
      if (name === 'qualityRecord' || typeof value !== 'number' || value === 0) continue
      bits.push(`${value > 0 ? '+' : ''}${Math.round(value * 100)}% ${name}`)
    }
    return {
      id,
      label: labelOf(registry, id),
      detail: bits.join(', '),
      icon: registry.icons.get(id),
      // Speed, then productivity, then the rest, which is the order they matter in here.
      row: effect?.speed ? 0 : effect?.productivity ? 1 : 2,
    }
  })
}

/** What a recipe takes and gives, short enough to read under a cursor. */
export function recipeDetail(registry: ProtoRegistry, graph: RecipeGraph, recipe: LabRecipe): string {
  const side = (amounts: Record<string, number> | undefined) =>
    Object.entries(amounts ?? {})
      .map(([item, count]) => `${round(count)} ${labelOf(registry, item).toLowerCase()}`)
      .join(', ')

  // Half these recipes are named after what they make, so a list of them reads as a list of
  // the same word. What tells them apart is where the stuff comes from.
  const takes = graph.extraction.has(recipe.id) ? 'out of the ground' : side(recipe.in) || 'nothing'
  return `${round(recipe.time)}s · ${takes} → ${side(recipe.out)}`
}

/**
 * The ways to make something, in the order the graph ranks them — the default first. The
 * picker would otherwise sort them by name, and the first thing anyone sees would be whichever
 * happens to start with an A.
 */
export function recipeOptions(registry: ProtoRegistry, graph: RecipeGraph, ids: string[]): PickerOption[] {
  return ids.flatMap((id, at) => {
    const recipe = graph.usable.get(id)
    if (!recipe) return []
    return [
      {
        id,
        label: recipe.name,
        detail: recipeDetail(registry, graph, recipe),
        icon: registry.icons.get(id),
        row: at,
      },
    ]
  })
}

/**
 * Every item, filed the way the game files them. The dataset carries the category and the row
 * each item sits on in the crafting menu, so the picker can look like the menu it stands in
 * for rather than like an alphabetical list of five hundred names.
 */
export function itemOptions(registry: ProtoRegistry): PickerOption[] {
  const groups = new Map((registry.dataset.categories ?? []).map((category) => [category.id, category.name]))

  return (registry.dataset.items ?? [])
    .filter((item) => item.category !== 'technology')
    .map((item) => ({
      id: item.id,
      label: item.name,
      detail: item.stack ? `stacks to ${item.stack}` : registry.fluids.has(item.id) ? 'a fluid' : '',
      icon: registry.icons.get(item.id),
      group: groups.get(item.category ?? '') ?? 'Other',
      row: item.row ?? 0,
    }))
}

/**
 * The quality tiers, as the game names them. What each one is worth depends on the thing it is
 * applied to — a machine gets faster, a module gets stronger — so the detail says which.
 */
export function qualityOptions(registry: ProtoRegistry, of: 'machine' | 'module'): PickerOption[] {
  return registry.qualities.map((id, at) => ({
    id,
    label: id.replace(/^./, (c) => c.toUpperCase()),
    detail: id === 'normal' ? 'as built' : of === 'machine' ? 'a faster machine' : 'a stronger module',
    icon: registry.icons.get(id),
    // Tiers have an order and it is not alphabetical; without this the list reads
    // Epic, Legendary, Normal, Rare, Uncommon.
    row: at,
  }))
}

export function beltOptions(registry: ProtoRegistry): PickerOption[] {
  return [...registry.entities.values()]
    .filter((proto) => proto.beltSpeed)
    .map((proto) => ({
      id: proto.name,
      label: proto.label,
      detail: `${round(proto.beltSpeed ?? 0)} items a second`,
      icon: registry.icons.get(proto.name),
    }))
}
