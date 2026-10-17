import type { Loc } from './errors'
import type { PlacedEntity, Span } from './scene'

/**
 * Changing what is on the map by changing what is in the source.
 *
 * The rule this file exists to keep is that an edit is either exact or refused. A slot whose
 * value stands in the call as a literal has a span, and changing it is a splice. A slot the
 * call never mentioned is an insertion. A slot filled by an expression — `dir (i == 0 ? north
 * : south)` — has neither, because one example cannot say which part of an expression was
 * meant, and guessing is how a generated blueprint turns into a pile of special cases.
 *
 * Nothing here is applied blind. The caller splices, re-runs the compiler, and checks the
 * entity actually changed the way the pointer asked; the whole pipeline is a fast pure
 * function of the text, so verification is a test rather than a proof.
 */

export type SlotEdit =
  /** The value is written in the call: put another in its place. */
  | { kind: 'replace'; span: Span; text: string }
  /** The call never said: write a new argument before its closing bracket. */
  | { kind: 'insert'; at: Loc; label: string; text: string }
  /** Take the whole call out, and the line with it if nothing else was on it. */
  | { kind: 'remove'; span: Span }

export interface Refusal {
  /** Said to the reader, in the terms of what they were trying to do. */
  reason: string
}

export const refused = (edit: SlotEdit | Refusal): edit is Refusal => 'reason' in edit

/**
 * How to write `value` into `slot` of the entity the pointer is on, or why it cannot be done.
 */
export function planSlotEdit(entity: PlacedEntity, slot: string, value: string): SlotEdit | Refusal {
  const trace = entity.trace
  if (!trace) return { reason: 'this was not placed by anything the source can point at' }

  const origin = trace.slots?.[slot]
  if (origin?.span) return { kind: 'replace', span: origin.span, text: value }

  if (origin?.via) {
    return {
      reason: `${slot} is whatever '${origin.via}' was, so it is set where this block is called rather than here`,
    }
  }
  if (origin?.from === 'call') {
    return { reason: `${slot} is worked out rather than written, so there is nothing here to replace` }
  }

  if (!trace.call) return { reason: 'this call has no brackets to write into' }
  return { kind: 'insert', at: trace.call.end, label: slot, text: value }
}

/**
 * Taking one entity off the map, which is taking its statement out of the source.
 *
 * Only where the statement made exactly this one. A call inside a loop stands for all of its
 * turns, so deleting "this one" would mean writing a condition into somebody's generator — the
 * same argument as editing one of them, and the same answer: say so rather than do it.
 */
export function planRemove(entity: PlacedEntity, shared: number): SlotEdit | Refusal {
  const call = entity.trace?.call
  if (!call) return { reason: 'this was not placed by a call the source can take out' }
  if (shared > 1) {
    return {
      reason: `one statement made ${shared} of these, so there is no way to remove just this one`,
    }
  }
  return { kind: 'remove', span: { start: call.start, end: call.end } }
}

/** Where a location falls in the text. Lines and columns are 1-based, as the lexer counts. */
function offsetOf(source: string, loc: Loc): number {
  let at = 0
  for (let line = 1; line < loc.line; line++) {
    const next = source.indexOf('\n', at)
    if (next === -1) return source.length
    at = next + 1
  }
  return Math.min(at + loc.col - 1, source.length)
}

export function applyEdit(source: string, edit: SlotEdit): string {
  if (edit.kind === 'remove') {
    // The span ends on the closing bracket rather than past it, because that is where an
    // insertion goes; a removal wants the bracket too.
    const from = offsetOf(source, edit.span.start)
    const to = offsetOf(source, edit.span.end) + 1
    const cut = source.slice(0, from) + source.slice(to)

    // A line left with nothing but whitespace on it was the statement's own line, and leaving
    // it behind turns a tidy file into a gappy one.
    const lines = cut.split('\n')
    const at = edit.span.start.line - 1
    if (lines[at] !== undefined && lines[at].trim() === '') lines.splice(at, 1)
    return lines.join('\n')
  }

  if (edit.kind === 'replace') {
    const from = offsetOf(source, edit.span.start)
    const to = offsetOf(source, edit.span.end)
    return source.slice(0, from) + edit.text + source.slice(to)
  }

  // Before the closing bracket, and with a comma only when something is already in there.
  const at = offsetOf(source, edit.at)
  const before = source.slice(0, at).replace(/\s+$/, '')
  const empty = before.endsWith('(')
  return `${source.slice(0, at)}${empty ? '' : ', '}${edit.label} ${edit.text}${source.slice(at)}`
}

/**
 * The call as it was written, brackets and all.
 *
 * The span's end is the closing bracket's own position rather than one past it, because that
 * is where an insertion goes; copying wants the bracket itself, so it reaches one further.
 */
export function callText(source: string, span: Span): string {
  return source.slice(offsetOf(source, span.start), offsetOf(source, span.end) + 1)
}

/**
 * How many times the statement behind an entity was run — which is how many things an edit to
 * it will change, and whether "just this one" means anything.
 *
 * Runs, not entities, and the difference is the whole point. One `belt` statement lays thirteen
 * tiles in a single run: editing it changes one belt and removing it removes one belt, so there
 * is nothing to warn about. The same statement inside a loop of twenty-four is read
 * twenty-four times, and every one of those readings is a separate thing on the map that an
 * edit would take with it.
 */
export function sharedWith(entities: readonly PlacedEntity[], entity: PlacedEntity): number {
  if (!entity.loc) return 1

  const statement = `${entity.loc.line}:${entity.loc.col}`
  const runs = new Set<string>()
  for (const other of entities) {
    if (`${other.loc?.line}:${other.loc?.col}` !== statement) continue
    runs.add((other.trace?.steps ?? []).map((step) => `${step.kind}:${step.name}:${step.at ?? ''}`).join('>'))
  }
  return Math.max(1, runs.size)
}
