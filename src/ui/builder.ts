import {
  applyEdit,
  callText,
  directionFromName,
  directionName,
  planRemove,
  planSlotEdit,
  refused,
  sharedWith,
  type Loc,
  type PlacedEntity,
  type ProtoRegistry,
  type SlotEdit,
  type Vec,
} from '../core'
import type { LabRecipe } from '../data/dataset'
import type { Held } from './canvas'
import { openPicker, type PickerOption } from './picker'
import { originText } from './provenance'

/**
 * Builder mode: changing what is on the map by changing what wrote it.
 *
 * Everything that writes lives behind this. The page without it is the page as it always was —
 * the left button pans, nothing is editable, and looking at where an entity came from still
 * works, because looking changes nothing.
 *
 * What can be changed is decided by the source, not by the panel: a value written as a literal
 * can be replaced, a slot the call never mentioned can be added, and anything worked out by an
 * expression is refused with the reason. The panel says which of those it is *before* the
 * click, which is the whole discipline — a mouse drag must never be answered with a special
 * case bolted into somebody's loop.
 */

export interface BuilderDeps {
  registry: () => ProtoRegistry | null
  sheet: () => import('./icons').IconSheet | null
  source: () => string
  entities: () => readonly PlacedEntity[]
  /** Writes one change through the editor, so it lands on the undo stack as one step. */
  patch: (start: Loc, end: Loc, text: string, label: string) => void
  /** Said out loud when an edit cannot be made. */
  complain: (message: string) => void
  /** Takes the last change back, so Ctrl+Z works with the map focused and not just the text. */
  undo: () => void
  /** Drops the selection, which is what Escape does before it does anything else. */
  deselect: () => void
  /** Says something that is not a complaint — what was copied, mostly. */
  note: (message: string) => void
  /** Puts something in the cursor, or empties it. */
  hold: (held: Held | null) => void
  /** Writes a new statement at the end of the source. */
  append: (statement: string) => void
}

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** What each facing looks like, so a row can be read without the word. */
const ARROWS: Record<string, string> = {
  north: '↑', northeast: '↗', east: '→', southeast: '↘',
  south: '↓', southwest: '↙', west: '←', northwest: '↖',
}

/** The 8 the language writes, in the order rotation walks them. */
const FACING = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest']

export class Builder {
  private on = false
  private entity: PlacedEntity | null = null
  /**
   * The entity under the pointer. The game calls this one "selected" and acts on it directly —
   * hover and press R and it turns — so everything that works without a click works off this,
   * and the clicked selection is only what the panel is about.
   */
  private under: PlacedEntity | null = null
  /** What the cursor is holding. Nothing else decides what the left button does. */
  private holding: Held | null = null

  constructor(
    private readonly panel: HTMLElement,
    private readonly button: HTMLElement,
    private readonly deps: BuilderDeps,
  ) {
    panel.addEventListener('click', (event) => this.onClick(event))
    button.addEventListener('click', () => this.toggle())
    document.addEventListener('keydown', (event) => this.onKey(event))
  }

  get active(): boolean {
    return this.on
  }

  /** Wired to the canvas: a run has been dragged out and let go of. */
  onDrawn(run: { from: Vec; corner?: Vec; to: Vec }): void {
    if (this.on && this.holding?.kind === 'belt') this.drew(run)
  }

  toggle(): void {
    this.on = !this.on
    document.body.classList.toggle('building', this.on)
    this.button.classList.toggle('active', this.on)
    this.button.setAttribute('aria-pressed', String(this.on))
    if (!this.on) this.take(null)
    this.render()
  }

  /** Picks something up, or puts it down. Leaving the mode empties the hand. */
  private take(held: Held | null): void {
    this.holding = this.on ? held : null
    this.deps.hold(this.holding)
    this.render()
  }

  /** Wired to the canvas: the pointer moved onto something, or off everything. */
  hover(entity: PlacedEntity | null): void {
    this.under = entity
    if (this.on && this.holding === null) this.render()
  }

  /**
   * The pipette, which is one key doing the two things the game has it do: with a full hand it
   * empties it, and with an empty one it takes whatever is under the pointer.
   */
  private pipette(): void {
    if (this.holding) return this.take(null)

    const entity = this.under ?? this.entity
    if (!entity) return
    this.take(
      entity.proto.kind === 'belt'
        ? { kind: 'belt' }
        : { kind: 'entity', proto: entity.proto, dir: entity.dir },
    )
  }

  /** The crafting menu: everything that can be put down, filed the way the game files it. */
  private openMenu(): void {
    const registry = this.deps.registry()
    if (!registry) return

    const options: PickerOption[] = [...registry.entities.values()].map((proto) => ({
      id: proto.name,
      label: proto.label,
      icon: registry.icons.get(proto.name),
      detail: `${proto.size.x}×${proto.size.y}${proto.moduleSlots ? ` · ${proto.moduleSlots} module slots` : ''}`,
    }))

    openPicker(this.button, {
      title: 'What to build',
      options,
      chosen: this.holding?.kind === 'entity' ? this.holding.proto.name : undefined,
      sheet: this.deps.sheet(),
      clear: { label: 'empty the cursor' },
      onPick: (name) => {
        if (!name) return this.take(null)
        const proto = registry.entities.get(name)
        if (proto) this.take(proto.kind === 'belt' ? { kind: 'belt' } : { kind: 'entity', proto, dir: 0 })
      },
    })
  }

  /** Wired to the canvas: the right button, which mines in the game and deletes here. */
  mined(entity: PlacedEntity | null): void {
    if (!this.on) return
    if (this.holding) return this.take(null)
    if (entity) this.remove(entity)
  }

  /** Wired to the canvas: a tile was clicked with something in the cursor. */
  placed(at: Vec, room: boolean): void {
    const held = this.holding
    if (!this.on || held?.kind !== 'entity') return
    // The ghost has been red for as long as the pointer has been here, so this is a
    // confirmation rather than news — but writing an overlap into the source and letting the
    // collision check complain afterwards would be the wrong way round.
    if (!room) return this.deps.complain(`${held.proto.label} does not fit at (${at.x}, ${at.y})`)

    const facing = held.dir === 0 ? '' : `, ${directionName(held.dir)}`
    this.deps.append(`${held.proto.name} (at (${at.x}, ${at.y})${facing})`)
  }

  /**
   * A run dragged out on the map, written down.
   *
   * It is an *addition*, which is why belts came before anything else that draws: there is no
   * value to replace and no loop to argue with, so a drag turns into one new statement and the
   * hardest question is where to put it. That question has the plainest answer available — the
   * end of the file, at the top level, where the coordinates on screen are the coordinates
   * written — and the alternative, writing into whichever block the caret is in, needs the
   * frame drawn on the canvas first or it lands somewhere nobody pointed at.
   */
  private drew(run: { from: Vec; corner?: Vec; to: Vec }): void {
    const at = (point: Vec) => `(${point.x}, ${point.y})`
    if (run.from.x === run.to.x && run.from.y === run.to.y) return

    const via = run.corner ? `, via (${at(run.corner)})` : ''
    this.deps.append(`belt (from ${at(run.from)}${via}, to ${at(run.to)}, auto)`)
  }

  /** Called when the selection changes, and again after every rebuild. */
  show(entity: PlacedEntity | null): void {
    this.entity = entity
    this.render()
  }

  private onKey(event: KeyboardEvent): void {
    const typing = document.activeElement?.closest('.monaco-editor, input, textarea')

    // The map and the editor share one history, so this is the same undo either way — it just
    // has to be reachable while the keyboard belongs to the canvas.
    if (!typing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      return this.deps.undo()
    }

    // The one thing worth copying from a generated blueprint is the line that generated it —
    // unless the reader has selected some text, in which case they meant that.
    const selectingText = !window.getSelection()?.isCollapsed
    if (!typing && !selectingText && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && this.entity) {
      event.preventDefault()
      return this.copySource()
    }

    if (typing || event.metaKey || event.ctrlKey || event.altKey) return

    // Out of the selection first, then out of the mode — the way one Escape peels one layer.
    if (event.key === 'Escape') {
      if (this.holding) return this.take(null)
      if (this.entity) return this.deps.deselect()
      if (this.on) return this.toggle()
      return
    }

    if (event.key === 'b' || event.key === 'B') {
      event.preventDefault()
      return this.toggle()
    }

    if (!this.on) return

    // R turns whatever is in the hand, and otherwise whatever is under the pointer — no click,
    // the way the game does it. The clicked selection is the fallback for a pointer that has
    // wandered off the map.
    if (event.key === 'r' || event.key === 'R') {
      event.preventDefault()
      return this.rotate(event.shiftKey ? -1 : 1)
    }

    if (event.key === 'q' || event.key === 'Q') {
      event.preventDefault()
      return this.pipette()
    }

    if (event.key === 'e' || event.key === 'E') {
      event.preventDefault()
      return this.openMenu()
    }

    // The quickbar, one slot deep, for the one thing that is drawn rather than placed.
    if (event.key === '1') {
      event.preventDefault()
      return this.take(this.holding?.kind === 'belt' ? null : { kind: 'belt' })
    }
  }

  /** The call that placed the selected entity, on the clipboard. Works in either mode. */
  private copySource(): void {
    const call = this.entity?.trace?.call
    if (!call) return this.deps.complain('nothing here was written as a call to copy')

    const text = callText(this.deps.source(), call)
    void navigator.clipboard.writeText(text).then(
      () => this.deps.note(`copied — ${text}`),
      () => this.deps.complain('the browser would not let the clipboard be written'),
    )
  }

  // ── What the panel offers ───────────────────────────────────────────────────

  private render(): void {
    const entity = this.entity
    const registry = this.deps.registry()

    // What is in the cursor outranks what is selected: while something is held, the panel is
    // about the drawing, because that is what the next click will do.
    if (this.on && this.holding) {
      const held = this.holding
      this.panel.hidden = false
      this.panel.innerHTML =
        held.kind === 'belt'
          ? `<header class="bhead"><b>Belt</b><span class="dim">1 · Esc</span></header>
             <p class="dim">drag to lay a run — it tunnels under whatever is in the way, and
             goes in at the end of the file</p>`
          : `<header class="bhead"><b>${escape(held.proto.label)}</b><span class="dim">Q · Esc</span></header>
             ${held.proto.rotatable ? this.facingRow(held.dir) : ''}
             <p class="dim">click to put one down, at the end of the file</p>`
      return
    }

    this.panel.hidden = !this.on || !entity || !registry
    if (!this.on || !entity || !registry) return

    const shared = sharedWith(this.deps.entities(), entity)
    const rows: string[] = []

    if (entity.proto.craftingSpeed) rows.push(this.row('recipe', entity.recipe, 'recipe', 'nothing yet'))
    if (registry.profile.supportsQuality) rows.push(this.row('quality', entity.quality ?? 'normal', 'quality'))
    if (entity.proto.rotatable) rows.push(this.facingRow(entity.dir))

    this.panel.innerHTML = `
      <header class="bhead">
        <b>${escape(entity.proto.label)}</b>
        <span class="dim">${escape(originText(entity))}</span>
      </header>
      ${rows.join('') || '<p class="dim">nothing here can be changed from the map yet</p>'}
      ${
        shared > 1
          ? `<p class="bwarn">one statement made ${shared} of these — a change here changes all of them</p>`
          : ''
      }
      <p class="bkeys">R turn · Q pipette · E build</p>`
  }

  /**
   * One row of the card: a label, then a control that fills the rest of it.
   *
   * Every row is the same shape on purpose. Three rows built three different ways — a picker
   * here, a bare word there, a key badge on the end of the third — line their values up at
   * three different places, and a card of six items reads as a card that has come apart.
   */
  private row(slot: string, value: string | undefined, kind: string, empty = 'none'): string {
    const registry = this.deps.registry()
    const icon = value ? registry?.icons.get(value) : undefined
    const art = icon
      ? `<i class="chip" style="${iconStyleOf(icon, this.deps.sheet())}"></i>`
      : '<i class="chip empty"></i>'
    const text = value
      ? `<span>${escape(value)}</span>`
      : `<span class="dim">${escape(empty)}</span>`
    return `
      <div class="brow">
        <label>${escape(slot)}</label>
        <button type="button" class="pick wide" data-slot="${escape(kind)}">${art}${text}</button>
      </div>`
  }

  /** The same row again, with an arrow for the facing and the key that turns it on the end. */
  private facingRow(dir: number): string {
    const name = directionName(dir)
    return `
      <div class="brow">
        <label>facing</label>
        <button type="button" class="pick wide" data-rotate title="turn it (R)">
          <i class="bdir">${ARROWS[name] ?? '·'}</i><span>${escape(name)}</span><kbd>R</kbd>
        </button>
      </div>`
  }

  // ── What it does about it ───────────────────────────────────────────────────

  private onClick(event: Event): void {
    const target = event.target as HTMLElement
    if (target.closest('[data-rotate]')) return this.rotate(1)

    const slot = target.closest<HTMLElement>('[data-slot]')?.dataset.slot
    if (slot === 'recipe') return this.pickRecipe(target)
    if (slot === 'quality') return this.pickQuality(target)
  }

  private pickRecipe(anchor: HTMLElement): void {
    const registry = this.deps.registry()
    const entity = this.entity
    if (!registry || !entity) return

    const options: PickerOption[] = [...registry.recipes.values()]
      .filter((recipe: LabRecipe) => (recipe.producers ?? []).includes(entity.proto.name))
      .map((recipe) => ({ id: recipe.id, label: recipe.name ?? recipe.id, icon: registry.icons.get(recipe.id) }))

    openPicker(anchor.closest('button') ?? anchor, {
      title: 'What it makes',
      options,
      chosen: entity.recipe,
      sheet: this.deps.sheet(),
      onPick: (recipe) => recipe && this.write('recipe', recipe),
    })
  }

  private pickQuality(anchor: HTMLElement): void {
    const registry = this.deps.registry()
    if (!registry || !this.entity) return

    openPicker(anchor.closest('button') ?? anchor, {
      title: 'Built to',
      options: registry.qualities.map((tier, at) => ({
        id: tier,
        label: tier,
        icon: registry.icons.get(tier),
        row: at,
      })),
      chosen: this.entity.quality ?? 'normal',
      sheet: this.deps.sheet(),
      onPick: (tier) => tier && this.write('quality', tier),
    })
  }

  /** The next facing round, or the one before it. */
  private rotate(by: number): void {
    // Something in the hand turns before it is put down, and nothing is written for it.
    if (this.holding?.kind === 'entity') {
      const at = FACING.indexOf(directionName(this.holding.dir))
      const next = FACING[(at + by * 2 + FACING.length) % FACING.length]
      return this.take({ ...this.holding, dir: directionFromName(next) ?? 0 })
    }

    const entity = this.under ?? this.entity
    if (!entity) return

    if (!entity.proto.rotatable) return this.deps.complain(`${entity.proto.label} does not turn`)

    const at = FACING.indexOf(directionName(entity.dir))
    const next = FACING[(at + by * 2 + FACING.length) % FACING.length]

    // An inserter written with `from` faces away from what it says, so the slot that was
    // written is the slot to change — anything else would flip it the wrong way.
    const slot = entity.trace?.slots?.from ? 'from' : 'dir'
    const value = slot === 'from' ? FACING[(FACING.indexOf(next) + 4) % FACING.length] : next
    this.write(slot, value, entity)
  }

  private write(slot: string, value: string, on?: PlacedEntity): void {
    const entity = on ?? this.entity
    if (!entity) return

    const plan = planSlotEdit(entity, slot, value)
    if (refused(plan)) return this.deps.complain(plan.reason)
    this.apply(plan, `set ${slot}`)
  }

  /** Takes an entity off the map by taking its statement out of the source. */
  private remove(entity: PlacedEntity): void {
    const plan = planRemove(entity, sharedWith(this.deps.entities(), entity))
    if (refused(plan)) return this.deps.complain(plan.reason)
    this.apply(plan, `remove ${entity.proto.name}`)
  }

  /**
   * One edit, put through the editor rather than into the text: that is what makes it a single
   * step of undo. What it should come out as is worked out first and checked afterwards, so a
   * patch that lands somewhere unintended is caught here rather than seen on the map.
   */
  private apply(plan: SlotEdit, label: string): void {
    const source = this.deps.source()
    const wanted = applyEdit(source, plan)

    if (plan.kind === 'replace') {
      this.deps.patch(plan.span.start, plan.span.end, plan.text, label)
    } else if (plan.kind === 'insert') {
      this.deps.patch(plan.at, plan.at, insertedText(source, plan.at, plan.label, plan.text), label)
    } else {
      // A statement alone on its line takes the line with it; one sharing a line — inside a
      // block written on one — takes only itself, brackets and all.
      const line = source.split('\n')[plan.span.start.line - 1] ?? ''
      const past = { line: plan.span.end.line, col: plan.span.end.col + 1 }
      const alone = line.trim() === callText(source, plan.span).trim()
      if (alone) this.deps.patch({ line: plan.span.start.line, col: 1 }, { line: plan.span.start.line + 1, col: 1 }, '', label)
      else this.deps.patch(plan.span.start, past, '', label)
    }

    if (this.deps.source() !== wanted) {
      this.deps.complain(`${label} did not land where it was meant to — nothing was changed`)
    }
  }
}

/** The text an insertion adds, which is the same thing `applyEdit` would have written. */
function insertedText(source: string, at: Loc, label: string, value: string): string {
  const marker = applyEdit(source, { kind: 'insert', at, label, text: value })
  const before = offsetOf(source, at)
  return marker.slice(before, marker.length - (source.length - before))
}

function offsetOf(source: string, loc: Loc): number {
  let at = 0
  for (let line = 1; line < loc.line; line++) {
    const next = source.indexOf('\n', at)
    if (next === -1) return source.length
    at = next + 1
  }
  return Math.min(at + loc.col - 1, source.length)
}

function iconStyleOf(icon: ReturnType<ProtoRegistry['icons']['get']>, sheet: import('./icons').IconSheet | null): string {
  return iconStyle(icon, sheet, 18)
}

import { iconStyle } from './icons'
