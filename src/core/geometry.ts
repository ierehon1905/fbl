export interface Vec {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const vec = (x: number, y: number): Vec => ({ x, y })
export const addVec = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y })

/**
 * Directions use Factorio 2.0's 16-point scale internally (north = 0, east = 4, …).
 * The 1.1 exporter halves them; see VersionProfile.directionScale.
 */
export const Direction = {
  north: 0,
  northeast: 2,
  east: 4,
  southeast: 6,
  south: 8,
  southwest: 10,
  west: 12,
  northwest: 14,
} as const

export type DirectionName = keyof typeof Direction

const DIRECTION_NAMES = Object.keys(Direction) as DirectionName[]


/**
 * Accepts the compass name, its initial, and the screen-relative word — `west`, `w`, `left`
 * all mean the same thing, and belts read better in screen terms.
 */
const DIRECTION_ALIASES: Record<string, DirectionName> = {
  n: 'north',
  e: 'east',
  s: 'south',
  w: 'west',
  ne: 'northeast',
  se: 'southeast',
  sw: 'southwest',
  nw: 'northwest',
  up: 'north',
  right: 'east',
  down: 'south',
  left: 'west',
}

export function directionFromName(name: string): number | undefined {
  if (name in Direction) return Direction[name as DirectionName]
  const canonical = DIRECTION_ALIASES[name]
  return canonical ? Direction[canonical] : undefined
}

export const DIRECTION_WORDS = [...DIRECTION_NAMES, ...Object.keys(DIRECTION_ALIASES)]

export function directionName(dir: number): DirectionName {
  return DIRECTION_NAMES.find((n) => Direction[n] === dir) ?? 'north'
}

/** Unit step in tile space for a direction. y grows downward, as in Factorio. */
export function directionStep(dir: number): Vec {
  switch (((dir % 16) + 16) % 16) {
    case Direction.north:
      return vec(0, -1)
    case Direction.northeast:
      return vec(1, -1)
    case Direction.east:
      return vec(1, 0)
    case Direction.southeast:
      return vec(1, 1)
    case Direction.south:
      return vec(0, 1)
    case Direction.southwest:
      return vec(-1, 1)
    case Direction.west:
      return vec(-1, 0)
    default:
      return vec(-1, -1)
  }
}

export function oppositeDirection(dir: number): number {
  return (dir + 8) % 16
}

/**
 * The direction the game stores for an entity. They agree for everything except inserters:
 * a program says where an inserter drops (`from south` means it faces north), while the game
 * points an inserter at its pickup — its prototype picks up at (0, -1) when facing north. A
 * blueprint or a sprite that took the program's direction as it stood had every inserter
 * working backwards.
 */
export function gameDirection(kind: string, dir: number): number {
  return kind === 'inserter' ? oppositeDirection(dir) : dir
}

/** Direction of the straight segment from `a` to `b`, or undefined if it is not axis-aligned. */
export function directionBetween(a: Vec, b: Vec): number | undefined {
  if (a.x === b.x && a.y === b.y) return undefined
  if (a.x === b.x) return b.y > a.y ? Direction.south : Direction.north
  if (a.y === b.y) return b.x > a.x ? Direction.east : Direction.west
  return undefined
}

/** A footprint declared facing north, rotated to `dir`. East/west swap the axes. */
export function rotateSize(size: Vec, dir: number): Vec {
  const d = ((dir % 16) + 16) % 16
  return d === Direction.east || d === Direction.west ? vec(size.y, size.x) : vec(size.x, size.y)
}

export function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b }
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.w, b.x + b.w)
  const bottom = Math.max(a.y + a.h, b.y + b.h)
  return { x, y, w: right - x, h: bottom - y }
}
