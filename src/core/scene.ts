import type { Diagnostic, Loc } from './errors'
import { rotateSize, unionRect, type Rect } from './geometry'
import type { Prototype } from './proto'

export interface ModuleSpec {
  name: string
  quality?: string
}

/** What a belt or chest is carrying. Metadata: it never reaches the blueprint. */
export interface ContentEntry {
  item: string
  /** Belts have two lanes; a chest entry names no side. */
  side?: 'left' | 'right'
}

/** An inserter's item filters. `negated` is Factorio's blacklist mode. */
export interface FilterSpec {
  items: string[]
  negated: boolean
}

/**
 * One step of the path an entity came by: a block that was called, or a turn of a loop.
 *
 * A blueprint is generated, so "where did this one come from" has no answer in the picture —
 * twenty-four assemblers can be one line of source read twenty-four times. The step records
 * which reading this was, which is what tells them apart.
 */
export interface TraceStep {
  kind: 'block' | 'loop'
  /** The block's name, or the loop's variable. */
  name: string
  /** For a loop: which turn this was, and how many there were. */
  at?: number
  of?: number
  loc: Loc
}

/** A stretch of source, from the first character to just past the last. */
export interface Span {
  start: Loc
  end: Loc
}

/**
 * Where a slot's value was written — which is what says whether it can be changed by pointing
 * at the thing it made.
 *
 * `span` present means the value is a literal standing in the call, and an edit replaces it.
 * Absent with `from: 'call'` means it was written but computed, and one example cannot say
 * which part of `x + i * 3` was meant. Absent otherwise means the call never mentioned it, so
 * an edit writes a new argument rather than changing an old one.
 */
export interface SlotOrigin {
  from: 'call' | 'defaults' | 'default'
  span?: Span
  /** The name it was handed under, when the call passed something it was given rather than wrote. */
  via?: string
}

/** The whole path, outermost first. Empty for a statement written at the top of a file. */
export interface Trace {
  steps: TraceStep[]
  /** Where each slot's value came from, for the slots something could be said about. */
  slots?: Record<string, SlotOrigin>
  /** The call that placed this, so a new argument has somewhere to go. */
  call?: Span
  /**
   * Where the frame's origin stood when this was placed. Layout combinators move a block
   * after the fact, so a tile on screen is not the `at` that was written; this is what reads
   * one back into the other.
   */
  origin: { x: number; y: number }
}

export interface PlacedEntity {
  proto: Prototype
  /** Top-left tile of the footprint *after* rotation, in absolute tile coordinates. */
  x: number
  y: number
  /** Footprint after rotation. */
  w: number
  h: number
  /** 16-point scale; the exporter rescales for 1.1. */
  dir: number
  recipe?: string
  modules?: ModuleSpec[]
  quality?: string
  undergroundType?: 'input' | 'output'
  /** Metadata only — what this belt or chest is meant to carry. */
  content?: ContentEntry[]
  /** Inserters and loaders. */
  filters?: FilterSpec
  /** Splitters. */
  inPriority?: 'left' | 'right'
  outPriority?: 'left' | 'right'
  splitterFilter?: string
  loc?: Loc
  /** How this one came to be placed — the calls and loops above it. */
  trace?: Trace
}

/**
 * The accumulator every placement writes into.
 *
 * Blocks and layout combinators work on *index ranges*: a child's entities are always a
 * contiguous slice, so `measure` can drop a range and `row` can shift one, with no need for
 * a separate scratch scene.
 */
const otherSide = (side: 'left' | 'right') => (side === 'left' ? 'right' : 'left')

/** What `transform` can do to a finished piece of scene. */
export type SceneTransform = 'flip-h' | 'flip-v' | 'flip-hv' | 'rotate-cw' | 'rotate-ccw'

/** A direction under a transform, on the 16-point scale. */
export function turnDirection(dir: number, apply: SceneTransform): number {
  switch (apply) {
    case 'flip-h':
      return (16 - dir) % 16
    case 'flip-v':
      return (24 - dir) % 16
    case 'flip-hv':
      return (dir + 8) % 16
    case 'rotate-cw':
      return (dir + 4) % 16
    case 'rotate-ccw':
      return (dir + 12) % 16
  }
}

export class Scene {
  readonly entities: PlacedEntity[] = []
  readonly diagnostics: Diagnostic[] = []

  /**
   * What to stamp on everything placed from here on. The runtime sets it as it walks in and
   * out of blocks and loops; the scene only carries it, which keeps the accumulator ignorant
   * of the evaluator that fills it.
   */
  stamp: (() => Trace) | null = null

  get length(): number {
    return this.entities.length
  }

  place(
    proto: Prototype,
    x: number,
    y: number,
    dir: number,
    extra: Partial<PlacedEntity> = {},
  ): PlacedEntity {
    const size = rotateSize(proto.size, proto.rotatable ? dir : 0)
    const entity: PlacedEntity = {
      proto,
      x,
      y,
      w: size.x,
      h: size.y,
      dir: proto.rotatable ? dir : 0,
      // Stamped here rather than at each of the seven places that place something, so a belt,
      // a tunnel end and a balancer's splitters all carry it without being asked to.
      trace: this.stamp?.(),
      ...extra,
    }
    this.entities.push(entity)
    return entity
  }

  warn(message: string, loc?: Loc, hint?: string): void {
    this.diagnostics.push({ severity: 'warning', message, loc, hint })
  }

  /** Bounding box over a half-open index range, in tiles. */
  bbox(from = 0, to = this.entities.length): Rect | null {
    let box: Rect | null = null
    for (let i = from; i < to; i++) {
      const e = this.entities[i]
      box = unionRect(box, { x: e.x, y: e.y, w: e.w, h: e.h })
    }
    return box
  }

  translate(from: number, to: number, dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return
    for (let i = from; i < to; i++) {
      this.entities[i].x += dx
      this.entities[i].y += dy
    }
  }

  /**
   * Turns or mirrors a range in place, around the box it occupies. The box keeps its top-left
   * corner; a quarter turn swaps its width and height, as it does in the game.
   *
   * Footprints move whole — an entity's far edge becomes its near one — so a 1×2 splitter
   * lands on the tiles it would have covered had it been built that way round. What cannot be
   * read off the geometry is handedness: a splitter's priorities and a belt's lanes are named
   * relative to the way the thing faces, and a mirror turns every left into a right. A
   * rotation does not, and two mirrors cancel, which is why only `flip-h` and `flip-v` swap
   * them.
   */
  transform(from: number, to: number, apply: SceneTransform): void {
    const box = this.bbox(from, to)
    if (!box) return

    const swapsHands = apply === 'flip-h' || apply === 'flip-v'

    for (let i = from; i < to; i++) {
      const entity = this.entities[i]

      if (apply === 'rotate-cw' || apply === 'rotate-ccw') {
        const u = entity.x - box.x
        const v = entity.y - box.y
        entity.x = box.x + (apply === 'rotate-cw' ? box.h - v - entity.h : v)
        entity.y = box.y + (apply === 'rotate-cw' ? u : box.w - u - entity.w)
        ;[entity.w, entity.h] = [entity.h, entity.w]
      } else {
        if (apply !== 'flip-v') entity.x = 2 * box.x + box.w - entity.x - entity.w
        if (apply !== 'flip-h') entity.y = 2 * box.y + box.h - entity.y - entity.h
      }

      // Something that cannot be turned keeps facing north; only its position moves. Every
      // such entity in the game is square, so its footprint comes out the same either way.
      if (entity.proto.rotatable) entity.dir = turnDirection(entity.dir, apply)
      else if (entity.w !== entity.h && apply !== 'flip-h' && apply !== 'flip-v') {
        this.warn(`${entity.proto.label} cannot be turned`, entity.loc)
      }

      if (!swapsHands) continue
      if (entity.inPriority) entity.inPriority = otherSide(entity.inPriority)
      if (entity.outPriority) entity.outPriority = otherSide(entity.outPriority)
      if (entity.content) {
        entity.content = entity.content.map((entry) =>
          entry.side ? { item: entry.item, side: otherSide(entry.side) } : entry,
        )
      }
    }
  }

  /** Drops entities by index. `auto` uses it for the tiles a tunnel turned out to cover. */
  remove(indices: ReadonlySet<number>): void {
    if (indices.size === 0) return
    const kept = this.entities.filter((_, index) => !indices.has(index))
    this.entities.length = 0
    this.entities.push(...kept)
  }

  /** Removes a range and returns it. Used by `measure`, which must not emit. */
  cut(from: number, to: number): PlacedEntity[] {
    return this.entities.splice(from, to - from)
  }

  /**
   * Overlap check, run once over the finished scene rather than incrementally — ranges get
   * moved and cut during evaluation, so an incremental occupancy index would need undo.
   */
  findCollisions(): Array<{ a: PlacedEntity; b: PlacedEntity; x: number; y: number }> {
    const occupied = new Map<string, number>()
    const clashes: Array<{ a: PlacedEntity; b: PlacedEntity; x: number; y: number }> = []
    // Pairs are keyed by index, not by name and position: three identical entities stacked
    // on one tile are two distinct overlaps, and both need reporting.
    const seen = new Set<string>()

    this.entities.forEach((entity, index) => {
      for (let dx = 0; dx < entity.w; dx++) {
        for (let dy = 0; dy < entity.h; dy++) {
          const key = `${entity.x + dx},${entity.y + dy}`
          const other = occupied.get(key)
          if (other === undefined) {
            occupied.set(key, index)
            continue
          }
          const pairKey = `${other}|${index}`
          if (seen.has(pairKey)) continue
          seen.add(pairKey)
          clashes.push({ a: this.entities[other], b: entity, x: entity.x + dx, y: entity.y + dy })
        }
      }
    })

    return clashes
  }
}
