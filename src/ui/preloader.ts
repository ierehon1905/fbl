import { formatBytes, type OnProgress } from '../data/progress'

/**
 * One gate over the whole page, held shut until everything the studio draws with is in.
 *
 * It used to be two things: a blocking overlay for the dataset and a corner chip for the art,
 * on the reasoning that the studio *works* without sprites. It does — but it works looking
 * like something else, and a reader who opens it mid-download watches the blueprint change
 * under them twice. Waiting is the lesser surprise.
 *
 * Never deadlocks. An asset that cannot be had is marked and the gate opens anyway; only the
 * dataset is fatal, because without recipes and footprints there is nothing to compile and
 * nothing to draw. And nothing is allowed to hang the studio by simply never answering: a
 * request still going after `PATIENCE` gives up its claim on the gate and finishes in the
 * background, where it lands the moment it arrives, which is how the art used to work anyway.
 */
const PATIENCE = 30_000

interface Tracked {
  label: string
  loaded: number
  total: number
  state: 'loading' | 'done' | 'failed'
  note?: string
}

/** What the right-hand side of a row says, which is a different thing in each state. */
function statusOf(asset: Tracked): string {
  if (asset.state === 'failed') return asset.note ?? 'not available'
  if (asset.state === 'done') return asset.note ?? 'ready'
  // Still going, and carrying a note means the gate gave up waiting on it.
  if (asset.note) return asset.note
  if (asset.total) return `${formatBytes(asset.loaded)} / ${formatBytes(asset.total)}`
  return formatBytes(asset.loaded)
}

export class Preloader {
  private readonly assets = new Map<string, Tracked>()
  private fatal: string | null = null
  private released = false
  private patience: number | undefined

  constructor(
    private readonly gate: HTMLElement,
    private readonly rows: HTMLElement,
    private readonly note: HTMLElement,
    /** Everything the gate is covering, made inert while it is shut. */
    private readonly app: HTMLElement,
  ) {
    this.shut()
  }

  /** Starts tracking one asset and returns the callback that feeds it. */
  track(key: string, label: string): OnProgress {
    this.assets.set(key, { label, loaded: 0, total: 0, state: 'loading' })
    this.shut()
    this.draw()
    return ({ loaded, total }) => {
      const asset = this.assets.get(key)
      if (!asset || asset.state !== 'loading') return
      asset.loaded = loaded
      asset.total = total
      this.draw()
    }
  }

  /** The progress callback for something already being tracked. */
  feed(key: string): OnProgress {
    return ({ loaded, total }) => {
      const asset = this.assets.get(key)
      if (!asset || asset.state !== 'loading') return
      asset.loaded = loaded
      asset.total = total
      this.draw()
    }
  }

  finish(key: string, note?: string): void {
    const asset = this.assets.get(key)
    if (asset) {
      asset.state = 'done'
      asset.note = note
    }
    this.settle()
  }

  /** Marks one asset as not coming. Only the dataset keeps the gate shut. */
  failed(key: string, note: string, fatal = false): void {
    const asset = this.assets.get(key)
    if (asset) {
      asset.state = 'failed'
      asset.note = note
    }
    if (fatal) this.fatal = note
    this.settle()
  }

  private settle(): void {
    this.draw()
    if (this.fatal) return
    if ([...this.assets.values()].some((asset) => asset.state === 'loading')) return
    this.release()
  }

  /**
   * Stops waiting on whatever is left and opens up. Set whenever the gate shuts, cleared when
   * it opens, so a request that never answers costs thirty seconds rather than the session.
   */
  private wait(): void {
    window.clearTimeout(this.patience)
    this.patience = window.setTimeout(() => {
      if (this.fatal || this.released) return
      for (const asset of this.assets.values()) {
        if (asset.state === 'loading') asset.note = 'still coming'
      }
      this.draw()
      this.release()
    }, PATIENCE)
  }

  private shut(): void {
    if (!this.released && this.gate.classList.contains('gone')) return
    this.released = false
    this.gate.classList.remove('gone')
    this.app.inert = true
    this.wait()
  }

  private release(): void {
    this.released = true
    window.clearTimeout(this.patience)
    this.gate.classList.add('gone')
    this.app.inert = false
  }

  private draw(): void {
    this.note.hidden = this.fatal === null
    this.note.textContent = this.fatal ?? ''

    this.rows.replaceChildren(
      ...[...this.assets.values()].map((asset) => {
        const row = document.createElement('div')
        row.className = `gate-row ${asset.state}`

        const label = document.createElement('span')
        label.className = 'gate-label'
        label.textContent = asset.label

        const size = document.createElement('span')
        size.className = 'gate-size'
        size.textContent = statusOf(asset)

        const track = document.createElement('div')
        track.className = 'gate-track'
        const bar = document.createElement('i')
        // Without a total the server did not say how big it is; show it moving, not lying.
        bar.className = asset.total || asset.state !== 'loading' ? 'gate-bar' : 'gate-bar unknown'
        bar.style.width =
          asset.state === 'loading'
            ? asset.total
              ? `${Math.min(100, (100 * asset.loaded) / asset.total)}%`
              : ''
            : '100%'
        track.append(bar)

        row.append(label, size, track)
        return row
      }),
    )
  }
}
