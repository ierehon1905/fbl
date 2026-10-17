import { Direction, directionName, gameDirection, oppositeDirection } from './geometry'
import type { PlacedEntity } from './scene'

/**
 * How a belt or a pipe looks is not a property of the entity: it is derived from what sits
 * next to it, exactly as the game derives it. This lives in core rather than in the renderer
 * because it is a statement about the blueprint, not about how it is drawn.
 */

const CARDINALS = [Direction.north, Direction.east, Direction.south, Direction.west]

const STEP: Record<number, { x: number; y: number }> = {
  [Direction.north]: { x: 0, y: -1 },
  [Direction.east]: { x: 1, y: 0 },
  [Direction.south]: { x: 0, y: 1 },
  [Direction.west]: { x: -1, y: 0 },
}

/** Pipe picture names are written in screen terms, not compass ones. */
const PIPE_SIDE: Record<number, 'up' | 'right' | 'down' | 'left'> = {
  [Direction.north]: 'up',
  [Direction.east]: 'right',
  [Direction.south]: 'down',
  [Direction.west]: 'left',
}

export type TileIndex = Map<string, PlacedEntity>

const key = (x: number, y: number) => `${x},${y}`

export function isBeltish(entity: PlacedEntity): boolean {
  const kind = entity.proto.kind
  return kind === 'belt' || kind === 'underground-belt' || kind === 'splitter'
}

export function isPipeish(entity: PlacedEntity): boolean {
  return entity.proto.kind === 'pipe'
}

/** Every tile a multi-tile entity occupies, so neighbour lookups do not miss its edges. */
/** Everything that carries items along in a straight line. */
export const LINE_KINDS = new Set(['belt', 'underground-belt', 'splitter'])

/**
 * Whether an entity is part of the same transport line as a belt heading a given way — a
 * belt, a tunnel end or a splitter already pointing there. Such a thing is not an obstacle:
 * the belt runs into it and comes out the far side, which is how a splitter drops into a run
 * without the belt diving around it, and how two belts along the same line merge.
 */
export function flowsWith(entity: PlacedEntity, heading: number | undefined): boolean {
  if (heading === undefined) return false
  return LINE_KINDS.has(entity.proto.kind) && entity.dir === heading
}

export function tileIndex(entities: PlacedEntity[], accept: (e: PlacedEntity) => boolean): TileIndex {
  const index: TileIndex = new Map()
  for (const entity of entities) {
    if (!accept(entity)) continue
    for (let dx = 0; dx < entity.w; dx++) {
      for (let dy = 0; dy < entity.h; dy++) index.set(key(entity.x + dx, entity.y + dy), entity)
    }
  }
  return index
}

/**
 * Which side of this tile items arrive through, for each neighbour that feeds it.
 * The side is the direction *towards* the neighbour — a belt to the west feeding east
 * delivers through the west edge.
 */
function entrySides(entity: PlacedEntity, belts: TileIndex): number[] {
  const sides: number[] = []

  for (const side of CARDINALS) {
    const step = STEP[side]
    const neighbour = belts.get(key(entity.x + step.x, entity.y + step.y))
    if (!neighbour || neighbour === entity) continue
    // An underground entry swallows items; only its exit feeds the tile in front of it.
    if (neighbour.proto.kind === 'underground-belt' && neighbour.undergroundType !== 'output') continue

    // The neighbour feeds us when it is pointing our way. Comparing directions rather than
    // adding its `dir` to its origin is what makes a splitter work: it is two tiles wide, and
    // its origin is only one of them, so the arithmetic missed whichever lane it was not on.
    if (neighbour.dir === oppositeDirection(side)) sides.push(side)
  }

  return sides
}

/**
 * The orientation name for a belt tile: a compass direction when it runs straight, or
 * `<entry side>-to-<facing>` when it curves.
 *
 * Factorio names its curve sprites by the side items come *in* through, not by the direction
 * they were travelling — a belt running east enters the corner through its west edge, so the
 * corner that turns it south is `west-to-south`. Getting this backwards mirrors every bend.
 */
export function beltOrientation(entity: PlacedEntity, belts: TileIndex): string {
  const facing = directionName(entity.dir)
  const sides = entrySides(entity, belts)
  const behind = oppositeDirection(entity.dir)

  // Fed from directly behind, or from nowhere: a straight tile.
  if (sides.includes(behind)) return facing
  if (sides.length !== 1) return facing

  const side = sides[0]
  // A neighbour pointing straight back at us is a jam, not a corner.
  if (side === entity.dir) return facing

  return `${directionName(side)}-to-${facing}`
}

/**
 * Sprite variant names to try for an entity, best first.
 *
 * This is the one place that knows how the atlas names things, which matters because a miss
 * is silent: the renderer just falls back to whatever variant happens to be first. An
 * underground's `undergroundType` is `input`/`output` for the blueprint, but its sprite keys
 * are `in-`/`out-`, and getting that wrong drew every underground facing north.
 */
export function spriteVariants(entity: PlacedEntity, belts: TileIndex, pipes: TileIndex): string[] {
  // The atlas is cut from the game's prototypes, so it is keyed by the game's direction.
  const facing = directionName(gameDirection(entity.proto.kind, entity.dir))
  const candidates: string[] = []

  switch (entity.proto.kind) {
    case 'belt':
      candidates.push(beltOrientation(entity, belts))
      break
    case 'underground-belt':
      candidates.push(`${entity.undergroundType === 'output' ? 'out' : 'in'}-${facing}`)
      break
    case 'pipe':
      candidates.push(pipeShape(entity, pipes))
      break
    default:
      break
  }

  candidates.push(facing, 'default', 'north')
  return candidates
}

/** Which pipe picture to draw, from the sides that connect. */
export function pipeShape(entity: PlacedEntity, pipes: TileIndex): string {
  const connected: Array<'up' | 'right' | 'down' | 'left'> = []

  for (const side of CARDINALS) {
    const step = STEP[side]
    const neighbour = pipes.get(key(entity.x + step.x, entity.y + step.y))
    if (!neighbour || neighbour === entity) continue
    // A pipe-to-ground only connects on the side it faces.
    if (neighbour.proto.name.endsWith('-to-ground') && neighbour.dir !== oppositeDirection(side)) continue
    connected.push(PIPE_SIDE[side])
  }

  const has = (s: string) => connected.includes(s as never)

  if (connected.length === 0) return 'straight-vertical-single'
  if (connected.length === 1) return `ending-${connected[0]}`
  if (connected.length === 4) return 'cross'
  if (connected.length === 3) {
    const missing = (['up', 'right', 'down', 'left'] as const).find((s) => !has(s))!
    const opposite = { up: 'down', down: 'up', left: 'right', right: 'left' } as const
    return `t-${opposite[missing]}`
  }
  if (has('up') && has('down')) return 'straight-vertical'
  if (has('left') && has('right')) return 'straight-horizontal'
  return `corner-${has('up') ? 'up' : 'down'}-${has('right') ? 'right' : 'left'}`
}
