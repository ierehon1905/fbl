import './picker.css'

import type { LabIcon } from '../data/dataset'
import { iconStyle, type IconSheet } from './icons'

/**
 * Choosing a thing by looking at it.
 *
 * Everything in this calculator that is picked is a thing the game draws: a machine, a module,
 * a recipe, an item. A dropdown turns all of them into a column of words, which is the one
 * form in which they are hardest to tell apart — nobody recognises "Electromagnetic plant" as
 * fast as they recognise its picture, and a list of forty recipes reads as forty strings.
 *
 * So: a grid of icons, grouped the way the game groups them, with the name and the numbers
 * that matter under the cursor. The panel floats above everything rather than living in the
 * card that opened it, because the cards sit inside a zoomed frame and a menu that scales
 * with the diagram would be unusable at either end of the zoom.
 */

export interface PickerOption {
  id: string
  label: string
  /** The second line of the tooltip: speed, effects, ingredients — whatever decides it. */
  detail?: string
  icon?: LabIcon
  /** Heading to file it under, in the order the groups are first seen. */
  group?: string
  /** Position within a group, as the game orders its own menus. */
  row?: number
}

export interface PickerRequest {
  title: string
  options: PickerOption[]
  chosen?: string
  sheet: IconSheet | null
  /** An entry that clears the choice: "no modules", "leave it". */
  clear?: { label: string; detail?: string }
  /** Offered on module pickers, where filling every slot the same is the usual thing. */
  everySlot?: { label: string; on: boolean; onToggle: (on: boolean) => void }
  /**
   * What is being picked can be built to a quality, so the tier is chosen here rather than
   * anywhere else: it is a property of the thing, and this is where the thing is chosen.
   */
  quality?: { label: string; options: PickerOption[]; chosen: string; onPick: (id: string) => void }
  onPick: (id: string | null) => void
}

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Above this many, looking becomes searching. */
const SEARCH_AT = 28

let host: HTMLElement | null = null
let tip: HTMLElement | null = null
let current: PickerRequest | null = null

function ensure(): { host: HTMLElement; tip: HTMLElement } {
  if (!host) {
    host = document.createElement('div')
    host.className = 'picker'
    host.hidden = true
    document.body.append(host)

    host.addEventListener('click', onClick)
    host.addEventListener('input', onInput)
    host.addEventListener('pointerover', onHover)
    host.addEventListener('pointerleave', () => hideTip())
  }
  if (!tip) {
    tip = document.createElement('div')
    tip.className = 'picker-tip'
    tip.hidden = true
    document.body.append(tip)
  }
  return { host, tip }
}

export function openPicker(anchor: HTMLElement, request: PickerRequest): void {
  const { host } = ensure()
  current = request
  host.innerHTML = panelHtml(request, '')
  host.hidden = false
  place(host, anchor)

  host.querySelector<HTMLInputElement>('.picker-search')?.focus()
}

export function closePicker(): void {
  current = null
  if (host) host.hidden = true
  hideTip()
}

function place(host: HTMLElement, anchor: HTMLElement): void {
  const box = anchor.getBoundingClientRect()
  host.style.left = '0px'
  host.style.top = '0px'
  const own = host.getBoundingClientRect()

  const left = Math.min(Math.max(8, box.left), window.innerWidth - own.width - 8)
  const below = box.bottom + 6
  const top = below + own.height > window.innerHeight - 8 ? Math.max(8, box.top - own.height - 6) : below

  host.style.left = `${left}px`
  host.style.top = `${top}px`
}

function panelHtml(request: PickerRequest, query: string): string {
  const search = request.options.length >= SEARCH_AT
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? request.options.filter((option) => option.label.toLowerCase().includes(needle) || option.id.includes(needle))
    : request.options

  const groups = new Map<string, PickerOption[]>()
  for (const option of shown) {
    const key = option.group ?? ''
    const list = groups.get(key)
    if (list) list.push(option)
    else groups.set(key, [option])
  }

  const cells = [...groups]
    .map(([group, options]) => {
      const sorted = [...options].sort((a, b) => (a.row ?? 0) - (b.row ?? 0) || a.label.localeCompare(b.label))
      const heading = group ? `<h4>${escape(group)}</h4>` : ''
      return `${heading}<div class="picker-grid">${sorted.map((option) => cell(option, request)).join('')}</div>`
    })
    .join('')

  return `
    <header class="picker-head">
      <span>${escape(request.title)}</span>
      <button type="button" class="picker-x" data-close aria-label="close">×</button>
    </header>
    ${search ? `<input class="picker-search" placeholder="search…" value="${escape(query)}" autocomplete="off" spellcheck="false" />` : ''}
    ${request.clear ? `<button type="button" class="picker-clear" data-pick="">${escape(request.clear.label)}</button>` : ''}
    <div class="picker-body">${cells || '<p class="picker-none">nothing matches</p>'}</div>
    ${qualityRow(request)}
    ${
      request.everySlot
        ? `<label class="picker-foot"><input type="checkbox" data-every ${request.everySlot.on ? 'checked' : ''} />${escape(request.everySlot.label)}</label>`
        : ''
    }`
}

function qualityRow(request: PickerRequest): string {
  const quality = request.quality
  if (!quality || quality.options.length < 2) return ''

  const cells = quality.options
    .map(
      (option) => `<button type="button" class="quality-cell${option.id === quality.chosen ? ' on' : ''}"
        data-quality="${escape(option.id)}" data-label="${escape(option.label)}" data-detail="${escape(option.detail ?? '')}">
        <i class="chip" style="${iconStyle(option.icon, request.sheet, 18)}"></i>
      </button>`,
    )
    .join('')

  return `<div class="picker-quality"><span>${escape(quality.label)}</span>${cells}</div>`
}

function cell(option: PickerOption, request: PickerRequest): string {
  const chosen = option.id === request.chosen ? ' on' : ''
  return `<button type="button" class="picker-cell${chosen}" data-pick="${escape(option.id)}"
    data-label="${escape(option.label)}" data-detail="${escape(option.detail ?? '')}">
    <i class="chip" style="${iconStyle(option.icon, request.sheet, 32)}"></i>
  </button>`
}

function onClick(event: Event): void {
  const target = event.target as HTMLElement
  if (target.closest('[data-close]')) return closePicker()

  // Choosing a tier does not choose the thing, so the panel stays open and redraws in place.
  const quality = target.closest<HTMLElement>('[data-quality]')?.dataset.quality
  if (quality && current && host) {
    current.quality?.onPick(quality)
    if (current.quality) current.quality.chosen = quality
    const search = host.querySelector<HTMLInputElement>('.picker-search')?.value ?? ''
    host.innerHTML = panelHtml(current, search)
    return
  }

  const cell = target.closest<HTMLElement>('[data-pick]')
  if (!cell || !current) return

  const id = cell.dataset.pick ?? ''
  const pick = current.onPick
  closePicker()
  pick(id === '' ? null : id)
}

function onInput(event: Event): void {
  const target = event.target as HTMLElement
  if (!current || !host) return

  if (target.matches('[data-every]')) {
    current.everySlot?.onToggle((target as HTMLInputElement).checked)
    return
  }
  if (!target.matches('.picker-search')) return

  const query = (target as HTMLInputElement).value
  const body = host.querySelector('.picker-body')
  if (!body) return
  // Only the grid is redrawn, so the box keeps its focus and its caret.
  const fresh = document.createElement('div')
  fresh.innerHTML = panelHtml(current, query)
  body.innerHTML = fresh.querySelector('.picker-body')?.innerHTML ?? ''
}

function onHover(event: Event): void {
  const cell = (event.target as HTMLElement).closest<HTMLElement>('.picker-cell, .quality-cell')
  if (!cell) return hideTip()

  const { tip } = ensure()
  const detail = cell.dataset.detail
  tip.innerHTML = `<b>${escape(cell.dataset.label ?? '')}</b>${detail ? `<span>${escape(detail)}</span>` : ''}`
  tip.hidden = false

  // Beside the panel rather than over it, level with the cell under the cursor: a tooltip
  // that covers the grid it is describing hides the next thing you were about to look at.
  const panel = (host as HTMLElement).getBoundingClientRect()
  const box = cell.getBoundingClientRect()
  const own = tip.getBoundingClientRect()

  const right = panel.right + 8
  const left = right + own.width < window.innerWidth - 6 ? right : Math.max(6, panel.left - own.width - 8)
  tip.style.left = `${left}px`
  tip.style.top = `${Math.min(Math.max(6, box.top + box.height / 2 - own.height / 2), window.innerHeight - own.height - 6)}px`
}

function hideTip(): void {
  if (tip) tip.hidden = true
}

document.addEventListener('pointerdown', (event) => {
  if (!host || host.hidden) return
  const target = event.target as HTMLElement
  if (target.closest('.picker') || target.closest('[data-pick-open]')) return
  closePicker()
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closePicker()
})
