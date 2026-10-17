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
  /** Content hash of `atlas.png`, written by the extractor. The key the browser keeps it under. */
  hash?: string
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
/** Where the browser keeps the art, so a deploy does not cost thirteen megabytes. */
const STORE = 'fbl-sprites'

/**
 * What to file this art under.
 *
 * The hash the build stamps into the manifest is the exact answer — it is of the PNG itself.
 * An atlas published before that existed has none, and rather than give up on caching it, the
 * manifest's own text stands in: it carries the game version, the sheet's dimensions and the
 * rectangle of every sprite on it, so art that changed without changing any of those would
 * have to be a recompression of the identical layout.
 */
function keyFor(manifest: SpriteAtlas, text: string): string {
  if (manifest.hash) return manifest.hash

  // djb2 over the manifest: not a strong hash, and it does not need to be. It is a cache key
  // for one file served from one place, not a signature.
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return `m${(h >>> 0).toString(36)}`
}

/**
 * The atlas bytes, from this browser's own copy if it has one.
 *
 * The HTTP cache cannot be relied on here. GitHub Pages dates its ETags by the file's mtime
 * and allows ten minutes of freshness, so every deploy — even one that does not touch the art
 * — invalidates it and the next visit pulls the whole PNG again. The manifest carries a hash
 * of the art's contents, which is the thing that actually changes when the art changes, so the
 * copy is kept under that and the network is asked only when the hash is new.
 *
 * Every step of it is optional. A browser with no Cache Storage, a private window, a quota
 * refusal — any of them falls through to a plain fetch, which is what used to happen anyway.
 */
async function atlasBytes(url: string, hash: string, onProgress?: OnProgress): Promise<Blob | null> {
  const key = `${url}?v=${hash}`
  const store = typeof caches !== 'undefined' ? await caches.open(STORE).catch(() => undefined) : undefined

  if (store) {
    const kept = await store.match(key).catch(() => undefined)
    if (kept) {
      const blob = await kept.blob()
      // Nothing was downloaded, so the bar jumps straight to full rather than never moving.
      onProgress?.({ loaded: blob.size, total: blob.size })
      return blob
    }
  }

  const blob = await fetchBytes(url, onProgress)
  if (!blob || !store) return blob

  await store.put(key, new Response(blob)).catch(() => undefined)
  // Last version out: the art is one file and old hashes are only taking up room.
  for (const stale of await store.keys().catch(() => [])) {
    if (stale.url !== new Request(key).url) void store.delete(stale)
  }
  return blob
}

export function loadAtlas(onProgress?: OnProgress): Promise<LoadedAtlas | null> {
  cached ??= (async () => {
    const base = `${import.meta.env.BASE_URL}sprites`

    const manifestResponse = await fetch(`${base}/atlas.json`).catch(() => undefined)
    if (!manifestResponse?.ok) return null
    if (!(manifestResponse.headers.get('content-type') ?? '').includes('json')) return null
    const manifestText = await manifestResponse.text()
    const manifest = JSON.parse(manifestText) as SpriteAtlas

    const blob = await atlasBytes(`${base}/atlas.png`, keyFor(manifest, manifestText), onProgress)
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
