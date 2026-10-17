#!/usr/bin/env node
/**
 * Builds a sprite atlas from a local Factorio installation.
 *
 * The game itself supplies the sprite definitions: `factorio --dump-data` writes the fully
 * resolved data.raw as JSON, which carries every filename, frame layout, shift and scale.
 * This script crops the referenced frames out of the game's own PNGs, composites the layers
 * of each entity into one image, and packs them into public/sprites/.
 *
 *   node scripts/extract-sprites.mjs [--dump <path>] [--data <path>] [--ppt 64]
 *
 * The art is Wube Software's copyright. It is read from the user's own installation, written
 * locally, and kept out of git — same policy as the icon sheets.
 */

import { copyFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

import { ProtoRegistry } from '../dist-node/core.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** One tile is 32px at scale 1, so 64 px/tile renders the scale-0.5 hi-res art 1:1. */
const DEFAULT_PIXELS_PER_TILE = 64
const TILE_PX = 32

const DIRECTION_NAMES = ['north', 'east', 'south', 'west']

/**
 * Factorio's default belt_animation_set indices, converted from Lua's 1-based values.
 * They are absent from the dump when a belt uses the defaults, which every vanilla belt does.
 * `scripts/extract-sprites.mjs --contact-sheet` renders them in order so they can be checked.
 */
const BELT_INDEX = {
  east: 0,
  west: 1,
  north: 2,
  south: 3,
  'east-to-north': 4,
  'north-to-east': 5,
  'west-to-north': 6,
  'north-to-west': 7,
  'south-to-east': 8,
  'east-to-south': 9,
  'south-to-west': 10,
  'west-to-south': 11,
  'starting-south': 12,
  'ending-south': 13,
  'starting-west': 14,
  'ending-west': 15,
  'starting-north': 16,
  'ending-north': 17,
  'starting-east': 18,
  'ending-east': 19,
}

// ── Locating the game ─────────────────────────────────────────────────────────

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function findDataDir() {
  const explicit = argValue('--data', process.env.FACTORIO_DATA)
  if (explicit) return explicit
  const candidates = [
    join(homedir(), 'Library/Application Support/Steam/steamapps/common/Factorio/factorio.app/Contents/data'),
    '/Applications/factorio.app/Contents/data',
    join(homedir(), '.steam/steam/steamapps/common/Factorio/data'),
    join(homedir(), '.factorio/data'),
    'C:/Program Files (x86)/Steam/steamapps/common/Factorio/data',
  ]
  return candidates.find((path) => existsSync(join(path, 'base')))
}

function findDump() {
  const explicit = argValue('--dump', process.env.FACTORIO_DUMP)
  if (explicit) return explicit
  const candidates = [
    join(homedir(), 'Library/Application Support/factorio/script-output/data-raw-dump.json'),
    join(homedir(), '.factorio/script-output/data-raw-dump.json'),
    join(homedir(), 'AppData/Roaming/Factorio/script-output/data-raw-dump.json'),
  ]
  return candidates.find((path) => existsSync(path))
}

// ── Sprite definition → layers ────────────────────────────────────────────────

/**
 * Resolves one sprite definition into flat layers.
 *
 * Frames are addressed as a grid: the row stride is `line_length`, falling back to
 * `frame_count` and then `direction_count`, which is how the game lays these sheets out.
 */
function resolveLayers(def, options = {}) {
  if (!def) return []
  const { direction = 0, variations = 0, frame = 0 } = options

  if (Array.isArray(def.layers)) {
    return def.layers.flatMap((layer) => resolveLayers(layer, options))
  }
  if (Array.isArray(def.sheets)) {
    return def.sheets.flatMap((sheet) => resolveLayers(sheet, options))
  }
  if (def.sheet) {
    return resolveLayers(def.sheet, options)
  }
  if (!def.filename && !Array.isArray(def.filenames)) return []

  // Light and glow layers are additive overlays in game; they read as noise on a flat canvas.
  if (def.draw_as_light || def.draw_as_glow) return []
  // Prototypes fill unused slots with a 1×1 transparent image rather than omitting them.
  if (def.filename === '__core__/graphics/empty.png') return []

  const width = def.width ?? def.size
  const height = def.height ?? def.size
  if (!width || !height) return []

  const directionCount = def.direction_count ?? variations
  const frameCount = def.frame_count ?? 1
  const lineLength = def.line_length || def.frame_count || directionCount || 1

  let index = (directionCount ? Math.min(direction, directionCount - 1) * frameCount : 0) + frame

  // Long animations are split across several files, `lines_per_file` rows in each.
  let filename = def.filename
  if (Array.isArray(def.filenames) && def.filenames.length) {
    const framesPerFile = (def.lines_per_file ?? 1) * lineLength
    const fileIndex = Math.min(Math.floor(index / framesPerFile), def.filenames.length - 1)
    filename = def.filenames[fileIndex]
    index %= framesPerFile
  }

  const column = index % lineLength
  const row = Math.floor(index / lineLength)

  const scale = def.scale ?? 1
  const [shiftX, shiftY] = def.shift ?? [0, 0]

  return [
    {
      filename,
      sx: (def.x ?? 0) + column * width,
      sy: (def.y ?? 0) + row * height,
      sw: width,
      sh: height,
      shiftX,
      shiftY,
      scale,
      shadow: Boolean(def.draw_as_shadow),
    },
  ]
}

/**
 * Sprite definitions nest inconsistently: a boiler's picture lives at
 * `pictures.north.structure`, a roboport's at `base.layers`. Descend through the known
 * container keys until something resolves.
 */
const CONTAINER_KEYS = ['structure', 'picture', 'sprite', 'animation', 'idle_animation', 'base', 'sheet', 'patch']

function firstDrawable(def, options = {}) {
  if (!def || typeof def !== 'object') return []
  const direct = resolveLayers(def, options)
  if (direct.length) return direct
  for (const key of CONTAINER_KEYS) {
    if (def[key]) {
      const nested = firstDrawable(def[key], options)
      if (nested.length) return nested
    }
  }
  return []
}

const fourWay = (def, extra = {}) =>
  Object.fromEntries(
    DIRECTION_NAMES.map((name, i) => [name, resolveLayers(def, { direction: i, variations: 4, ...extra })]),
  )

/** Splitters and some machines name their four sides explicitly instead of packing a sheet. */
const fourWayNamed = (map) =>
  Object.fromEntries(DIRECTION_NAMES.filter((n) => map?.[n]).map((n) => [n, firstDrawable(map[n])]))

/** The four straight orientations, by compass name. */
const STRAIGHT_BELT = {
  north: BELT_INDEX.north,
  east: BELT_INDEX.east,
  south: BELT_INDEX.south,
  west: BELT_INDEX.west,
}

/**
 * Splitters and undergrounds carry their own `belt_animation_set`, pointing at their tier's
 * sheet. The game lays that belt down first and puts the housing on top; the housing on its
 * own is a machine floating over bare ground.
 *
 * `offsets` are tile offsets from the entity centre — a splitter needs one belt per lane.
 */
function beltUnder(proto, direction, offsets = [[0, 0]]) {
  const set = proto.belt_animation_set?.animation_set
  if (!set) return []
  const layers = resolveLayers(set, { direction: STRAIGHT_BELT[direction] })
  return offsets.flatMap(([dx, dy]) =>
    layers.map((layer) => ({ ...layer, shiftX: layer.shiftX + dx, shiftY: layer.shiftY + dy })),
  )
}

/**
 * The belt beneath an underground is only half a tile: the hood covers the other half.
 * `keep` is which half of the tile the belt shows on.
 */
function beltHalf(proto, beltDirection, keep) {
  const set = proto.belt_animation_set?.animation_set
  if (!set) return []

  return resolveLayers(set, { direction: STRAIGHT_BELT[beltDirection] }).map((layer) => {
    const half = { ...layer }
    if (keep === 'west' || keep === 'east') {
      half.sw = layer.sw / 2
      half.sx = layer.sx + (keep === 'east' ? layer.sw / 2 : 0)
      half.shiftX = layer.shiftX + (keep === 'east' ? 0.5 : -0.5)
    } else {
      half.sh = layer.sh / 2
      half.sy = layer.sy + (keep === 'south' ? layer.sh / 2 : 0)
      half.shiftY = layer.shiftY + (keep === 'south' ? 0.5 : -0.5)
    }
    return half
  })
}

const OPPOSITE = { north: 'south', east: 'west', south: 'north', west: 'east' }

/** Which pipe picture to draw is decided from the neighbours at render time. */
const PIPE_VARIANTS = [
  'straight_vertical_single',
  'straight_vertical',
  'straight_horizontal',
  'corner_up_right',
  'corner_up_left',
  'corner_down_right',
  'corner_down_left',
  't_up',
  't_down',
  't_right',
  't_left',
  'cross',
  'ending_up',
  'ending_down',
  'ending_right',
  'ending_left',
]

/** Per-prototype-type graphics, because the field that holds them is not uniform. */
/**
 * Parts the game draws over a machine whatever it is doing. The electromagnetic plant's base
 * sprite is a shell with a hole where its innards go, and those live here rather than in the
 * animation — without them the hole shows the shadow underneath it as a black pit. The
 * cryogenic plant's glass is the same story.
 *
 * Only what a machine shows standing still: nothing that is working, nothing that moves on
 * its own (`animated_shift` — a mining drill's bit is inside the housing at every frame the
 * game actually draws, so a still of it is a black shaft), and no scorch mark, which is
 * ground the drill has burnt over time rather than anything a blueprint places.
 */
function alwaysDrawnLayers(proto, options = {}) {
  const list = proto.graphics_set?.working_visualisations ?? proto.working_visualisations
  if (!Array.isArray(list)) return []

  return list
    .filter((vis) => vis.always_draw && vis.animation)
    .filter((vis) => !vis.draw_in_states || vis.draw_in_states.includes('idle'))
    .filter((vis) => !vis.animated_shift && !vis.mining_drill_scorch_mark)
    .flatMap((vis) => resolveLayers(vis.animation, options))
}

const SIDE_NAMES = ['north', 'east', 'south', 'west']

/**
 * The pipe stubs a machine grows when its recipe uses a fluid. The game keeps them out of the
 * machine's own art — an assembler with a dry recipe has no pipes at all — and hands over one
 * sprite per side the connection can end up on once the machine is turned.
 *
 * Only boxes whose picture is a map of all four sides are taken: the foundry has a single
 * sprite for its own fixed orientation, and drawing that on an east-facing connection would be
 * inventing art the game never made.
 */
/**
 * A machine's fluid boxes, however the prototype spells them: an array for the crafting
 * machines, a pair of singular fields for boilers and generators. Each box can carry several
 * connections — a heat exchanger takes water on both ends.
 */
function fluidBoxList(proto) {
  const out = []
  if (Array.isArray(proto.fluid_boxes)) {
    proto.fluid_boxes.forEach((box, i) => out.push({ box, key: String(i), type: box?.production_type }))
  }
  if (proto.fluid_box) out.push({ box: proto.fluid_box, key: 'in', type: 'input' })
  if (proto.output_fluid_box) out.push({ box: proto.output_fluid_box, key: 'out', type: 'output' })
  return out.filter((entry) => entry.box?.pipe_connections?.length)
}

function fluidPipeVariants(proto) {
  const variants = {}
  fluidBoxList(proto).forEach(({ box, key }) => {
    for (const [prefix, art] of [
      ['pipe', box.pipe_picture],
      // The cap the game puts over a connection with nothing attached. A chemical plant's
      // own art has open pipe mouths; uncapped, you look straight down the hole.
      ['cover', box.pipe_covers],
    ]) {
      if (!art || !SIDE_NAMES.every((side) => art[side])) continue
      for (const side of SIDE_NAMES) {
        const layers = resolveLayers(art[side])
        if (layers.length) variants[`${prefix}-${key}-${side}`] = layers
      }
    }
  })
  return variants
}

/** Every fluid connection, so the renderer can turn each one with the machine. */
function fluidConnections(proto) {
  const has = (art) => Boolean(art) && SIDE_NAMES.every((side) => art[side])
  const out = []

  for (const { box, key, type } of fluidBoxList(proto)) {
    const stub = has(box.pipe_picture)
    const cover = has(box.pipe_covers)
    if (!stub && !cover) continue

    for (const connection of box.pipe_connections) {
      if (!connection?.position) continue
      out.push({
        box: key,
        type: type === 'output' ? 'output' : 'input',
        dir: connection.direction ?? 0,
        // Where the connection sits, in tiles from the machine's centre. The art is shifted
        // relative to that, not to the machine, so both have to be added up.
        pos: connection.position,
        stub,
        cover,
        // An assembler's boxes vanish on a dry recipe; a chemical plant's are always there.
        optional: Boolean(proto.fluid_boxes_off_when_no_fluid_recipe),
      })
    }
  }

  return out.length ? out : undefined
}

function variantsFor(type, proto) {
  const variants = { ...baseVariantsFor(type, proto), ...fluidPipeVariants(proto) }

  return Object.fromEntries(
    Object.entries(variants).map(([key, layers]) => {
      // A pipe stub is drawn as the game hands it over; the always-drawn parts belong to the
      // machine's body, not to it.
      if (!layers?.length || key.startsWith('pipe-')) return [key, layers]
      // Direction only, never `variations`: these sheets are frame strips, and telling
      // `resolveLayers` to treat them as four-way indexes past the end of the file.
      const direction = DIRECTION_NAMES.indexOf(key)
      return [key, [...layers, ...alwaysDrawnLayers(proto, direction < 0 ? {} : { direction })]]
    }),
  )
}

function baseVariantsFor(type, proto) {
  switch (type) {
    case 'transport-belt': {
      const set = proto.belt_animation_set?.animation_set
      if (!set) return {}
      return Object.fromEntries(
        Object.entries(BELT_INDEX).map(([name, index]) => [name, resolveLayers(set, { direction: index })]),
      )
    }
    case 'underground-belt': {
      // The game draws an output end rotated 180°: its hood faces back down the belt, so a
      // pair reads as two ramps facing each other. Only the structure turns — the belt still
      // runs the way items travel. The four passes are: the lip behind the belt, the belt
      // itself (half a tile), the hood, then the lip in front.
      const variants = {}

      for (const [index, name] of DIRECTION_NAMES.entries()) {
        for (const role of ['in', 'out']) {
          const drawIndex = role === 'in' ? index : (index + 2) % 4
          const drawName = DIRECTION_NAMES[drawIndex]
          const structure = role === 'in' ? proto.structure?.direction_in : proto.structure?.direction_out

          variants[`${role}-${name}`] = [
            ...resolveLayers(proto.structure?.back_patch, { direction: drawIndex, variations: 4 }),
            // The belt shows on the side the hood does not cover.
            ...beltHalf(proto, name, OPPOSITE[drawName]),
            ...resolveLayers(structure, { direction: drawIndex, variations: 4 }),
            ...resolveLayers(proto.structure?.front_patch, { direction: drawIndex, variations: 4 }),
          ]
        }
      }

      return variants
    }
    case 'splitter':
      return Object.fromEntries(
        DIRECTION_NAMES.filter((name) => proto.structure?.[name]).map((name) => {
          // Both lanes run the same way; they sit either side of the splitter's centre.
          const offsets =
            name === 'north' || name === 'south'
              ? [
                  [-0.5, 0],
                  [0.5, 0],
                ]
              : [
                  [0, -0.5],
                  [0, 0.5],
                ]
          return [
            name,
            [
              ...beltUnder(proto, name, offsets),
              // East and west splitters carry a second piece covering the far lane; the main
              // structure only reaches over the near one. North and south leave it empty.
              ...firstDrawable(proto.structure_patch?.[name]),
              ...firstDrawable(proto.structure[name]),
            ],
          ]
        }),
      )
    case 'loader-1x1':
    case 'loader':
      return fourWayNamed(proto.structure)
    case 'inserter':
      return fourWay(proto.platform_picture)
    case 'electric-pole':
      return { default: resolveLayers(proto.pictures, { direction: 0, variations: 4 }) }
    case 'pipe':
      return Object.fromEntries(
        PIPE_VARIANTS.filter((v) => proto.pictures?.[v]).map((v) => [
          v.replace(/_/g, '-'),
          resolveLayers(proto.pictures[v]),
        ]),
      )
    case 'pipe-to-ground':
      return fourWayNamed(proto.pictures)
    case 'heat-pipe':
      // Heat pipes name their corners differently from fluid pipes; one sprite is enough here.
      return { default: firstDrawable(proto.connection_sprites?.single) }
    case 'wall':
      return { default: firstDrawable(proto.pictures?.single ?? proto.pictures) }
    case 'generator': {
      // Steam engines and turbines have one sprite per axis, not per direction.
      const horizontal = firstDrawable(proto.horizontal_animation)
      const vertical = firstDrawable(proto.vertical_animation)
      return { north: vertical, east: horizontal, south: vertical, west: horizontal }
    }
    case 'gate': {
      const horizontal = firstDrawable(proto.horizontal_animation)
      const vertical = firstDrawable(proto.vertical_animation)
      return { north: vertical, east: horizontal, south: vertical, west: horizontal }
    }
    case 'accumulator':
      return { default: firstDrawable(proto.chargable_graphics?.picture) }
    case 'beacon':
      return { default: firstDrawable(proto.graphics_set?.animation_list?.[0]) }
    default:
      break
  }

  const generic = [
    proto.graphics_set?.animation,
    proto.graphics_set?.idle_animation,
    proto.animation,
    proto.animations,
    proto.picture,
    proto.pictures,
    proto.sprite,
    proto.sprites,
    proto.structure,
    proto.base,
    proto.folded_animation,
    proto.power_on_animation,
    proto.base_picture,
    proto.off_animation,
    proto.picture_off,
    proto.horizontal_animation,
    proto.vertical_animation,
    proto.base_day_sprite,
    proto.ground_picture_set,
    proto.connection_sprites?.single,
  ].find(Boolean)

  if (!generic) return {}

  // A 4-way map (north/east/south/west) rotates; anything else is drawn the same way round.
  if (DIRECTION_NAMES.some((n) => generic[n])) {
    const named = fourWayNamed(generic)
    if (Object.values(named).some((l) => l.length)) return named
  }

  const layers = firstDrawable(generic)
  return layers.length ? { default: layers } : {}
}

const prefixKeys = (prefix, map) =>
  Object.fromEntries(Object.entries(map).map(([k, v]) => [`${prefix}-${k}`, v]))

// ── Compositing ───────────────────────────────────────────────────────────────

const imageCache = new Map()

function resolveFile(dataDir, filename) {
  const match = /^__([A-Za-z0-9_-]+)__\/(.*)$/.exec(filename)
  return match ? join(dataDir, match[1], match[2]) : join(dataDir, filename)
}

async function loadImage(dataDir, filename) {
  const path = resolveFile(dataDir, filename)
  let entry = imageCache.get(path)
  if (!entry) {
    entry = existsSync(path) ? sharp(path) : null
    imageCache.set(path, entry)
  }
  return entry ? { path, image: sharp(path) } : null
}

/**
 * Composites one variant. Layer geometry is computed in tiles first — `shift` is in tiles and
 * `scale` maps sprite pixels to them — then converted to atlas pixels at `pixelsPerTile`.
 */
/** The opaque part of a rendered sprite, in pixels from its own top-left. */
async function inkBounds(buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let left = info.width
  let right = -1
  let top = info.height
  let bottom = -1

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      // Solid pixels only: a machine's shadow reaches far past its body, and the body is
      // what a pipe has to meet.
      if (data[(y * info.width + x) * 4 + 3] <= 200) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }

  return right < 0 ? null : { left, right, top, bottom }
}

/**
 * Pulls each pipe stub back until it touches the machine.
 *
 * The stub belongs at its fluid connection, which sits on the footprint edge — but a machine
 * is drawn in perspective, and its body does not reach that edge on every side. An assembler
 * overshoots its own top by a third of a tile and falls short of its sides by the same, so a
 * stub placed by the numbers meets the body at the top and floats a visible gap away from it
 * at the sides. Measuring the art and closing the gap is the only way to know: the offset is
 * a property of the drawing, and the prototype does not carry it.
 */
/** Which way a stub reaches: the art is keyed by the side it is seen from, so it is opposite. */
const OUTWARD = {
  north: { x: 0, y: 1 },
  east: { x: -1, y: 0 },
  south: { x: 0, y: -1 },
  west: { x: 1, y: 0 },
}
const AXIS_UNIT = { 0: { x: 0, y: -1 }, 4: { x: 1, y: 0 }, 8: { x: 0, y: 1 }, 12: { x: -1, y: 0 } }

async function seatPipes(rendered, boxes, pixelsPerTile) {
  const body = rendered.default ?? Object.values(rendered).find((v) => v)
  if (!body) return
  const bodyInk = await inkBounds(body.buffer)
  if (!bodyInk) return

  // Everything in tiles from the machine's centre.
  const bodyLeft = body.offsetX + bodyInk.left / pixelsPerTile
  const bodyRight = body.offsetX + (bodyInk.right + 1) / pixelsPerTile
  const bodyTop = body.offsetY + bodyInk.top / pixelsPerTile
  const bodyBottom = body.offsetY + (bodyInk.bottom + 1) / pixelsPerTile

  for (const [key, sprite] of Object.entries(rendered)) {
    // Covers cap a hole in the machine's own art and are already where they belong; only the
    // stubs, which stand outside it, have to be seated.
    const match = /^pipe-(.+)-(north|east|south|west)$/.exec(key)
    if (!match) continue

    const box = boxes?.find((b) => b.box === match[1])
    const ink = await inkBounds(sprite.buffer)
    if (!box || !ink) continue

    // The art is keyed by the side it is seen from, so the stub reaches out the opposite way.
    const side = match[2]
    const out = OUTWARD[side]
    // How far along its own axis the connection sits, which is where the renderer will put
    // this sprite once the machine has been turned to face that way.
    const unit = AXIS_UNIT[box.dir] ?? AXIS_UNIT[0]
    const reach = Math.abs(box.pos[0] * unit.x + box.pos[1] * unit.y)
    const anchorX = out.x * reach
    const anchorY = out.y * reach

    if (out.x > 0) {
      const near = anchorX + sprite.offsetX + ink.left / pixelsPerTile
      if (near > bodyRight) sprite.offsetX -= near - bodyRight
    } else if (out.x < 0) {
      const near = anchorX + sprite.offsetX + (ink.right + 1) / pixelsPerTile
      if (near < bodyLeft) sprite.offsetX += bodyLeft - near
    } else if (out.y > 0) {
      const near = anchorY + sprite.offsetY + ink.top / pixelsPerTile
      if (near > bodyBottom) sprite.offsetY -= near - bodyBottom
    } else {
      const near = anchorY + sprite.offsetY + (ink.bottom + 1) / pixelsPerTile
      if (near < bodyTop) sprite.offsetY += bodyTop - near
    }
  }
}

/** How much of a shadow sprite survives; the game draws them well short of solid. */
const SHADOW_ALPHA = 0.42

async function renderVariant(dataDir, layers, pixelsPerTile) {
  const placed = []
  for (const layer of layers) {
    const source = await loadImage(dataDir, layer.filename)
    if (!source) continue

    const tileW = (layer.sw * layer.scale) / TILE_PX
    const tileH = (layer.sh * layer.scale) / TILE_PX
    placed.push({
      ...layer,
      source,
      tileLeft: layer.shiftX - tileW / 2,
      tileTop: layer.shiftY - tileH / 2,
      tileW,
      tileH,
    })
  }
  if (placed.length === 0) return null

  const left = Math.min(...placed.map((l) => l.tileLeft))
  const top = Math.min(...placed.map((l) => l.tileTop))
  const right = Math.max(...placed.map((l) => l.tileLeft + l.tileW))
  const bottom = Math.max(...placed.map((l) => l.tileTop + l.tileH))

  const width = Math.max(1, Math.round((right - left) * pixelsPerTile))
  const height = Math.max(1, Math.round((bottom - top) * pixelsPerTile))

  // Shadows sit on a lower render layer in game; the dump lists them after the base sprite.
  placed.sort((a, b) => Number(b.shadow) - Number(a.shadow))

  const composites = []
  for (const layer of placed) {
    const w = Math.max(1, Math.round(layer.tileW * pixelsPerTile))
    const h = Math.max(1, Math.round(layer.tileH * pixelsPerTile))
    try {
      let region = layer.source.image
        .extract({ left: layer.sx, top: layer.sy, width: layer.sw, height: layer.sh })
        .resize(w, h, { kernel: 'lanczos3' })

      // A shadow sprite is solid black with the shape in its alpha, and the game draws it
      // translucent. `composite` has no opacity of its own, so thin the alpha with a
      // `dest-in` pass — otherwise every machine gets a hard black slab beside it.
      if (layer.shadow) {
        const veil = await sharp({
          create: { width: w, height: h, channels: 4, background: { r: 255, g: 255, b: 255, alpha: SHADOW_ALPHA } },
        })
          .png()
          .toBuffer()
        region = sharp(await region.ensureAlpha().png().toBuffer()).composite([{ input: veil, blend: 'dest-in' }])
      }

      composites.push({
        input: await region.png().toBuffer(),
        left: Math.round((layer.tileLeft - left) * pixelsPerTile),
        top: Math.round((layer.tileTop - top) * pixelsPerTile),
      })
    } catch (error) {
      console.warn(`  ! ${layer.filename}: ${error.message}`)
    }
  }
  if (composites.length === 0) return null

  const buffer = await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(
      composites.map(({ input, left: l, top: t, opacity }) => ({
        input,
        left: l,
        top: t,
        ...(opacity < 1 ? { blend: 'over' } : {}),
      })),
    )
    .png()
    .toBuffer()

  return { buffer, width, height, offsetX: left, offsetY: top }
}

// ── Atlas packing ─────────────────────────────────────────────────────────────

/** Shelf packer: sort by height, fill rows. Good enough and keeps the atlas readable. */
function pack(items, maxWidth) {
  const sorted = [...items].sort((a, b) => b.height - a.height)
  let x = 0
  let y = 0
  let rowHeight = 0
  for (const item of sorted) {
    if (x + item.width > maxWidth) {
      x = 0
      y += rowHeight + 2
      rowHeight = 0
    }
    item.x = x
    item.y = y
    x += item.width + 2
    rowHeight = Math.max(rowHeight, item.height)
  }
  return { width: maxWidth, height: y + rowHeight }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const dataDir = findDataDir()
const dumpPath = findDump()
const pixelsPerTile = Number(argValue('--ppt', DEFAULT_PIXELS_PER_TILE))

if (!dataDir) {
  console.error('Could not find the Factorio data directory. Pass --data <path> or set FACTORIO_DATA.')
  process.exit(1)
}
if (!dumpPath) {
  console.error(
    'Could not find data-raw-dump.json.\n' +
      'Run:  <factorio binary> --dump-data\n' +
      'then pass --dump <path> or set FACTORIO_DUMP.',
  )
  process.exit(1)
}

console.log(`data  ${dataDir}`)
console.log(`dump  ${dumpPath}`)

const raw = JSON.parse(await readFile(dumpPath, 'utf8'))
let gameVersion = 'unknown'
try {
  gameVersion = JSON.parse(await readFile(join(dataDir, 'base', 'info.json'), 'utf8')).version ?? 'unknown'
} catch {
  // The atlas still works without a version label; it only feeds the UI badge.
}

// A name like "steel-chest" exists as an item, a recipe AND an entity. Index every candidate
// and pick the one that actually carries placement graphics.
const GRAPHICS_FIELDS = [
  'graphics_set',
  'animation',
  'animations',
  'picture',
  'pictures',
  'sprite',
  'sprites',
  'structure',
  'belt_animation_set',
  'platform_picture',
  'base_picture',
  'off_animation',
  'picture_off',
  'chargable_graphics',
  'base',
  'folded_animation',
  'power_on_animation',
  'horizontal_animation',
  'vertical_animation',
  'connection_sprites',
  'ground_picture_set',
  'base_day_sprite',
]

const candidates = new Map()
for (const [type, protos] of Object.entries(raw)) {
  if (!protos || typeof protos !== 'object') continue
  for (const [name, proto] of Object.entries(protos)) {
    if (!proto || typeof proto !== 'object') continue
    if (!candidates.has(name)) candidates.set(name, [])
    candidates.get(name).push({ type, proto })
  }
}

const byName = new Map()
for (const [name, list] of candidates) {
  const drawable = list.find((c) => GRAPHICS_FIELDS.some((f) => c.proto[f]))
  if (drawable) byName.set(name, drawable)
}

// Extract exactly the entities the language can place.
const datasetId = argValue('--dataset', 'spa')
const dataset = JSON.parse(await readFile(join(ROOT, 'public/data', datasetId, 'data.json'), 'utf8'))
const registry = new ProtoRegistry(dataset, { id: datasetId, directionScale: 2, moduleFormat: 'items-array', supportsQuality: true })
const wanted = [...registry.entities.keys()]

const entries = []
const manifest = {}
const fluids = {}
let missing = []

for (const name of wanted) {
  const found = byName.get(name)
  if (!found) {
    missing.push(name)
    continue
  }
  const variants = variantsFor(found.type, found.proto)
  const rendered = {}

  for (const [key, layers] of Object.entries(variants)) {
    if (!layers?.length) continue
    const image = await renderVariant(dataDir, layers, pixelsPerTile)
    if (!image) continue
    const item = { name, key, ...image }
    entries.push(item)
    rendered[key] = item
  }

  await seatPipes(rendered, fluidConnections(found.proto), pixelsPerTile)

  if (Object.keys(rendered).length === 0) missing.push(name)
  else manifest[name] = rendered

  const connections = fluidConnections(found.proto)
  if (connections) fluids[name] = connections
}

if (entries.length === 0) {
  console.error('\nNo sprites were produced — check that --data points at a Factorio data directory.')
  process.exit(1)
}

const atlas = pack(entries, 4096)
console.log(`\npacking ${entries.length} sprites into ${atlas.width}×${atlas.height}`)

const outDir = join(ROOT, 'public/sprites')
await mkdir(outDir, { recursive: true })

const png = await sharp({
  create: { width: atlas.width, height: atlas.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite(entries.map((e) => ({ input: e.buffer, left: e.x, top: e.y })))
  .png({ compressionLevel: 9 })
  .toBuffer()

await writeFile(join(outDir, 'atlas.png'), png)

// What the browser keys its copy of the atlas on. GitHub Pages dates its ETags by the file's
// mtime, so every deploy looks like a change to it and a ten-minute cache window turns into a
// thirteen-megabyte download; the studio keeps the art itself, under this hash, and only goes
// to the network when the art is actually different.
const hash = createHash('sha256').update(png).digest('hex').slice(0, 12)

await writeFile(
  join(outDir, 'atlas.json'),
  JSON.stringify(
    {
      gameVersion,
      hash,
      pixelsPerTile,
      width: atlas.width,
      height: atlas.height,
      beltIndex: BELT_INDEX,
      fluidBoxes: fluids,
      entities: Object.fromEntries(
        Object.entries(manifest).map(([name, variants]) => [
          name,
          Object.fromEntries(
            Object.entries(variants).map(([key, v]) => [
              key,
              // x/y/w/h are atlas pixels; ox/oy are tiles from the entity centre to the
              // sprite's top-left corner, which is what carries `shift` through.
              { x: v.x, y: v.y, w: v.width, h: v.height, ox: round(v.offsetX), oy: round(v.offsetY) },
            ]),
          ),
        ]),
      ),
    },
    null,
    1,
  ),
)

function round(n) {
  return Math.round(n * 10000) / 10000
}

// The game's own icon, for the browser tab. One 128px file rather than the sheet of every
// item — the tab needs a face, and it comes from the same install as everything else here, so
// re-running the extractor keeps it honest instead of leaving it a blob nobody can re-derive.
const iconSource = join(dataDir, 'core/graphics/factorio-icon@2x.png')
if (existsSync(iconSource)) {
  copyFileSync(iconSource, join(ROOT, 'public/favicon.png'))
  console.log('favicon → public/favicon.png')
}

console.log(`atlas ${(png.length / 1024 / 1024).toFixed(1)}MB → public/sprites/atlas.png`)
console.log(`game version ${gameVersion}, ${Object.keys(manifest).length}/${wanted.length} entities`)
if (missing.length) console.log(`no sprite for: ${missing.join(', ')}`)
