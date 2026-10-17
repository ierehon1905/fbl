#!/usr/bin/env node
/**
 * Puts a content hash of `atlas.png` into `atlas.json`, if it is not there already.
 *
 * The studio keeps the art in the browser under that hash, because GitHub Pages cannot be
 * relied on to: its ETags are the file's mtime and size, so every deploy looks like a change
 * and a thirteen-megabyte atlas comes down again. See docs/sprites.md.
 *
 * The extractor writes the hash too, but the atlas is not built here — it is fetched from the
 * `assets` branch, which may hold a manifest made before any of this existed. So the build
 * stamps it, every time, and nobody has to remember to regenerate anything.
 *
 * Does nothing at all when there is no atlas, which is the normal state of a fresh clone.
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sprites')

const png = await readFile(join(dir, 'atlas.png')).catch(() => null)
const text = await readFile(join(dir, 'atlas.json'), 'utf8').catch(() => null)
if (!png || !text) process.exit(0)

const manifest = JSON.parse(text)
const hash = createHash('sha256').update(png).digest('hex').slice(0, 12)
if (manifest.hash === hash) {
  console.log(`atlas already stamped ${hash}`)
  process.exit(0)
}

// Rebuilt rather than patched in place, so the hash sits next to the version it belongs with.
const { gameVersion, ...rest } = manifest
delete rest.hash
await writeFile(join(dir, 'atlas.json'), JSON.stringify({ gameVersion, hash, ...rest }, null, 1))
console.log(`stamped atlas ${hash}`)
