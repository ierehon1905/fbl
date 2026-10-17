import type { PlacedEntity } from '../core'

/**
 * Where an entity in the picture came from in the source.
 *
 * A blueprint is generated, so the picture cannot answer this on its own: one line read
 * twenty-four times makes twenty-four assemblers that are alike in every way the canvas can
 * see. The runtime stamps each one with the path it came by — the blocks that were called and
 * the turns of the loops — and this turns that into something to read.
 *
 * Two shapes, for the two places it is shown: one line under a tooltip, and the whole chain
 * along the bottom of the canvas.
 */

const ordinal = (at: number): string => {
  const n = at + 1
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

/** The tooltip's last line: the statement, and which reading of it this was. */
export function originText(entity: PlacedEntity): string {
  if (!entity.loc) return ''

  const loop = [...(entity.trace?.steps ?? [])].reverse().find((step) => step.kind === 'loop')
  const which =
    loop && loop.at !== undefined && loop.of !== undefined ? ` · ${ordinal(loop.at)} of ${loop.of}` : ''
  return `line ${entity.loc.line}${which}`
}

export interface Crumb {
  label: string
  line: number
  column: number
}

/** The whole path, outermost first, ending at the statement that placed this one. */
export function crumbs(entity: PlacedEntity): Crumb[] {
  const path: Crumb[] = (entity.trace?.steps ?? []).map((step) =>
    step.kind === 'block'
      ? { label: `${step.name} ()`, line: step.loc.line, column: step.loc.col }
      : {
          label:
            step.at !== undefined && step.of !== undefined
              ? `for ${step.name} · ${step.at + 1} of ${step.of}`
              : `for ${step.name}`,
          line: step.loc.line,
          column: step.loc.col,
        },
  )

  if (entity.loc) {
    path.push({ label: `:${entity.loc.line} ${entity.proto.name}`, line: entity.loc.line, column: entity.loc.col })
  }
  return path
}

/**
 * Everything a line of source produced.
 *
 * Matched on the line alone rather than the column: a caret sitting anywhere in a statement
 * means that statement, and a statement that spans two lines would otherwise light up only
 * from its first.
 */
export function madeOnLine(entities: readonly PlacedEntity[], line: number): PlacedEntity[] {
  return entities.filter((entity) => entity.loc?.line === line)
}
