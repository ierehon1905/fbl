/** The atlas produced by `scripts/extract-sprites.mjs` from a local Factorio installation. */

import { fetchBytes, type OnProgress } from './progress'

export interface SpriteRect {
  /** Position and size inside atlas.png, in pixels. */
  x: number
  y: number
  w: number
  h: number
  /** Offset in tiles from the entity's centre to the sprite's top-left corner. */
  ox: number
  oy: number
}

/**
 * One of a machine's fluid connections, for the pipe stub it grows when its recipe uses a
 * fluid. `dir` is where it points with the machine facing north; it turns with the machine.
 */
export interface FluidBoxInfo {
  /** Which fluid box the art belongs to; several connections can share one. */
  box: string
  type: 'input' | 'output'
  /** Where the connection points with the machine facing north; it turns with the machine. */
  dir: number
  /** Where the connection sits, in tiles from the machine's centre, facing north. */
  pos: [number, number]
  /** Whether the game supplies a pipe stub for this box, and a cap for its open end. */
  stub: boolean
  cover: boolean
  /** Whether the box disappears when the recipe uses no fluid. */
  optional: boolean
}

export interface SpriteAtlas {
  gameVersion: string
  pixelsPerTile: number
  width: number
  height: number
  beltIndex: Record<string, number>
  entities: Record<string, Record<string, SpriteRect>>
  /** Only the machines whose stubs are separate sprites; the rest draw their own pipes. */
  fluidBoxes?: Record<string, FluidBoxInfo[]>
}

export interface LoadedAtlas {
  manifest: SpriteAtlas
  image: HTMLImageElement
}

let cached: Promise<LoadedAtlas | null> | undefined

/**
 * Returns null when the atlas is not there — the renderer falls back to plain footprints,
 * so the studio still works on a machine without Factorio installed.
 *
 * The atlas is 12MB, which is worth a progress bar rather than a spinner, so the PNG is
 * streamed rather than handed to `new Image()` — an Image reports nothing until it is done.
 */
export function loadAtlas(onProgress?: OnProgress): Promise<LoadedAtlas | null> {
  cached ??= (async () => {
    const base = `${import.meta.env.BASE_URL}sprites`

    const manifestResponse = await fetch(`${base}/atlas.json`).catch(() => undefined)
    if (!manifestResponse?.ok) return null
    if (!(manifestResponse.headers.get('content-type') ?? '').includes('json')) return null
    const manifest = (await manifestResponse.json()) as SpriteAtlas

    const blob = await fetchBytes(`${base}/atlas.png`, onProgress)
    if (!blob) return null

    const url = URL.createObjectURL(blob)
    const image = await new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => resolve(null)
      img.src = url
    })
    URL.revokeObjectURL(url)

    return image ? { manifest, image } : null
  })()
  return cached
}
