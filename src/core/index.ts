import type { Stmt } from './ast'
import { MODULE_NAMES, MODULES, moduleStatements } from './modules'

export { decodeBlueprint, encodeBlueprint, exportBlueprint, toBlueprintJSON } from './blueprint'
export {
  BALANCER_LIMIT,
  balancerLayout,
  balancerSizes,
  hasBalancer,
  type BalancerLayout,
} from './balancer'
export { check, Checker, type BlockSignature } from './check'
export { computeCost, type Cost, type CostEntry } from './cost'
export { LangError, type Diagnostic, type Loc } from './errors'
export {
  Direction,
  directionFromName,
  directionName,
  directionStep,
  rotateSize,
  walkPath,
  type Rect,
  type Vec,
} from './geometry'
export { labelSpans, type LabelSpan } from './labels'
export { MODULE_NAMES, MODULES, moduleOffering } from './modules'
export { parse } from './parser'
export { powerCoverage, type PowerReport } from './power'
export { computeRates, type RateEntry, type Rates } from './rates'
export {
  bestMachine,
  consumersOf,
  isFrontier,
  machinesFor as machinesRunning,
  recipeGraph,
  type RecipeGraph,
} from './calc/graph'
export {
  addEffects,
  beaconEffects,
  moduleEffects,
  machineSpeed,
  throughputOf,
  NO_EFFECTS,
  type Effects,
  type Throughput,
} from './calc/machine'
export { minimise, type LPSolution, type LPStatus } from './calc/simplex'
export { decodePlan, encodePlan, type SharedPlan } from './calc/share'
export {
  loopRecipeFor,
  planQuality,
  recyclingOf,
  spread,
  type QualityDrive,
  type QualityLoop,
  type QualityPlan,
  type QualitySetup,
  type QualitySide,
  type QualityTier,
  type Recycling,
} from './calc/quality'
export {
  EMPTY_CONFIG,
  nodeKey,
  solve,
  type CalcConfig,
  type Flow,
  type NodeConfig,
  type Shortfall,
  type SolvedNode,
  type Solution,
  type Target,
} from './calc/solve'
export { ProtoRegistry, type Prototype } from './proto'
export { Runtime, type RunResult } from './run'
export { Scene, type PlacedEntity, type SlotOrigin, type Span, type Trace, type TraceStep } from './scene'
export {
  applyEdit,
  callText,
  planRemove,
  planSlotEdit,
  refused,
  sharedWith,
  type Refusal,
  type SlotEdit,
} from './edit'
export {
  beltOrientation,
  isBeltish,
  isPipeish,
  pipeShape,
  spriteVariants,
  tileIndex,
  type TileIndex,
} from './topology'
export { entitySlots, findSlot, FUNCTIONS, HELPER_SLOTS, LAYOUT_SLOTS, type SlotDef } from './slots'
export { showType, typeNames, Universe, type Type } from './types'
export { EnumValue, show, type Value } from './values'

import { Checker, type BlockSignature } from './check'
import { LangError, type Diagnostic } from './errors'
import { parse } from './parser'
import type { ProtoRegistry } from './proto'
import { Runtime } from './run'
import { Scene } from './scene'

export interface CompileResult {
  scene: Scene
  output: string[]
  diagnostics: Diagnostic[]
  /** True when the checker found nothing fatal and the program actually ran. */
  ran: boolean
  /** Signatures of the blocks this source defines, for editor completion. */
  blocks: BlockSignature[]
}

/**
 * Parse → check → run. The checker is a gate: if it reports an error nothing is placed,
 * so a program never half-builds a blueprint on the way to failing.
 */
export function compile(source: string, registry: ProtoRegistry): CompileResult {
  const diagnostics: Diagnostic[] = []
  const empty = new Scene()

  let module
  try {
    module = parse(source)
  } catch (error) {
    if (error instanceof LangError) {
      return {
        scene: empty,
        output: [],
        diagnostics: [{ severity: 'error', message: error.message, loc: error.loc, hint: error.hint }],
        ran: false,
        blocks: [],
      }
    }
    throw error
  }

  // Imports are resolved by putting the library's own statements in front of the program:
  // everything downstream then sees ordinary blocks, defined before they are used.
  const imported = new Set<string>()
  const prelude: Stmt[] = []
  for (const statement of module.statements) {
    if (statement.kind !== 'import') continue
    if (!(statement.name in MODULES)) {
      diagnostics.push({
        severity: 'error',
        message: `there is no library called '${statement.name}'`,
        loc: statement.loc,
        hint: `try ${MODULE_NAMES.map((name) => `"${name}"`).join(' or ')}`,
      })
      continue
    }
    if (imported.has(statement.name)) continue
    imported.add(statement.name)
    prelude.push(...moduleStatements(statement.name))
  }

  const whole = { statements: [...prelude, ...module.statements] }

  const checker = new Checker(registry, imported)
  diagnostics.push(...checker.check(whole))
  const blocks = [...checker.blocks.values()]

  if (diagnostics.some((d) => d.severity === 'error')) {
    return { scene: empty, output: [], diagnostics, ran: false, blocks }
  }

  try {
    const { scene, output } = new Runtime(registry, imported).run(whole)
    diagnostics.push(...scene.diagnostics)
    return { scene, output, diagnostics, ran: true, blocks }
  } catch (error) {
    if (error instanceof LangError) {
      diagnostics.push({ severity: 'error', message: error.message, loc: error.loc, hint: error.hint })
      return { scene: empty, output: [], diagnostics, ran: false, blocks }
    }
    throw error
  }
}
