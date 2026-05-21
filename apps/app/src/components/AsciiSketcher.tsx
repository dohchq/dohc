import { useEffect, useMemo, useRef, useState } from 'react'
import {
  decodeAsciiSketchContent,
  decodeAsciiSketchLanguage,
  encodeAsciiSketchContent,
} from '../lib/asciiSketchMetadata'

// Retained-mode ASCII sketcher. Shapes are first-class objects — you can
// select them after placement, drag to move, change fill density, delete,
// undo/redo. Everything rasterizes onto a single ASCII grid on render
// and on export. "Color" is impossible in plain ASCII, so we approximate
// shading with Unicode density characters: ░ ▒ ▓ █.

// Empty canvas baseline. While editing, the rendered grid is a sliding
// viewport-sized window with extra pan headroom. Export still sizes itself
// from the full retained shape bounds.
const BASE_GRID_W = 80
const BASE_GRID_H = 24
const PAD_X = 12
const PAD_Y = 4
// Pan headroom — how many *extra* cells past the viewport edge the grid
// keeps available at all times. Bigger = more room to pan before we need
// to grow further. We bump this on every pan-grow so the canvas feels
// like it just keeps going.
// Cells of buffer on EACH side of the visible viewport. The rendered grid
// is a "window" of viewportCells + 2 × HEADROOM cells that slides as the
// user pans, so every visible pixel always lands on a real cell.
const PAN_HEADROOM_W = 64
const PAN_HEADROOM_H = 24
const SKETCH_CLIPBOARD_PREFIX = 'dohc-ascii-sketch-clipboard:v1:'

type FillStyle = 'none' | 'light' | 'medium' | 'dark' | 'solid'
const FILL_CHARS: Record<FillStyle, string> = {
  none: ' ',
  light: '░',
  medium: '▒',
  dark: '▓',
  solid: '█',
}
const DENSITY_FILLS: FillStyle[] = ['light', 'medium', 'dark', 'solid']

type Cell = { x: number; y: number }
type Rect2 = { x1: number; y1: number; x2: number; y2: number }

// Rect-like shapes carry an optional `text` field that's rendered centered
// inside them on rasterize, so the label moves & resizes with the shape.
// Line/arrow shapes can carry text too — rendered at the polyline midpoint.
// `textSize`/`size` controls CSS glyph scale. The rasterized export stays
// regular ASCII, while the live editor uses the saved scale for display.
type TextSize = 's' | 'm' | 'l' | 'xl'
type LineVariant = 'straight' | 'elbow'
type RectShape = { id: string; type: 'rect'; rect: Rect2; fill: FillStyle; text?: string; textSize?: TextSize }
type EllipseShape = { id: string; type: 'ellipse'; rect: Rect2; fill: FillStyle; text?: string; textSize?: TextSize }
type DiamondShape = { id: string; type: 'diamond'; rect: Rect2; fill: FillStyle; text?: string; textSize?: TextSize }
type LineShape = {
  id: string
  type: 'line' | 'arrow'
  points: Cell[]
  variant?: LineVariant
  text?: string
  textSize?: TextSize
}
type TextShape = { id: string; type: 'text'; x: number; y: number; text: string; size?: TextSize }
type FreedrawShape = { id: string; type: 'freedraw'; points: Cell[] }

type Shape =
  | RectShape
  | EllipseShape
  | DiamondShape
  | LineShape
  | TextShape
  | FreedrawShape

type SketchSnapshot = {
  v: 1
  shapes: Shape[]
}

type SketchClipboardPayload = SketchSnapshot

type Tool =
  | 'select'
  | 'rect'
  | 'ellipse'
  | 'diamond'
  | 'line'
  | 'arrow'
  | 'text'
  | 'freedraw'
  | 'erase'

const TOOLS: { id: Tool; label: string; key: string; glyph: string }[] = [
  { id: 'select', label: 'select', key: 'V', glyph: '↖' },
  { id: 'rect', label: 'rectangle', key: 'R', glyph: '▭' },
  { id: 'ellipse', label: 'ellipse', key: 'O', glyph: '◯' },
  { id: 'diamond', label: 'diamond', key: 'D', glyph: '◇' },
  { id: 'line', label: 'line', key: 'L', glyph: '╱' },
  { id: 'arrow', label: 'arrow', key: 'A', glyph: '→' },
  { id: 'text', label: 'text', key: 'T', glyph: 'T' },
  { id: 'freedraw', label: 'draw', key: 'P', glyph: '✎' },
  { id: 'erase', label: 'erase', key: 'E', glyph: '⌫' },
]

const LINE_VARIANTS: { id: LineVariant; label: string }[] = [
  { id: 'straight', label: 'straight' },
  { id: 'elbow', label: 'elbow' },
]

// ---------- helpers ----------

let _uid = 0
function uid(): string {
  _uid += 1
  return `s${_uid}_${Math.random().toString(36).slice(2, 6)}`
}

function blankGrid(w: number, h: number): string[][] {
  return Array.from({ length: h }, () => Array.from({ length: w }, () => ' '))
}

// setCell is "additive" — it never overwrites a non-space cell with a space.
// This keeps fills from clobbering outlines that were drawn first.
function setCell(grid: string[][], x: number, y: number, ch: string) {
  if (y < 0 || y >= grid.length || x < 0 || x >= grid[0].length) return
  if (ch === ' ') return
  grid[y][x] = ch
}

function normalizeRect(r: Rect2): Rect2 {
  return {
    x1: Math.min(r.x1, r.x2),
    y1: Math.min(r.y1, r.y2),
    x2: Math.max(r.x1, r.x2),
    y2: Math.max(r.y1, r.y2),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isFillStyle(value: unknown): value is FillStyle {
  return (
    value === 'none' ||
    value === 'light' ||
    value === 'medium' ||
    value === 'dark' ||
    value === 'solid'
  )
}

function isTextSize(value: unknown): value is TextSize {
  return value === 's' || value === 'm' || value === 'l' || value === 'xl'
}

function isLineVariant(value: unknown): value is LineVariant {
  return value === 'straight' || value === 'elbow'
}

function readCell(value: unknown): Cell | null {
  if (!isRecord(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return null
  return { x: Math.round(value.x), y: Math.round(value.y) }
}

function readRect(value: unknown): Rect2 | null {
  if (
    !isRecord(value) ||
    !isFiniteNumber(value.x1) ||
    !isFiniteNumber(value.y1) ||
    !isFiniteNumber(value.x2) ||
    !isFiniteNumber(value.y2)
  ) {
    return null
  }
  return {
    x1: Math.round(value.x1),
    y1: Math.round(value.y1),
    x2: Math.round(value.x2),
    y2: Math.round(value.y2),
  }
}

function readCells(value: unknown, minLength: number): Cell[] | null {
  if (!Array.isArray(value) || value.length < minLength) return null
  const points = value.map(readCell)
  if (points.some((point) => !point)) return null
  return points.filter((point): point is Cell => point !== null)
}

function readShapeSnapshot(value: unknown): Shape | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.type !== 'string') {
    return null
  }
  const text = typeof value.text === 'string' ? value.text : undefined
  const textSize = isTextSize(value.textSize) ? value.textSize : undefined

  if (value.type === 'rect' || value.type === 'ellipse' || value.type === 'diamond') {
    const rect = readRect(value.rect)
    if (!rect || !isFillStyle(value.fill)) return null
    return {
      id: value.id,
      type: value.type,
      rect,
      fill: value.fill,
      ...(text === undefined ? {} : { text }),
      ...(textSize === undefined ? {} : { textSize }),
    }
  }

  if (value.type === 'line' || value.type === 'arrow') {
    const points = readCells(value.points, 2)
    if (!points) return null
    const variant = isLineVariant(value.variant) ? value.variant : undefined
    return {
      id: value.id,
      type: value.type,
      points,
      ...(variant === undefined ? {} : { variant }),
      ...(text === undefined ? {} : { text }),
      ...(textSize === undefined ? {} : { textSize }),
    }
  }

  if (value.type === 'text') {
    if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y) || typeof value.text !== 'string') {
      return null
    }
    const size = isTextSize(value.size) ? value.size : undefined
    return {
      id: value.id,
      type: 'text',
      x: Math.round(value.x),
      y: Math.round(value.y),
      text: value.text,
      ...(size === undefined ? {} : { size }),
    }
  }

  if (value.type === 'freedraw') {
    const points = readCells(value.points, 1)
    if (!points) return null
    return { id: value.id, type: 'freedraw', points }
  }

  return null
}

function readSnapshotPayload(decoded: unknown): Shape[] | null {
  if (!isRecord(decoded) || decoded.v !== 1 || !Array.isArray(decoded.shapes)) return null
  const shapes = decoded.shapes.map(readShapeSnapshot)
  if (shapes.some((shape) => !shape)) return null
  return shapes.filter((shape): shape is Shape => shape !== null)
}

function readSnapshotShapes(language: string | undefined): Shape[] | null {
  return readSnapshotPayload(decodeAsciiSketchLanguage(language))
}

function encodeShapeClipboard(shapes: Shape[]): string {
  const payload: SketchClipboardPayload = { v: 1, shapes: shapes.map((shape) => cloneShape(shape)) }
  return `${SKETCH_CLIPBOARD_PREFIX}${JSON.stringify(payload)}`
}

function decodeShapeClipboard(text: string): Shape[] | null {
  if (!text.startsWith(SKETCH_CLIPBOARD_PREFIX)) return null

  try {
    return readSnapshotPayload(JSON.parse(text.slice(SKETCH_CLIPBOARD_PREFIX.length)))
  } catch {
    return null
  }
}

function writeSystemClipboard(text: string) {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return
  void navigator.clipboard.writeText(text).catch(() => undefined)
}

async function readSystemClipboard(): Promise<string | null> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) return null
  try {
    return await navigator.clipboard.readText()
  } catch {
    return null
  }
}

function pointInRect(p: Cell, r: Rect2): boolean {
  const n = normalizeRect(r)
  return p.x >= n.x1 && p.x <= n.x2 && p.y >= n.y1 && p.y <= n.y2
}

function cellDistance(a: Cell, b: Cell): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
}

function pointsBounds(points: Cell[]): Rect2 {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const p of points) {
    if (p.x < x1) x1 = p.x
    if (p.y < y1) y1 = p.y
    if (p.x > x2) x2 = p.x
    if (p.y > y2) y2 = p.y
  }
  return { x1, y1, x2, y2 }
}

function shapeBounds(s: Shape): Rect2 {
  switch (s.type) {
    case 'rect':
    case 'ellipse':
    case 'diamond':
      return normalizeRect(s.rect)
    case 'line':
    case 'arrow':
      return pointsBounds(s.points)
    case 'text':
      return textVisualBounds(s.x, s.y, s.text, s.size)
    case 'freedraw': {
      return pointsBounds(s.points)
    }
  }
}

function moveShape(s: Shape, dx: number, dy: number): Shape {
  switch (s.type) {
    case 'rect':
    case 'ellipse':
    case 'diamond':
      return {
        ...s,
        rect: {
          x1: s.rect.x1 + dx,
          y1: s.rect.y1 + dy,
          x2: s.rect.x2 + dx,
          y2: s.rect.y2 + dy,
        },
      }
    case 'line':
    case 'arrow':
      return {
        ...s,
        points: s.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      }
    case 'text':
      return { ...s, x: s.x + dx, y: s.y + dy }
    case 'freedraw':
      return { ...s, points: s.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) }
  }
}

function cloneShape(shape: Shape, id: string = shape.id): Shape {
  switch (shape.type) {
    case 'rect':
    case 'ellipse':
    case 'diamond':
      return { ...shape, id, rect: { ...shape.rect } }
    case 'line':
    case 'arrow':
      return { ...shape, id, points: shape.points.map((p) => ({ ...p })) }
    case 'text':
      return { ...shape, id }
    case 'freedraw':
      return { ...shape, id, points: shape.points.map((p) => ({ ...p })) }
  }
}

function cloneShapeForPaste(shape: Shape, dx: number, dy: number): Shape {
  return moveShape(cloneShape(shape, uid()), dx, dy)
}

function bresenham(a: Cell, b: Cell): Cell[] {
  const pts: Cell[] = []
  let x0 = a.x
  let y0 = a.y
  const x1 = b.x
  const y1 = b.y
  const dx = Math.abs(x1 - x0)
  const dy = Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx - dy
  for (;;) {
    pts.push({ x: x0, y: y0 })
    if (x0 === x1 && y0 === y1) break
    const e2 = 2 * err
    if (e2 > -dy) {
      err -= dy
      x0 += sx
    }
    if (e2 < dx) {
      err += dx
      y0 += sy
    }
  }
  return pts
}

function dedupeAdjacentCells(points: Cell[]): Cell[] {
  return points.filter((point, index, all) => index === 0 || !sameCell(point, all[index - 1]))
}

function elbowSegmentRoute(from: Cell, to: Cell): Cell[] {
  if (sameCell(from, to)) return [from]
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (dx === 0 || dy === 0) return [from, to]

  if (Math.abs(dx) >= Math.abs(dy)) {
    const midX = Math.round((from.x + to.x) / 2)
    return dedupeAdjacentCells([
      from,
      { x: midX, y: from.y },
      { x: midX, y: to.y },
      to,
    ])
  }

  const midY = Math.round((from.y + to.y) / 2)
  return dedupeAdjacentCells([
    from,
    { x: from.x, y: midY },
    { x: to.x, y: midY },
    to,
  ])
}

function lineRenderPoints(points: Cell[], variant: LineVariant | undefined): Cell[] {
  if (points.length <= 1 || variant !== 'elbow') return points
  const routed: Cell[] = []
  for (let i = 1; i < points.length; i++) {
    const segment = elbowSegmentRoute(points[i - 1], points[i])
    if (routed.length === 0) routed.push(...segment)
    else routed.push(...segment.slice(1))
  }
  return dedupeAdjacentCells(routed)
}

function linePathCells(points: Cell[], variant: LineVariant | undefined): Cell[] {
  const routed = lineRenderPoints(points, variant)
  if (routed.length <= 1) return routed
  const cells: Cell[] = []
  for (let i = 1; i < routed.length; i++) {
    const segment = bresenham(routed[i - 1], routed[i])
    cells.push(...(cells.length === 0 ? segment : segment.slice(1)))
  }
  return cells
}

// ---------- shape rasterizers ----------

function rasterRect(grid: string[][], r: RectShape) {
  const { x1, y1, x2, y2 } = normalizeRect(r.rect)
  if (x2 - x1 < 1 || y2 - y1 < 1) return
  if (r.fill !== 'none') {
    const ch = FILL_CHARS[r.fill]
    for (let y = y1 + 1; y < y2; y++)
      for (let x = x1 + 1; x < x2; x++) setCell(grid, x, y, ch)
  }
  for (let x = x1 + 1; x < x2; x++) {
    setCell(grid, x, y1, '-')
    setCell(grid, x, y2, '-')
  }
  for (let y = y1 + 1; y < y2; y++) {
    setCell(grid, x1, y, '|')
    setCell(grid, x2, y, '|')
  }
  setCell(grid, x1, y1, '+')
  setCell(grid, x2, y1, '+')
  setCell(grid, x1, y2, '+')
  setCell(grid, x2, y2, '+')
}

type EllipseSpan = { y: number; left: number; right: number }

function drawHorizontalRun(
  grid: string[][],
  y: number,
  xFrom: number,
  xTo: number,
  ch: string,
) {
  for (let x = xFrom; x <= xTo; x++) setCell(grid, x, y, ch)
}

function ellipseSpans(x1: number, y1: number, x2: number, y2: number): EllipseSpan[] {
  const w = x2 - x1 + 1
  const h = y2 - y1 + 1
  const cx = (x1 + x2) / 2
  const rx = (w - 1) / 2
  const spans: EllipseSpan[] = []

  for (let y = y1; y <= y2; y++) {
    const rowCenter = y - y1 + 0.5
    const normalizedY = (2 * rowCenter) / h - 1
    const halfWidth = rx * Math.sqrt(Math.max(0, 1 - normalizedY * normalizedY))
    const left = Math.max(x1, Math.round(cx - halfWidth))
    const right = Math.min(x2, Math.round(cx + halfWidth))
    spans.push({ y, left, right })
  }

  return spans
}

function ellipseCapSpan(span: EllipseSpan, x1: number, x2: number, h: number): EllipseSpan {
  const rawWidth = span.right - span.left + 1
  const capWidth = Math.max(1, Math.min(rawWidth, Math.max(3, Math.round(h * 0.72))))
  const cx = (x1 + x2) / 2
  const left = Math.max(x1, Math.round(cx - (capWidth - 1) / 2))
  return { y: span.y, left, right: Math.min(x2, left + capWidth - 1) }
}

function drawEllipseCap(
  grid: string[][],
  span: EllipseSpan,
  x1: number,
  x2: number,
  h: number,
  position: 'top' | 'bottom',
) {
  const cap = ellipseCapSpan(span, x1, x2, h)
  const endCh = position === 'top' ? '.' : "'"

  if (cap.left === cap.right) {
    setCell(grid, cap.left, cap.y, endCh)
    return
  }

  setCell(grid, cap.left, cap.y, endCh)
  drawHorizontalRun(grid, cap.y, cap.left + 1, cap.right - 1, '-')
  setCell(grid, cap.right, cap.y, endCh)
}

function ellipseSideChars(spans: EllipseSpan[], index: number): [string, string] {
  const span = spans[index]
  const prev = spans[index - 1]
  const next = spans[index + 1]
  const isTopHalf = index < (spans.length - 1) / 2
  const isBottomHalf = index > (spans.length - 1) / 2
  const widestLeft = Math.min(...spans.map((s) => s.left))
  const widestRight = Math.max(...spans.map((s) => s.right))
  const isWidest = span.left === widestLeft && span.right === widestRight
  const holdsSpan =
    (!!prev && prev.left === span.left && prev.right === span.right) ||
    (!!next && next.left === span.left && next.right === span.right)

  if (!isTopHalf && !isBottomHalf) {
    return spans.length <= 3 ? ['/', '\\'] : ['|', '|']
  }

  const left = isTopHalf ? '/' : '\\'
  const right = isTopHalf ? '\\' : '/'

  if (isWidest && holdsSpan) return ['|', '|']
  return [left, right]
}

// Scanline ASCII ellipse. Row widths come from the ellipse equation, then
// each row gets ASCII strokes that match the local curve direction.
function rasterEllipse(grid: string[][], e: EllipseShape) {
  const { x1, y1, x2, y2 } = normalizeRect(e.rect)
  const w = x2 - x1 + 1
  const h = y2 - y1 + 1
  if (w < 3 || h < 2) return

  // h=2 has no interior row, so use a compact capsule.
  if (h === 2) {
    setCell(grid, x1, y1, '/')
    drawHorizontalRun(grid, y1, x1 + 1, x2 - 1, '-')
    setCell(grid, x2, y1, '\\')
    setCell(grid, x1, y2, '\\')
    drawHorizontalRun(grid, y2, x1 + 1, x2 - 1, '_')
    setCell(grid, x2, y2, '/')
    return
  }

  const spans = ellipseSpans(x1, y1, x2, y2)

  spans.forEach((span, index) => {
    if (index === 0) {
      drawEllipseCap(grid, span, x1, x2, h, 'top')
      return
    }

    if (index === spans.length - 1) {
      drawEllipseCap(grid, span, x1, x2, h, 'bottom')
      return
    }

    const [leftCh, rightCh] = ellipseSideChars(spans, index)
    setCell(grid, span.left, span.y, leftCh)
    setCell(grid, span.right, span.y, rightCh)
  })

  fillEllipseInterior(grid, e, spans)
}

function fillEllipseInterior(
  grid: string[][],
  e: EllipseShape,
  spans: EllipseSpan[],
) {
  if (e.fill === 'none') return
  const fillCh = FILL_CHARS[e.fill]
  for (const span of spans.slice(1, -1)) {
    for (let x = span.left + 1; x <= span.right - 1; x++) {
      if (grid[span.y]?.[x] === ' ') grid[span.y][x] = fillCh
    }
  }
}

// Diamond rendered row-by-row from the algebraic equation
//   |dx|/rx + |dy|/ry = 1
// which means at most TWO outline cells per row (left + right). No
// Bresenham pile-up; the slashes stay one-per-row at any aspect ratio.
// `+` corners (top/bottom/left/right tips) per the flowchart convention.
// For even-h diamonds the 0.5-offset trick lets the two middle rows both
// reach the bounding-box edges so the shape fills its drag rectangle.
function rasterDiamond(grid: string[][], d: DiamondShape) {
  const { x1, y1, x2, y2 } = normalizeRect(d.rect)
  const w = x2 - x1 + 1
  const h = y2 - y1 + 1
  if (w < 3 || h < 3) return

  const cx = (x1 + x2) / 2
  const cy = (y1 + y2) / 2
  const rx = (x2 - x1) / 2
  const ry = (y2 - y1) / 2
  const offset = h % 2 === 0 ? 0.5 : 0
  const effRy = ry - offset

  for (let y = y1; y <= y2; y++) {
    const dyAbs = Math.abs(y - cy)
    const distFromWidest = Math.max(0, dyAbs - offset)
    const halfW = effRy > 0 ? rx * (1 - distFromWidest / effRy) : 0

    if (halfW < 0.5) {
      if (y === y1) setCell(grid, Math.round(cx), y, '+')
      else if (y === y2) setCell(grid, Math.round(cx), y, '+')
      continue
    }

    const xL = Math.round(cx - halfW)
    const xR = Math.round(cx + halfW)

    if (distFromWidest < 0.001) {
      setCell(grid, xL, y, '+')
      setCell(grid, xR, y, '+')
    } else if (y < cy) {
      setCell(grid, xL, y, '/')
      setCell(grid, xR, y, '\\')
    } else {
      setCell(grid, xL, y, '\\')
      setCell(grid, xR, y, '/')
    }
  }

  if (d.fill !== 'none') {
    const fillCh = FILL_CHARS[d.fill]
    for (let y = y1 + 1; y <= y2 - 1; y++) {
      const dyAbs = Math.abs(y - cy)
      const distFromWidest = Math.max(0, dyAbs - offset)
      const halfW = effRy > 0 ? rx * (1 - distFromWidest / effRy) : 0
      if (halfW < 0.5) continue
      const xL = Math.round(cx - halfW)
      const xR = Math.round(cx + halfW)
      for (let x = xL + 1; x < xR; x++) {
        if (grid[y]?.[x] === ' ') grid[y][x] = fillCh
      }
    }
  }
}

function sameCell(a: Cell, b: Cell): boolean {
  return a.x === b.x && a.y === b.y
}

function isLineTool(tool: Tool): tool is LineShape['type'] {
  return tool === 'line' || tool === 'arrow'
}

function isLineShape(shape: Shape): shape is LineShape {
  return shape.type === 'line' || shape.type === 'arrow'
}

function lastPoint(points: Cell[]): Cell | null {
  return points.length > 0 ? points[points.length - 1] : null
}

function replaceLastPoint(points: Cell[], point: Cell): Cell[] {
  if (points.length === 0) return [point]
  return [...points.slice(0, -1), point]
}

function lastSegmentHasLength(points: Cell[]): boolean {
  if (points.length < 2) return false
  return !sameCell(points[points.length - 2], points[points.length - 1])
}

function previousDistinctPoint(points: Cell[]): Cell | null {
  const end = lastPoint(points)
  if (!end) return null
  for (let i = points.length - 2; i >= 0; i--) {
    if (!sameCell(points[i], end)) return points[i]
  }
  return null
}

function lineStepGlyph(a: Cell, b: Cell): string {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (dx === 0 && dy === 0) return '*'
  if (dy === 0) return '-'
  if (dx === 0) return '|'
  return (dx > 0) === (dy > 0) ? '\\' : '/'
}

function arrowHeadGlyph(from: Cell, to: Cell): string {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const absDx = Math.abs(dx)
  const absDy = Math.abs(dy)

  if (absDx >= absDy * 2) return dx >= 0 ? '>' : '<'
  if (absDy >= absDx * 2) return dy >= 0 ? 'v' : '^'
  if (dx >= 0 && dy >= 0) return '↘'
  if (dx >= 0 && dy < 0) return '↗'
  if (dx < 0 && dy >= 0) return '↙'
  return '↖'
}

function rasterLineSegment(grid: string[][], from: Cell, to: Cell) {
  if (sameCell(from, to)) {
    setCell(grid, from.x, from.y, '*')
    return
  }

  const pts = bresenham(from, to)
  for (let i = 0; i < pts.length; i++) {
    const a = i === pts.length - 1 ? pts[i - 1] : pts[i]
    const b = i === pts.length - 1 ? pts[i] : pts[i + 1]
    setCell(grid, pts[i].x, pts[i].y, lineStepGlyph(a, b))
  }
}

// Straight lines use Bresenham for arbitrary angles. Elbow lines route each
// control segment through orthogonal bends.
function rasterLine(grid: string[][], l: LineShape) {
  const points = lineRenderPoints(l.points, l.variant)
  if (points.length === 0) return
  if (points.length === 1) {
    setCell(grid, points[0].x, points[0].y, '*')
    return
  }

  for (let i = 1; i < points.length; i++) {
    rasterLineSegment(grid, points[i - 1], points[i])
  }

  for (let i = 1; i < points.length - 1; i++) {
    setCell(grid, points[i].x, points[i].y, '+')
  }

  if (l.type === 'arrow') {
    const end = lastPoint(points)
    const prev = previousDistinctPoint(points)
    if (end && prev) setCell(grid, end.x, end.y, arrowHeadGlyph(prev, end))
  }
}

// Maps text size to a CSS font-size multiplier. The sketcher's overlay
// layer reads this to render m/l/xl text with real CSS scaling — the grid
// itself always carries 1-char-per-cell ASCII so the exported markdown
// stays plain text.
const TEXT_SIZE_SCALE: Record<TextSize, number> = {
  s: 1,
  m: 1.5,
  l: 2.25,
  xl: 3.5,
}
const TEXT_WIDTH_CELL_SCALE = 1.25

function textVisualCellSize(text: string, size: TextSize | undefined): { w: number; h: number } {
  const scale = TEXT_SIZE_SCALE[size ?? 's']
  const chars = Math.max(text.length, 1)
  return {
    w: Math.max(1, Math.ceil(chars * scale * TEXT_WIDTH_CELL_SCALE)),
    h: Math.max(1, Math.ceil(scale)),
  }
}

function textVisualBounds(
  x: number,
  y: number,
  text: string,
  size: TextSize | undefined,
): Rect2 {
  const visual = textVisualCellSize(text, size)
  return { x1: x, y1: y, x2: x + visual.w - 1, y2: y + visual.h - 1 }
}

function expandBoundsForTextSize(bounds: Rect2, size: TextSize | undefined): Rect2 {
  const scale = TEXT_SIZE_SCALE[size ?? 's']
  if (scale <= 1) return bounds

  const w = bounds.x2 - bounds.x1 + 1
  const h = bounds.y2 - bounds.y1 + 1
  const visualW = Math.max(w, Math.ceil(w * scale * TEXT_WIDTH_CELL_SCALE))
  const visualH = Math.max(h, Math.ceil(h * scale))
  const x1 = Math.floor((bounds.x1 + bounds.x2) / 2 - (visualW - 1) / 2)
  const y1 = Math.floor((bounds.y1 + bounds.y2) / 2 - (visualH - 1) / 2)
  return { x1, y1, x2: x1 + visualW - 1, y2: y1 + visualH - 1 }
}

function rasterText(grid: string[][], t: TextShape) {
  if (t.y < 0 || t.y >= grid.length) return
  for (let i = 0; i < t.text.length; i++) {
    const x = t.x + i
    if (x < 0 || x >= grid[0].length) continue
    // Direct write so spaces in text render as spaces (overwrite anything beneath).
    grid[t.y][x] = t.text[i]
  }
}

function rasterFreedraw(grid: string[][], f: FreedrawShape) {
  if (f.points.length === 0) return
  if (f.points.length === 1) {
    setCell(grid, f.points[0].x, f.points[0].y, '*')
    return
  }
  for (let i = 1; i < f.points.length; i++) {
    for (const p of bresenham(f.points[i - 1], f.points[i])) {
      setCell(grid, p.x, p.y, '*')
    }
  }
}

// Word-wrap a string to fit within `maxWidth` columns. Breaks only at
// whitespace; words are never split, so a long word overflows horizontally.
function wrapText(text: string, maxWidth: number): string[] {
  const width = Math.max(1, maxWidth)
  const out: string[] = []
  const paragraphs = text.split('\n')
  for (const para of paragraphs) {
    if (para.length === 0) {
      out.push('')
      continue
    }
    const words = para.split(/\s+/).filter((w) => w.length > 0)
    let current = ''
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word
      if (candidate.length <= width) {
        current = candidate
      } else {
        if (current) out.push(current)
        current = word
      }
    }
    if (current) out.push(current)
  }
  return out
}

function textLayoutBounds(bounds: Rect2, text: string, padding: number = 1): Rect2 | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const innerLeft = bounds.x1 + padding
  const innerRight = bounds.x2 - padding
  const innerTop = bounds.y1 + padding
  const innerBottom = bounds.y2 - padding
  const textLeft = innerLeft <= innerRight ? innerLeft : Math.floor((bounds.x1 + bounds.x2) / 2)
  const textRight = innerLeft <= innerRight ? innerRight : textLeft
  const textTop = innerTop <= innerBottom ? innerTop : Math.floor((bounds.y1 + bounds.y2) / 2)
  const textBottom = innerTop <= innerBottom ? innerBottom : textTop
  const textWidth = textRight - textLeft + 1
  const lines = wrapText(trimmed, textWidth)
  if (lines.length === 0) return null

  const cx = (textLeft + textRight) / 2
  const startY = textTop + Math.floor((textBottom - textTop + 1 - lines.length) / 2)
  let x1 = Infinity
  let x2 = -Infinity
  for (const line of lines) {
    const startX = Math.floor(cx - line.length / 2 + 0.5)
    if (startX < x1) x1 = startX
    if (startX + line.length - 1 > x2) x2 = startX + line.length - 1
  }

  return { x1, y1: startY, x2, y2: startY + lines.length - 1 }
}

function shapeRenderBounds(s: Shape): Rect2 {
  const base = shapeBounds(s)
  if (!('text' in s) || !s.text) return base
  if (s.type === 'text') return base

  let labelBounds: Rect2 | null = null
  if (s.type === 'line' || s.type === 'arrow') {
    const mid = lineMidpoint(s.points, s.variant)
    if (mid) {
      const half = Math.ceil(s.text.length / 2)
      labelBounds = textLayoutBounds(
        { x1: mid.x - half, y1: mid.y, x2: mid.x + half, y2: mid.y },
        s.text,
        0,
      )
    }
  } else if (s.type === 'rect' || s.type === 'ellipse') {
    labelBounds = textLayoutBounds(normalizeRect(s.rect), s.text)
  } else if (s.type === 'diamond') {
    labelBounds = textLayoutBounds(normalizeRect(s.rect), s.text, 2)
  }

  if (labelBounds) labelBounds = expandBoundsForTextSize(labelBounds, s.textSize)
  if (!labelBounds) return base
  return {
    x1: Math.min(base.x1, labelBounds.x1),
    y1: Math.min(base.y1, labelBounds.y1),
    x2: Math.max(base.x2, labelBounds.x2),
    y2: Math.max(base.y2, labelBounds.y2),
  }
}

// Write `text` centered in the shape's interior. Text can overflow outside
// that interior; it is never clipped to the shape bounds. The grid stores
// 1-char-per-cell regardless of size — the size-driven visual scaling
// happens at display time via an overlay layer, not in the raster.
function rasterCenteredText(
  grid: string[][],
  bounds: Rect2,
  text: string,
  padding: number = 1,
) {
  const trimmed = text.trim()
  if (!trimmed) return
  const innerLeft = bounds.x1 + padding
  const innerRight = bounds.x2 - padding
  const innerTop = bounds.y1 + padding
  const innerBottom = bounds.y2 - padding
  const textLeft = innerLeft <= innerRight ? innerLeft : Math.floor((bounds.x1 + bounds.x2) / 2)
  const textRight = innerLeft <= innerRight ? innerRight : textLeft
  const textTop = innerTop <= innerBottom ? innerTop : Math.floor((bounds.y1 + bounds.y2) / 2)
  const textBottom = innerTop <= innerBottom ? innerBottom : textTop
  const textWidth = textRight - textLeft + 1

  const lines = wrapText(trimmed, textWidth)
  if (lines.length === 0) return
  const cx = (textLeft + textRight) / 2
  const startY = textTop + Math.floor((textBottom - textTop + 1 - lines.length) / 2)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const startX = Math.floor(cx - line.length / 2 + 0.5)
    const y = startY + i
    for (let j = 0; j < line.length; j++) {
      const x = startX + j
      if (y < 0 || y >= grid.length || x < 0 || x >= grid[0].length) continue
      grid[y][x] = line[j]
    }
  }
}

function lineMidpoint(points: Cell[], variant?: LineVariant): Cell | null {
  const routed = lineRenderPoints(points, variant)
  if (routed.length === 0) return null
  if (routed.length === 1) return routed[0]
  // Find the midpoint along the polyline by total arc length.
  let total = 0
  const segLengths: number[] = []
  for (let i = 1; i < routed.length; i++) {
    const dx = routed[i].x - routed[i - 1].x
    const dy = routed[i].y - routed[i - 1].y
    const len = Math.hypot(dx, dy)
    segLengths.push(len)
    total += len
  }
  const target = total / 2
  let accum = 0
  for (let i = 0; i < segLengths.length; i++) {
    if (accum + segLengths[i] >= target) {
      const t = (target - accum) / Math.max(segLengths[i], 0.0001)
      const a = routed[i]
      const b = routed[i + 1]
      return {
        x: Math.round(a.x + (b.x - a.x) * t),
        y: Math.round(a.y + (b.y - a.y) * t),
      }
    }
    accum += segLengths[i]
  }
  return routed[routed.length - 1]
}

function shapeHitTest(p: Cell, s: Shape): boolean {
  if (s.type === 'line' || s.type === 'arrow') {
    for (const q of linePathCells(s.points, s.variant)) {
      if (cellDistance(p, q) <= 1) return true
    }
    if (s.text) {
      const mid = lineMidpoint(s.points, s.variant)
      if (mid) {
        const half = Math.ceil(s.text.length / 2)
        const labelBounds = expandBoundsForTextSize(
          { x1: mid.x - half, y1: mid.y, x2: mid.x + half, y2: mid.y },
          s.textSize,
        )
        if (pointInRect(p, labelBounds)) {
          return true
        }
      }
    }
    return false
  }

  if (s.type === 'rect' || s.type === 'ellipse' || s.type === 'diamond') {
    const bounds = shapeBounds(s)
    if (pointInRect(p, bounds)) return true
    if (s.text) {
      const labelBounds = textLayoutBounds(bounds, s.text, s.type === 'diamond' ? 2 : 1)
      if (labelBounds && pointInRect(p, expandBoundsForTextSize(labelBounds, s.textSize))) {
        return true
      }
    }
    return false
  }

  return pointInRect(p, shapeBounds(s))
}

// `skipText`: omit text shapes and shape labels from the rasterized grid.
// Used by the live display, which renders text via an absolutely-positioned
// overlay so sizes m/l/xl can be drawn with real CSS font-size. Export
// always passes false so the inserted markdown still contains the text.
function rasterize(
  shapes: Shape[],
  w: number,
  h: number,
  opts: { skipText?: boolean } = {},
): string[][] {
  const grid = blankGrid(w, h)
  const { skipText = false } = opts
  for (const s of shapes) {
    switch (s.type) {
      case 'rect':
        rasterRect(grid, s)
        if (!skipText && s.text) rasterCenteredText(grid, normalizeRect(s.rect), s.text)
        break
      case 'ellipse':
        rasterEllipse(grid, s)
        if (!skipText && s.text) rasterCenteredText(grid, normalizeRect(s.rect), s.text)
        break
      case 'diamond':
        rasterDiamond(grid, s)
        if (!skipText && s.text) rasterCenteredText(grid, normalizeRect(s.rect), s.text, 2)
        break
      case 'line':
      case 'arrow':
        rasterLine(grid, s)
        if (!skipText && s.text) {
          const mid = lineMidpoint(s.points, s.variant)
          if (mid) {
            // Treat the line label as a small horizontal box around the
            // midpoint sized to fit the text — no fill, just centered chars.
            const half = Math.ceil(s.text.length / 2)
            rasterCenteredText(
              grid,
              {
                x1: mid.x - half,
                y1: mid.y,
                x2: mid.x + half,
                y2: mid.y,
              },
              s.text,
              0,
            )
          }
        }
        break
      case 'text':
        if (!skipText) rasterText(grid, s)
        break
      case 'freedraw':
        rasterFreedraw(grid, s)
        break
    }
  }
  return grid
}

function serialize(grid: string[][]): string {
  // Trim to the bounding box of all non-space cells across all four sides
  // so the inserted ASCII takes up only the space it needs.
  let minX = Infinity
  let minY = Infinity
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y]
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== ' ') {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return ''
  const lines: string[] = []
  for (let y = minY; y <= maxY; y++) {
    let line = ''
    for (let x = minX; x <= maxX; x++) line += grid[y][x] ?? ' '
    lines.push(line.replace(/\s+$/, ''))
  }
  return lines.join('\n')
}

function prepareShapesForExport(shapes: Shape[]): { shapes: Shape[]; w: number; h: number } | null {
  if (shapes.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of shapes) {
    const b = shapeRenderBounds(s)
    if (b.x1 < minX) minX = b.x1
    if (b.y1 < minY) minY = b.y1
    if (b.x2 > maxX) maxX = b.x2
    if (b.y2 > maxY) maxY = b.y2
  }
  if (!isFinite(minX)) return null
  const w = maxX - minX + 1
  const h = maxY - minY + 1
  // Shift each shape so the bbox starts at (0, 0) of the export grid.
  const shifted = shapes.map((s) => moveShape(s, -minX, -minY))
  return { shapes: shifted, w, h }
}

function exportSketch(shapes: Shape[]): { text: string; language: string } {
  const prepared = prepareShapesForExport(shapes)
  if (!prepared) return { text: '', language: 'ascii' }
  const grid = rasterize(prepared.shapes, prepared.w, prepared.h)
  const snapshot: SketchSnapshot = { v: 1, shapes: prepared.shapes }
  return {
    text: encodeAsciiSketchContent(serialize(grid), snapshot),
    language: 'ascii',
  }
}

// ---------- ASCII import / rehydration ----------

type ParsedAsciiGrid = {
  grid: string[][]
  w: number
  h: number
}

type OutlineCell = Cell & { ch: string }
type ParsedTextRun = {
  x: number
  y: number
  text: string
  cells: Cell[]
}

function asciiGridFromText(text: string): ParsedAsciiGrid {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const w = Math.max(1, ...lines.map((line) => line.length))
  const h = Math.max(1, lines.length)
  const grid = lines.map((line) =>
    Array.from({ length: w }, (_, x) => line[x] ?? ' '),
  )
  while (grid.length < h) grid.push(Array.from({ length: w }, () => ' '))
  return { grid, w, h }
}

function blankConsumed(w: number, h: number): boolean[][] {
  return Array.from({ length: h }, () => Array.from({ length: w }, () => false))
}

function gridChar(grid: string[][], x: number, y: number): string {
  return grid[y]?.[x] ?? ' '
}

function isConsumed(consumed: boolean[][], x: number, y: number): boolean {
  return consumed[y]?.[x] ?? false
}

function markConsumed(consumed: boolean[][], x: number, y: number) {
  if (consumed[y]?.[x] !== undefined) consumed[y][x] = true
}

function markCellsConsumed(consumed: boolean[][], cells: Cell[]) {
  for (const cell of cells) markConsumed(consumed, cell.x, cell.y)
}

function pushOutlineCell(out: OutlineCell[], seen: Set<string>, x: number, y: number, ch: string) {
  const key = `${x},${y}`
  if (seen.has(key)) return
  seen.add(key)
  out.push({ x, y, ch })
}

function horizontalOutlineCells(
  out: OutlineCell[],
  seen: Set<string>,
  y: number,
  xFrom: number,
  xTo: number,
  ch: string,
) {
  for (let x = xFrom; x <= xTo; x++) pushOutlineCell(out, seen, x, y, ch)
}

function rectOutlineCells(r: Rect2): OutlineCell[] {
  const { x1, y1, x2, y2 } = normalizeRect(r)
  const out: OutlineCell[] = []
  const seen = new Set<string>()
  for (let x = x1 + 1; x < x2; x++) {
    pushOutlineCell(out, seen, x, y1, '-')
    pushOutlineCell(out, seen, x, y2, '-')
  }
  for (let y = y1 + 1; y < y2; y++) {
    pushOutlineCell(out, seen, x1, y, '|')
    pushOutlineCell(out, seen, x2, y, '|')
  }
  pushOutlineCell(out, seen, x1, y1, '+')
  pushOutlineCell(out, seen, x2, y1, '+')
  pushOutlineCell(out, seen, x1, y2, '+')
  pushOutlineCell(out, seen, x2, y2, '+')
  return out
}

function ellipseOutlineCells(r: Rect2): OutlineCell[] {
  const { x1, y1, x2, y2 } = normalizeRect(r)
  const w = x2 - x1 + 1
  const h = y2 - y1 + 1
  const out: OutlineCell[] = []
  const seen = new Set<string>()
  if (w < 3 || h < 2) return out

  if (h === 2) {
    pushOutlineCell(out, seen, x1, y1, '/')
    horizontalOutlineCells(out, seen, y1, x1 + 1, x2 - 1, '-')
    pushOutlineCell(out, seen, x2, y1, '\\')
    pushOutlineCell(out, seen, x1, y2, '\\')
    horizontalOutlineCells(out, seen, y2, x1 + 1, x2 - 1, '_')
    pushOutlineCell(out, seen, x2, y2, '/')
    return out
  }

  const spans = ellipseSpans(x1, y1, x2, y2)
  spans.forEach((span, index) => {
    if (index === 0 || index === spans.length - 1) {
      const cap = ellipseCapSpan(span, x1, x2, h)
      const endCh = index === 0 ? '.' : "'"
      pushOutlineCell(out, seen, cap.left, cap.y, endCh)
      horizontalOutlineCells(out, seen, cap.y, cap.left + 1, cap.right - 1, '-')
      pushOutlineCell(out, seen, cap.right, cap.y, endCh)
      return
    }

    const [leftCh, rightCh] = ellipseSideChars(spans, index)
    pushOutlineCell(out, seen, span.left, span.y, leftCh)
    pushOutlineCell(out, seen, span.right, span.y, rightCh)
  })
  return out
}

function diamondOutlineCells(r: Rect2): OutlineCell[] {
  const { x1, y1, x2, y2 } = normalizeRect(r)
  const w = x2 - x1 + 1
  const h = y2 - y1 + 1
  const out: OutlineCell[] = []
  const seen = new Set<string>()
  if (w < 3 || h < 3) return out

  const cx = (x1 + x2) / 2
  const cy = (y1 + y2) / 2
  const rx = (x2 - x1) / 2
  const ry = (y2 - y1) / 2
  const offset = h % 2 === 0 ? 0.5 : 0
  const effRy = ry - offset

  for (let y = y1; y <= y2; y++) {
    const dyAbs = Math.abs(y - cy)
    const distFromWidest = Math.max(0, dyAbs - offset)
    const halfW = effRy > 0 ? rx * (1 - distFromWidest / effRy) : 0

    if (halfW < 0.5) {
      if (y === y1 || y === y2) pushOutlineCell(out, seen, Math.round(cx), y, '+')
      continue
    }

    const xL = Math.round(cx - halfW)
    const xR = Math.round(cx + halfW)
    if (distFromWidest < 0.001) {
      pushOutlineCell(out, seen, xL, y, '+')
      pushOutlineCell(out, seen, xR, y, '+')
    } else if (y < cy) {
      pushOutlineCell(out, seen, xL, y, '/')
      pushOutlineCell(out, seen, xR, y, '\\')
    } else {
      pushOutlineCell(out, seen, xL, y, '\\')
      pushOutlineCell(out, seen, xR, y, '/')
    }
  }

  return out
}

function outlineMatches(
  grid: string[][],
  consumed: boolean[][],
  outline: OutlineCell[],
  minRatio = 1,
): boolean {
  if (outline.length === 0) return false
  let matched = 0
  for (const cell of outline) {
    if (isConsumed(consumed, cell.x, cell.y)) return false
    if (gridChar(grid, cell.x, cell.y) === cell.ch) matched += 1
  }
  return matched / outline.length >= minRatio
}

function fillStyleFromCells(grid: string[][], cells: Cell[]): FillStyle {
  if (cells.length === 0) return 'none'
  const counts = new Map<FillStyle, number>()
  for (const fill of DENSITY_FILLS) counts.set(fill, 0)
  for (const cell of cells) {
    const ch = gridChar(grid, cell.x, cell.y)
    const fill = DENSITY_FILLS.find((candidate) => FILL_CHARS[candidate] === ch)
    if (fill) counts.set(fill, (counts.get(fill) ?? 0) + 1)
  }
  let best: FillStyle = 'none'
  let bestCount = 0
  for (const fill of DENSITY_FILLS) {
    const count = counts.get(fill) ?? 0
    if (count > bestCount) {
      best = fill
      bestCount = count
    }
  }
  return bestCount >= Math.max(2, Math.floor(cells.length * 0.35)) ? best : 'none'
}

function rectInteriorCells(r: Rect2): Cell[] {
  const { x1, y1, x2, y2 } = normalizeRect(r)
  const cells: Cell[] = []
  for (let y = y1 + 1; y < y2; y++)
    for (let x = x1 + 1; x < x2; x++) cells.push({ x, y })
  return cells
}

function ellipseInteriorCells(r: Rect2): Cell[] {
  const { x1, y1, x2, y2 } = normalizeRect(r)
  const w = x2 - x1 + 1
  const h = y2 - y1 + 1
  if (w < 3 || h < 3) return []
  const cells: Cell[] = []
  for (const span of ellipseSpans(x1, y1, x2, y2).slice(1, -1)) {
    for (let x = span.left + 1; x <= span.right - 1; x++) cells.push({ x, y: span.y })
  }
  return cells
}

function diamondInteriorCells(r: Rect2): Cell[] {
  const { x1, y1, x2, y2 } = normalizeRect(r)
  const w = x2 - x1 + 1
  const h = y2 - y1 + 1
  if (w < 3 || h < 3) return []
  const cells: Cell[] = []
  const cx = (x1 + x2) / 2
  const cy = (y1 + y2) / 2
  const rx = (x2 - x1) / 2
  const ry = (y2 - y1) / 2
  const offset = h % 2 === 0 ? 0.5 : 0
  const effRy = ry - offset

  for (let y = y1 + 1; y <= y2 - 1; y++) {
    const dyAbs = Math.abs(y - cy)
    const distFromWidest = Math.max(0, dyAbs - offset)
    const halfW = effRy > 0 ? rx * (1 - distFromWidest / effRy) : 0
    if (halfW < 0.5) continue
    const xL = Math.round(cx - halfW)
    const xR = Math.round(cx + halfW)
    for (let x = xL + 1; x < xR; x++) cells.push({ x, y })
  }

  return cells
}

function consumeFillCells(
  grid: string[][],
  consumed: boolean[][],
  cells: Cell[],
  fill: FillStyle,
) {
  if (fill === 'none') return
  const ch = FILL_CHARS[fill]
  for (const cell of cells) {
    if (gridChar(grid, cell.x, cell.y) === ch) markConsumed(consumed, cell.x, cell.y)
  }
}

type ShapeCandidate<T extends Shape> = {
  shape: T
  outline: OutlineCell[]
  fillCells: Cell[]
  area: number
}

function parseRects(parsed: ParsedAsciiGrid, consumed: boolean[][]): Shape[] {
  const candidates: ShapeCandidate<RectShape>[] = []
  const { grid, w, h } = parsed

  for (let y1 = 0; y1 < h - 1; y1++) {
    for (let x1 = 0; x1 < w - 1; x1++) {
      if (gridChar(grid, x1, y1) !== '+') continue
      for (let x2 = x1 + 2; x2 < w; x2++) {
        if (gridChar(grid, x2, y1) !== '+') continue
        for (let y2 = y1 + 2; y2 < h; y2++) {
          const rect = { x1, y1, x2, y2 }
          const outline = rectOutlineCells(rect)
          if (!outlineMatches(grid, consumed, outline)) continue
          const fillCells = rectInteriorCells(rect)
          candidates.push({
            shape: {
              id: uid(),
              type: 'rect',
              rect,
              fill: fillStyleFromCells(grid, fillCells),
            },
            outline,
            fillCells,
            area: (x2 - x1 + 1) * (y2 - y1 + 1),
          })
        }
      }
    }
  }

  candidates.sort((a, b) => b.area - a.area)
  const shapes: Shape[] = []
  for (const candidate of candidates) {
    if (!outlineMatches(grid, consumed, candidate.outline)) continue
    markCellsConsumed(consumed, candidate.outline)
    consumeFillCells(grid, consumed, candidate.fillCells, candidate.shape.fill)
    shapes.push(candidate.shape)
  }
  return shapes
}

function ellipseQuickCheck(grid: string[][], rect: Rect2): boolean {
  const { x1, y1, x2, y2 } = normalizeRect(rect)
  const w = x2 - x1 + 1
  const h = y2 - y1 + 1
  if (w < 3 || h < 2) return false
  if (h === 2) {
    return (
      gridChar(grid, x1, y1) === '/' &&
      gridChar(grid, x2, y1) === '\\' &&
      gridChar(grid, x1, y2) === '\\' &&
      gridChar(grid, x2, y2) === '/'
    )
  }

  const spans = ellipseSpans(x1, y1, x2, y2)
  const top = ellipseCapSpan(spans[0], x1, x2, h)
  const bottom = ellipseCapSpan(spans[spans.length - 1], x1, x2, h)
  return (
    gridChar(grid, top.left, top.y) === '.' &&
    gridChar(grid, top.right, top.y) === '.' &&
    gridChar(grid, bottom.left, bottom.y) === "'" &&
    gridChar(grid, bottom.right, bottom.y) === "'"
  )
}

function parseEllipses(parsed: ParsedAsciiGrid, consumed: boolean[][]): Shape[] {
  const candidates: ShapeCandidate<EllipseShape>[] = []
  const { grid, w, h } = parsed
  const rowsWithTopCap = grid.map((row) => row.includes('.'))
  const rowsWithBottomCap = grid.map((row) => row.includes("'"))

  for (let y1 = 0; y1 < h - 1; y1++) {
    if (!rowsWithTopCap[y1]) continue
    for (let y2 = y1 + 1; y2 < h; y2++) {
      if (!rowsWithBottomCap[y2]) continue
      for (let x1 = 0; x1 < w - 2; x1++) {
        for (let x2 = x1 + 2; x2 < w; x2++) {
          const rect = { x1, y1, x2, y2 }
          if (!ellipseQuickCheck(grid, rect)) continue
          const outline = ellipseOutlineCells(rect)
          if (!outlineMatches(grid, consumed, outline, 0.88)) continue
          const fillCells = ellipseInteriorCells(rect)
          candidates.push({
            shape: {
              id: uid(),
              type: 'ellipse',
              rect,
              fill: fillStyleFromCells(grid, fillCells),
            },
            outline,
            fillCells,
            area: (x2 - x1 + 1) * (y2 - y1 + 1),
          })
        }
      }
    }
  }

  candidates.sort((a, b) => b.area - a.area)
  const shapes: Shape[] = []
  for (const candidate of candidates) {
    if (!outlineMatches(grid, consumed, candidate.outline, 0.88)) continue
    markCellsConsumed(consumed, candidate.outline)
    consumeFillCells(grid, consumed, candidate.fillCells, candidate.shape.fill)
    shapes.push(candidate.shape)
  }
  return shapes
}

function diamondQuickCheck(grid: string[][], rect: Rect2): boolean {
  const { x1, y1, x2, y2 } = normalizeRect(rect)
  const w = x2 - x1 + 1
  const h = y2 - y1 + 1
  if (w < 3 || h < 3) return false
  const cx = Math.round((x1 + x2) / 2)
  return gridChar(grid, cx, y1) === '+' && gridChar(grid, cx, y2) === '+'
}

function parseDiamonds(parsed: ParsedAsciiGrid, consumed: boolean[][]): Shape[] {
  const candidates: ShapeCandidate<DiamondShape>[] = []
  const { grid, w, h } = parsed
  const rowsWithTip = grid.map((row) => row.includes('+'))

  for (let y1 = 0; y1 < h - 2; y1++) {
    if (!rowsWithTip[y1]) continue
    for (let y2 = y1 + 2; y2 < h; y2++) {
      if (!rowsWithTip[y2]) continue
      for (let x1 = 0; x1 < w - 2; x1++) {
        for (let x2 = x1 + 2; x2 < w; x2++) {
          const rect = { x1, y1, x2, y2 }
          if (!diamondQuickCheck(grid, rect)) continue
          const outline = diamondOutlineCells(rect)
          if (!outlineMatches(grid, consumed, outline, 0.9)) continue
          const fillCells = diamondInteriorCells(rect)
          candidates.push({
            shape: {
              id: uid(),
              type: 'diamond',
              rect,
              fill: fillStyleFromCells(grid, fillCells),
            },
            outline,
            fillCells,
            area: (x2 - x1 + 1) * (y2 - y1 + 1),
          })
        }
      }
    }
  }

  candidates.sort((a, b) => b.area - a.area)
  const shapes: Shape[] = []
  for (const candidate of candidates) {
    if (!outlineMatches(grid, consumed, candidate.outline, 0.9)) continue
    markCellsConsumed(consumed, candidate.outline)
    consumeFillCells(grid, consumed, candidate.fillCells, candidate.shape.fill)
    shapes.push(candidate.shape)
  }
  return shapes
}

type DirKey = 'E' | 'W' | 'N' | 'S' | 'NE' | 'NW' | 'SE' | 'SW'

const DIR_OFFSETS: Record<DirKey, Cell> = {
  E: { x: 1, y: 0 },
  W: { x: -1, y: 0 },
  N: { x: 0, y: -1 },
  S: { x: 0, y: 1 },
  NE: { x: 1, y: -1 },
  NW: { x: -1, y: -1 },
  SE: { x: 1, y: 1 },
  SW: { x: -1, y: 1 },
}

const OPPOSITE_DIR: Record<DirKey, DirKey> = {
  E: 'W',
  W: 'E',
  N: 'S',
  S: 'N',
  NE: 'SW',
  NW: 'SE',
  SE: 'NW',
  SW: 'NE',
}

function lineDirsForGlyph(ch: string): DirKey[] {
  switch (ch) {
    case '-':
      return ['E', 'W']
    case '|':
      return ['N', 'S']
    case '/':
      return ['NE', 'SW']
    case '\\':
      return ['NW', 'SE']
    case '+':
    case '*':
      return ['E', 'W', 'N', 'S', 'NE', 'NW', 'SE', 'SW']
    case '>':
      return ['W']
    case '<':
      return ['E']
    case '^':
      return ['S']
    case 'v':
      return ['N']
    case '↘':
      return ['NW']
    case '↗':
      return ['SW']
    case '↙':
      return ['NE']
    case '↖':
      return ['SE']
    default:
      return []
  }
}

function isLineGlyph(ch: string): boolean {
  return lineDirsForGlyph(ch).length > 0
}

function isArrowGlyph(ch: string): boolean {
  return ch === '>' || ch === '<' || ch === '^' || ch === 'v' || ch === '↘' || ch === '↗' || ch === '↙' || ch === '↖'
}

function cellKey(cell: Cell): string {
  return `${cell.x},${cell.y}`
}

function cellFromKey(key: string): Cell {
  const [x, y] = key.split(',').map(Number)
  return { x, y }
}

function lineNeighbors(
  grid: string[][],
  consumed: boolean[][],
  cell: Cell,
): Cell[] {
  const ch = gridChar(grid, cell.x, cell.y)
  const out: Cell[] = []
  for (const dir of lineDirsForGlyph(ch)) {
    const offset = DIR_OFFSETS[dir]
    const next = { x: cell.x + offset.x, y: cell.y + offset.y }
    if (isConsumed(consumed, next.x, next.y)) continue
    const nextCh = gridChar(grid, next.x, next.y)
    if (!isLineGlyph(nextCh)) continue
    if (lineDirsForGlyph(nextCh).includes(OPPOSITE_DIR[dir])) out.push(next)
  }
  return out
}

function bfsPath(
  neighbors: Map<string, string[]>,
  start: string,
  end: string,
): string[] | null {
  const queue = [start]
  const seen = new Set([start])
  const parent = new Map<string, string | null>([[start, null]])

  for (let i = 0; i < queue.length; i++) {
    const key = queue[i]
    if (key === end) break
    for (const next of neighbors.get(key) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      parent.set(next, key)
      queue.push(next)
    }
  }

  if (!parent.has(end)) return null
  const path: string[] = []
  for (let key: string | null = end; key; key = parent.get(key) ?? null) {
    path.push(key)
  }
  return path.reverse()
}

function farthestKey(neighbors: Map<string, string[]>, start: string, options: string[]): string {
  const queue = [start]
  const seen = new Set([start])
  const distance = new Map<string, number>([[start, 0]])

  for (let i = 0; i < queue.length; i++) {
    const key = queue[i]
    for (const next of neighbors.get(key) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      distance.set(next, (distance.get(key) ?? 0) + 1)
      queue.push(next)
    }
  }

  let best = options[0] ?? start
  let bestDistance = -1
  for (const option of options) {
    const d = distance.get(option) ?? -1
    if (d > bestDistance) {
      best = option
      bestDistance = d
    }
  }
  return best
}

function simplifyLinePath(grid: string[][], path: Cell[]): Cell[] {
  if (path.length <= 2) return path
  const out: Cell[] = [path[0]]
  for (let i = 1; i < path.length - 1; i++) {
    const ch = gridChar(grid, path[i].x, path[i].y)
    if (ch === '+') out.push(path[i])
  }
  out.push(path[path.length - 1])
  return out.filter((point, index, all) => index === 0 || !sameCell(point, all[index - 1]))
}

function parseLines(parsed: ParsedAsciiGrid, consumed: boolean[][]): Shape[] {
  const { grid, w, h } = parsed
  const visited = new Set<string>()
  const shapes: Shape[] = []

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isConsumed(consumed, x, y)) continue
      const ch = gridChar(grid, x, y)
      if (!isLineGlyph(ch)) continue
      const start = { x, y }
      const startKey = cellKey(start)
      if (visited.has(startKey)) continue

      const queue = [start]
      const component: Cell[] = []
      visited.add(startKey)
      for (let i = 0; i < queue.length; i++) {
        const cell = queue[i]
        component.push(cell)
        for (const next of lineNeighbors(grid, consumed, cell)) {
          const key = cellKey(next)
          if (visited.has(key)) continue
          visited.add(key)
          queue.push(next)
        }
      }

      if (component.length < 2) continue

      const componentKeys = new Set(component.map(cellKey))
      const neighbors = new Map<string, string[]>()
      for (const cell of component) {
        neighbors.set(
          cellKey(cell),
          lineNeighbors(grid, consumed, cell)
            .map(cellKey)
            .filter((key) => componentKeys.has(key)),
        )
      }

      const endpoints = component
        .map(cellKey)
        .filter((key) => (neighbors.get(key)?.length ?? 0) <= 1)
      const arrowKeys = component
        .filter((cell) => isArrowGlyph(gridChar(grid, cell.x, cell.y)))
        .map(cellKey)
      const isArrow = arrowKeys.length > 0
      let orderedKeys: string[] | null = null

      if (isArrow) {
        const end = arrowKeys[0]
        const startOptions = endpoints.filter((key) => key !== end)
        const start = farthestKey(
          neighbors,
          end,
          startOptions.length > 0 ? startOptions : component.map(cellKey),
        )
        orderedKeys = bfsPath(neighbors, start, end)
      } else if (endpoints.length >= 2) {
        const first = endpoints[0]
        const last = farthestKey(neighbors, first, endpoints.slice(1))
        orderedKeys = bfsPath(neighbors, first, last)
      }

      if (!orderedKeys || orderedKeys.length < 2) continue
      const points = simplifyLinePath(grid, orderedKeys.map(cellFromKey))
      if (points.length < 2 || sameCell(points[0], points[points.length - 1])) continue

      markCellsConsumed(consumed, component)
      shapes.push({
        id: uid(),
        type: isArrow ? 'arrow' : 'line',
        points,
      })
    }
  }

  return shapes
}

function collectUnconsumedTextRuns(parsed: ParsedAsciiGrid, consumed: boolean[][]): ParsedTextRun[] {
  const { grid, w, h } = parsed
  const runs: ParsedTextRun[] = []

  for (let y = 0; y < h; y++) {
    let x = 0
    while (x < w) {
      while (x < w && isConsumed(consumed, x, y)) x += 1
      const start = x
      while (x < w && !isConsumed(consumed, x, y)) x += 1
      const raw = grid[y].slice(start, x).join('')
      const leading = raw.search(/\S/)
      if (leading < 0) continue
      const text = raw.slice(leading).replace(/\s+$/, '')
      if (!text) continue
      const runX = start + leading
      const cells: Cell[] = []
      for (let i = 0; i < text.length; i++) {
        if (text[i] !== ' ') cells.push({ x: runX + i, y })
      }
      runs.push({
        x: runX,
        y,
        text,
        cells,
      })
    }
  }

  return runs
}

function parseRemainingText(parsed: ParsedAsciiGrid, consumed: boolean[][]): Shape[] {
  return collectUnconsumedTextRuns(parsed, consumed).map((run) => ({
    id: uid(),
    type: 'text',
    x: run.x,
    y: run.y,
    text: run.text,
  }))
}

function parseAsciiSketch(text: string): Shape[] {
  const parsed = asciiGridFromText(text)
  const consumed = blankConsumed(parsed.w, parsed.h)
  let shapes: Shape[] = []

  shapes.push(...parseRects(parsed, consumed))
  shapes.push(...parseEllipses(parsed, consumed))
  shapes.push(...parseDiamonds(parsed, consumed))
  shapes.push(...parseLines(parsed, consumed))
  shapes.push(...parseRemainingText(parsed, consumed))

  return shapes
}

// ---------- React component ----------

// ResizeHandleSpec identifies which grip the user grabbed on a selected
// shape. For rect-style shapes the four corners are grippable; for
// line/arrow polylines every point is its own grip.
type ResizeHandleSpec =
  | { kind: 'corner'; corner: 'tl' | 'tr' | 'bl' | 'br' }
  | { kind: 'point'; index: number }

type Drag =
  | null
  | { kind: 'creating'; shape: Shape; startCell: Cell }
  | { kind: 'moving'; shapeId: string; startCell: Cell; original: Shape }
  | { kind: 'freedraw'; shape: FreedrawShape }
  | {
      kind: 'resizing'
      shapeId: string
      handle: ResizeHandleSpec
      original: Shape
    }
  | {
      // Pan = translate the canvas viewport via CSS transform. Triggered
      // by middle-mouse, space-bar held, or empty-space drag in select
      // mode. Uses transform (not scroll) so panning works in every
      // direction including past the original top-left.
      kind: 'panning'
      startClientX: number
      startClientY: number
      startPanX: number
      startPanY: number
    }

function shapeHandles(s: Shape): { spec: ResizeHandleSpec; cell: Cell }[] {
  switch (s.type) {
    case 'rect':
    case 'ellipse':
    case 'diamond': {
      const n = normalizeRect(s.rect)
      return [
        { spec: { kind: 'corner', corner: 'tl' }, cell: { x: n.x1, y: n.y1 } },
        { spec: { kind: 'corner', corner: 'tr' }, cell: { x: n.x2, y: n.y1 } },
        { spec: { kind: 'corner', corner: 'bl' }, cell: { x: n.x1, y: n.y2 } },
        { spec: { kind: 'corner', corner: 'br' }, cell: { x: n.x2, y: n.y2 } },
      ]
    }
    case 'line':
    case 'arrow':
      return s.points.map((p, i) => ({
        spec: { kind: 'point', index: i },
        cell: p,
      }))
    case 'text':
    case 'freedraw':
      return []
  }
}

function resizeShape(shape: Shape, handle: ResizeHandleSpec, cell: Cell): Shape {
  if (shape.type === 'rect' || shape.type === 'ellipse' || shape.type === 'diamond') {
    if (handle.kind !== 'corner') return shape
    const n = normalizeRect(shape.rect)
    let { x1, y1, x2, y2 } = n
    if (handle.corner === 'tl') { x1 = cell.x; y1 = cell.y }
    else if (handle.corner === 'tr') { x2 = cell.x; y1 = cell.y }
    else if (handle.corner === 'bl') { x1 = cell.x; y2 = cell.y }
    else if (handle.corner === 'br') { x2 = cell.x; y2 = cell.y }
    return { ...shape, rect: { x1, y1, x2, y2 } }
  }
  if (shape.type === 'line' || shape.type === 'arrow') {
    if (handle.kind !== 'point') return shape
    if (handle.index < 0 || handle.index >= shape.points.length) return shape
    const points = shape.points.slice()
    points[handle.index] = cell
    return { ...shape, points }
  }
  return shape
}

type LineDraft = {
  id: string
  type: LineShape['type']
  variant: LineVariant
  points: Cell[]
  preview: Cell
}

type TextInputState = {
  x: number
  y: number
  value: string
  centerX?: number
  attachedShapeId?: string
}

function applyAttachedTextInput(shapes: Shape[], input: TextInputState | null): Shape[] {
  if (!input?.attachedShapeId) return shapes
  const id = input.attachedShapeId
  const value = input.value
  return shapes.map((s) => {
    if (s.id !== id) return s
    if (s.type === 'text' || s.type === 'freedraw') return s
    if (value.length === 0) return removeAttachedText(s)
    return { ...s, text: value }
  })
}

function stripAttachedTextWhileEditing(shapes: Shape[], input: TextInputState | null): Shape[] {
  if (!input?.attachedShapeId) return shapes
  return shapes.map((s) => {
    if (s.id !== input.attachedShapeId) return s
    if (s.type === 'text' || s.type === 'freedraw') return s
    return removeAttachedText(s)
  })
}

function removeAttachedText(
  shape: RectShape | EllipseShape | DiamondShape | LineShape,
): Shape {
  if (shape.type === 'rect') {
    const { text: _removed, ...rest } = shape
    return rest
  }
  if (shape.type === 'ellipse') {
    const { text: _removed, ...rest } = shape
    return rest
  }
  if (shape.type === 'diamond') {
    const { text: _removed, ...rest } = shape
    return rest
  }
  const { text: _removed, ...rest } = shape
  return rest
}

function lineDraftShape(draft: LineDraft | null): LineShape | null {
  if (!draft || draft.points.length < 2) return null
  return {
    id: draft.id,
    type: draft.type,
    variant: draft.variant,
    points: draft.points,
  }
}

function materializeLineDraftForExport(shapes: Shape[], draft: LineDraft | null): Shape[] {
  const shape = lineDraftShape(draft)
  return shape ? [...shapes, shape] : shapes
}

function materializeTextInputForExport(
  shapes: Shape[],
  input: TextInputState | null,
  size: TextSize,
): Shape[] {
  if (!input) return shapes
  if (input.attachedShapeId) return applyAttachedTextInput(shapes, input)
  if (input.value.length === 0) return shapes
  return [
    ...shapes,
    {
      id: uid(),
      type: 'text',
      x: input.x,
      y: input.y,
      text: input.value,
      size,
    },
  ]
}

function EraserIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M16.24 3.56L21.19 8.51c.78.78.78 2.05 0 2.83L12 20.53H5.59a2 2 0 0 1-1.41-.58L2.81 18.6a2 2 0 0 1 0-2.83L13.41 5.17a2 2 0 0 1 2.83-1.61z" />
      <path d="M8.5 9.5l6 6" />
      <path d="M22 21H7" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </svg>
  )
}

function StraightLineTypeIcon({ arrow }: { arrow: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 12L12 4" />
      {arrow && <path d="M8.4 4H12v3.6" />}
    </svg>
  )
}

function ElbowLineTypeIcon({ arrow }: { arrow: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.75 4.5H8.25V10.5H13.25" />
      {arrow && <path d="M10.8 8.25L13.25 10.5L10.8 12.75" />}
    </svg>
  )
}

export function AsciiSketcher({
  onInsert,
  onCancel,
  initialText,
  initialLanguage,
}: {
  onInsert: (text: string, language?: string) => void
  onCancel: () => void
  /** When set, seed history[0] by parsing the ASCII back into retained
   *  shapes where possible, with text fallback for any leftover glyphs. */
  initialText?: string
  initialLanguage?: string
}) {
  // History stack — every committed mutation pushes a new shapes array.
  const [history, setHistory] = useState<Shape[][]>(() => {
    const decodedContent = decodeAsciiSketchContent(initialText)
    const snapshotShapes =
      readSnapshotPayload(decodedContent.snapshot) ?? readSnapshotShapes(initialLanguage)
    if (snapshotShapes) return [snapshotShapes]
    if (!decodedContent.text) return [[]]
    return [parseAsciiSketch(decodedContent.text)]
  })
  const [historyIdx, setHistoryIdx] = useState(0)
  const shapes = history[historyIdx]

  const [tool, setTool] = useState<Tool>('rect')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [fillStyle, setFillStyle] = useState<FillStyle>('none')
  const [lineVariant, setLineVariant] = useState<LineVariant>('straight')
  // Default text size for newly created text + shape labels. When a shape
  // with text is selected, picking a size also updates that shape.
  const [textSize, setTextSize] = useState<TextSize>('s')
  const [drag, setDrag] = useState<Drag>(null)
  const [lineDraft, setLineDraft] = useState<LineDraft | null>(null)
  // Pressing space puts the editor in a "hand" mode — any left drag pans
  // the canvas instead of doing the active tool's job.
  const [spaceHeld, setSpaceHeld] = useState(false)
  // The grid cell under the pointer — a snap indicator so the user
  // sees exactly which cell the next character will land in.
  const [hoverCell, setHoverCell] = useState<Cell | null>(null)
  // Viewport size in cells, used so the grid grows to fill the visible
  // wrap. Without this, the wrap can show whitespace beyond the grid
  // that LOOKS editable but isn't.
  const [viewportCells, setViewportCells] = useState<{ w: number; h: number }>(
    { w: BASE_GRID_W, h: BASE_GRID_H },
  )
  // The visible canvas is shifted by this many pixels via CSS transform.
  // Negative x = canvas pushed left (more right content visible). Pan in
  // any direction just updates this; nothing is hard-walled.
  const [panPixels, setPanPixels] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  })
  // `centerX`, when set, anchors the text input to a fixed center column —
  // each keystroke recomputes `x` so the growing text stays centered around
  // it. Used by double-click-on-shape to label shapes from the middle.
  // `attachedShapeId`, when set, means this text input is editing the
  // shape's own `text` field (Excalidraw-style label). While editing, the
  // underlying rasterized label is hidden and the overlay is the single
  // source of visible text; on commit it writes back to the shape.
  const [textInput, setTextInput] = useState<TextInputState | null>(null)

  function updateTextInputValue(value: string) {
    setTextInput((prev) => {
      if (!prev) return null
      const x =
        prev.centerX !== undefined
          ? Math.max(0, prev.centerX - Math.floor(value.length / 2))
          : prev.x
      return { ...prev, value, x }
    })
  }

  const canvasRef = useRef<HTMLDivElement>(null)
  const panViewportRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const shapeClipboardRef = useRef<Shape[] | null>(null)
  const pasteOffsetRef = useRef(1)
  const panPixelsRef = useRef(panPixels)
  const committedPanPixelsRef = useRef(panPixels)
  // cellPx tracks the actual rendered cell dimensions PLUS the grid origin
  // relative to the canvas-wrap (the positioned ancestor that overlays sit
  // inside). Measured from the first .ascii-sketcher-cell so padding /
  // border / scroll never throw off coordinates.
  const [cellPx, setCellPx] = useState<{
    w: number
    h: number
    originX: number
    originY: number
  }>({ w: 8, h: 16, originX: 8, originY: 8 })

  const selectedShape = shapes.find((s) => s.id === selectedId) ?? null

  function chooseTool(next: Tool) {
    if (lineDraft && next !== lineDraft.type) {
      finishLineDraft(next)
      return
    }
    setTool(next)
  }

  function commit(next: Shape[]) {
    setLineDraft(null)
    setHistory((h) => [...h.slice(0, historyIdx + 1), next])
    setHistoryIdx((i) => i + 1)
  }

  function applyAttachedTextForImmediateInteraction(): Shape[] {
    if (!textInput?.attachedShapeId) return shapes
    const nextShapes = applyAttachedTextInput(shapes, textInput)
    const id = textInput.attachedShapeId
    setHistory((h) => {
      const copy = [...h]
      copy[historyIdx] = nextShapes
      return copy
    })
    setSelectedId(id)
    setTextInput(null)
    return nextShapes
  }

  function undo() {
    if (historyIdx > 0) {
      setLineDraft(null)
      setHistoryIdx((i) => i - 1)
    }
  }
  function redo() {
    if (historyIdx < history.length - 1) {
      setLineDraft(null)
      setHistoryIdx((i) => i + 1)
    }
  }

  function finishLineDraft(nextTool: Tool = 'select') {
    if (!lineDraft) {
      setTool(nextTool)
      return
    }

    const shape = lineDraftShape(lineDraft)
    if (shape) {
      commit([...shapes, shape])
      setSelectedId(shape.id)
    } else {
      setLineDraft(null)
    }
    setTool(nextTool)
  }

  function panTransform(pan: { x: number; y: number }): string {
    return `translate(${pan.x + gridOriginX * cellPx.w}px, ${pan.y + gridOriginY * cellPx.h}px)`
  }

  function applyPanTransform(pan: { x: number; y: number }) {
    const el = panViewportRef.current
    if (!el) return
    el.style.transform = panTransform(pan)
  }

  function commitPanIfWindowIsNearEdge(pan: { x: number; y: number }) {
    if (cellPx.w <= 0 || cellPx.h <= 0) return
    const committed = committedPanPixelsRef.current
    const thresholdX = (PAN_HEADROOM_W * cellPx.w) / 2
    const thresholdY = (PAN_HEADROOM_H * cellPx.h) / 2
    if (
      Math.abs(pan.x - committed.x) < thresholdX &&
      Math.abs(pan.y - committed.y) < thresholdY
    ) {
      return
    }
    committedPanPixelsRef.current = pan
    setPanPixels(pan)
  }

  function cellFromEvent(e: React.PointerEvent | React.MouseEvent): Cell | null {
    const canvas = canvasRef.current
    if (!canvas) return null
    // First rendered cell sits at world (gridOriginX, gridOriginY). Add
    // the rendered click index to that to get the absolute world cell —
    // values can be negative, that's fine, shapes carry signed coords.
    const measureCell = canvas.querySelector<HTMLElement>('.ascii-sketcher-measure-cell')
    const firstRow = canvas.querySelector<HTMLElement>('.ascii-sketcher-row')
    if (!measureCell || !firstRow) return null
    const cellRect = measureCell.getBoundingClientRect()
    const rowRect = firstRow.getBoundingClientRect()
    if (cellRect.width <= 0 || rowRect.height <= 0) return null
    const renderedX = Math.floor((e.clientX - rowRect.left) / cellRect.width)
    const renderedY = Math.floor((e.clientY - rowRect.top) / rowRect.height)
    // Clip to the rendered window; this should always contain the visible
    // viewport thanks to PAN_HEADROOM.
    if (renderedX < 0 || renderedX >= gridSize.w || renderedY < 0 || renderedY >= gridSize.h)
      return null
    return { x: gridOriginX + renderedX, y: gridOriginY + renderedY }
  }

  function hitTestInShapes(sourceShapes: Shape[], p: Cell): Shape | null {
    for (let i = sourceShapes.length - 1; i >= 0; i--) {
      const s = sourceShapes[i]
      if (shapeHitTest(p, s)) return s
    }
    return null
  }

  function hitTest(p: Cell): Shape | null {
    return hitTestInShapes(shapes, p)
  }

  // Excalidraw-style label editor — opens centered on the shape with the
  // existing label pre-filled. Text is stored as the shape's own `text`
  // field so it travels with the shape on move/resize.
  function openLabelEditor(hit: Shape) {
    if (hit.type === 'text' || hit.type === 'freedraw') return
    const b = shapeBounds(hit)
    const boundsCenter = {
      x: Math.floor((b.x1 + b.x2) / 2),
      y: Math.floor((b.y1 + b.y2) / 2),
    }
    const labelCell =
      hit.type === 'line' || hit.type === 'arrow'
        ? lineMidpoint(hit.points, hit.variant) ?? boundsCenter
        : boundsCenter
    const existing =
      'text' in hit && typeof hit.text === 'string' ? hit.text : ''
    setDrag(null)
    setSelectedId(hit.id)
    setTextInput({
      x: labelCell.x - Math.floor(existing.length / 2),
      y: labelCell.y,
      value: existing,
      centerX: labelCell.x,
      attachedShapeId: hit.id,
    })
  }

  // Manual double-click detection. The browser's native dblclick is
  // unreliable here because resize handles, the selection overlay, and
  // pointer-capture can split the two clicks across different elements.
  // We track the time + nearby cell + shape of the most recent pointer-down
  // and declare a double-click if the next one hits the same shape within
  // 400ms. A small cell tolerance matters on text grids because the second
  // click often lands one cell over.
  const lastTapRef = useRef<{
    time: number
    cell: Cell
    shapeId: string | null
  } | null>(null)

  function tryDoubleClick(cell: Cell): boolean {
    const hit = hitTest(cell)
    const shapeId = hit?.id ?? null
    const now = Date.now()
    const last = lastTapRef.current
    const matches =
      last &&
      now - last.time < 400 &&
      cellDistance(last.cell, cell) <= 2 &&
      last.shapeId === shapeId &&
      shapeId !== null
    if (matches && hit) {
      lastTapRef.current = null
      openLabelEditor(hit)
      return true
    }
    lastTapRef.current = { time: now, cell, shapeId }
    return false
  }

  function commitText() {
    if (!textInput) return

    if (textInput.attachedShapeId) {
      const id = textInput.attachedShapeId
      commit(applyAttachedTextInput(shapes, textInput))
      setSelectedId(id)
      setTextInput(null)
      return
    }

    if (textInput.value.length > 0) {
      const t: TextShape = {
        id: uid(),
        type: 'text',
        x: textInput.x,
        y: textInput.y,
        text: textInput.value,
        size: textSize,
      }
      commit([...shapes, t])
      chooseTool('select')
      setSelectedId(t.id)
    }
    setTextInput(null)
  }

  function insertSketch() {
    const exportShapes = materializeLineDraftForExport(shapes, lineDraft)
    const exported = exportSketch(materializeTextInputForExport(exportShapes, textInput, textSize))
    onInsert(exported.text, exported.language)
  }

  // Start a pan drag — captures the current pan offset (in pixels) so
  // onPointerMove can compute the new transform from the pointer delta.
  // No scroll involved → no hard limits, panning works in every
  // direction including past the original origin.
  function startPan(e: React.PointerEvent): boolean {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const pan = panPixelsRef.current
    setDrag({
      kind: 'panning',
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPanX: pan.x,
      startPanY: pan.y,
    })
    return true
  }

  function onPointerDown(e: React.PointerEvent) {
    rootRef.current?.focus()

    // Pan triggers that don't need cell coords:
    //   - middle mouse button (e.button === 1)
    //   - space held + any button
    if (e.button === 1 || (spaceHeld && e.button === 0)) {
      if (startPan(e)) return
    }

    const cell = cellFromEvent(e)
    if (!cell) return

    // Detect double-click before committing any active text input, so a
    // double-click on a labeled shape opens the editor with the existing
    // label rather than dismissing the in-flight one first.
    if (tryDoubleClick(cell)) return

    let activeShapes = shapes
    if (textInput?.attachedShapeId) activeShapes = applyAttachedTextForImmediateInteraction()
    else if (textInput) commitText()
    e.currentTarget.setPointerCapture(e.pointerId)

    if (lineDraft && isLineTool(tool) && tool === lineDraft.type) {
      const last = lastPoint(lineDraft.points)
      if (!last || !sameCell(last, cell)) {
        setLineDraft({
          ...lineDraft,
          points: [...lineDraft.points, cell],
          preview: cell,
        })
      }
      setSelectedId(null)
      return
    }

    if (tool === 'select') {
      const hit = hitTestInShapes(activeShapes, cell)
      if (hit) {
        setSelectedId(hit.id)
        setDrag({ kind: 'moving', shapeId: hit.id, startCell: cell, original: hit })
      } else {
        // Empty-space drag in select mode → pan (there's no other useful
        // gesture here — selection rubber-banding isn't implemented).
        setSelectedId(null)
        startPan(e)
      }
      return
    }

    if (tool === 'erase') {
      const hit = hitTestInShapes(activeShapes, cell)
      if (hit) {
        commit(activeShapes.filter((s) => s.id !== hit.id))
        if (selectedId === hit.id) setSelectedId(null)
      }
      return
    }

    if (tool === 'text') {
      setTextInput({ x: cell.x, y: cell.y, value: '' })
      setSelectedId(null)
      return
    }

    if (tool === 'freedraw') {
      setDrag({
        kind: 'freedraw',
        shape: { id: uid(), type: 'freedraw', points: [cell] },
      })
      setSelectedId(null)
      return
    }

    // Shape tools — start drag-to-create.
    if (tool === 'rect' || tool === 'ellipse' || tool === 'diamond') {
      const newShape: Shape = {
        id: uid(),
        type: tool,
        rect: { x1: cell.x, y1: cell.y, x2: cell.x, y2: cell.y },
        fill: fillStyle,
      }
      setDrag({ kind: 'creating', shape: newShape, startCell: cell })
      setSelectedId(null)
      return
    }

    if (isLineTool(tool)) {
      const newShape: LineShape = {
        id: uid(),
        type: tool,
        variant: lineVariant,
        points: [cell, cell],
      }
      setDrag({ kind: 'creating', shape: newShape, startCell: cell })
      setSelectedId(null)
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    // Snap indicator: track the cell under the pointer (skip while
    // panning). Change-detected so it only re-renders on cell crossing.
    if (drag?.kind !== 'panning') {
      const hc = cellFromEvent(e)
      setHoverCell((prev) =>
        hc && prev && sameCell(hc, prev) ? prev : hc,
      )
    }
    // Pan doesn't depend on cells — handle it before the cell lookup so
    // it works even when the pointer is over a non-cell area (e.g. the
    // canvas margins inside the wrap).
    if (drag?.kind === 'panning') {
      const nextPan = {
        x: drag.startPanX + (e.clientX - drag.startClientX),
        y: drag.startPanY + (e.clientY - drag.startClientY),
      }
      panPixelsRef.current = nextPan
      applyPanTransform(nextPan)
      commitPanIfWindowIsNearEdge(nextPan)
      return
    }

    const cell = cellFromEvent(e)
    if (!cell) return

    if (!drag && lineDraft) {
      setLineDraft({ ...lineDraft, preview: cell })
      return
    }

    if (!drag) return

    if (drag.kind === 'moving') {
      // Live-update without pushing to history; the move commits on pointer-up.
      const dx = cell.x - drag.startCell.x
      const dy = cell.y - drag.startCell.y
      const moved = moveShape(drag.original, dx, dy)
      setHistory((h) => {
        const copy = [...h]
        copy[historyIdx] = copy[historyIdx].map((s) =>
          s.id === drag.shapeId ? moved : s,
        )
        return copy
      })
      return
    }

    if (drag.kind === 'creating') {
      const s = drag.shape
      let updated: Shape
      if (s.type === 'line' || s.type === 'arrow') {
        updated = { ...s, points: replaceLastPoint(s.points, cell) }
      } else if (
        s.type === 'rect' ||
        s.type === 'ellipse' ||
        s.type === 'diamond'
      ) {
        updated = {
          ...s,
          rect: {
            x1: drag.startCell.x,
            y1: drag.startCell.y,
            x2: cell.x,
            y2: cell.y,
          },
        }
      } else {
        return
      }
      setDrag({ ...drag, shape: updated })
      return
    }

    if (drag.kind === 'resizing') {
      const updated = resizeShape(drag.original, drag.handle, cell)
      setHistory((h) => {
        const copy = [...h]
        copy[historyIdx] = copy[historyIdx].map((s) =>
          s.id === drag.shapeId ? updated : s,
        )
        return copy
      })
      return
    }

    if (drag.kind === 'freedraw') {
      const last = drag.shape.points[drag.shape.points.length - 1]
      if (last && last.x === cell.x && last.y === cell.y) return
      setDrag({
        kind: 'freedraw',
        shape: { ...drag.shape, points: [...drag.shape.points, cell] },
      })
    }
  }

  function onPointerUp() {
    if (!drag) return
    if (drag.kind === 'panning') {
      const finalPan = panPixelsRef.current
      committedPanPixelsRef.current = finalPan
      setPanPixels(finalPan)
      setDrag(null)
      return
    }
    if (drag.kind === 'moving' || drag.kind === 'resizing') {
      // shapes[] was already mutated in-place during the drag; push one
      // history entry now that it's done.
      commit(shapes)
    } else if (drag.kind === 'creating') {
      const b = shapeBounds(drag.shape)
      if (isLineShape(drag.shape) && !lastSegmentHasLength(drag.shape.points)) {
        setLineDraft({
          id: drag.shape.id,
          type: drag.shape.type,
          variant: drag.shape.variant ?? lineVariant,
          points: [drag.startCell],
          preview: drag.startCell,
        })
        setTool(drag.shape.type)
        setSelectedId(null)
      } else if (b.x2 - b.x1 >= 1 || b.y2 - b.y1 >= 1) {
        // Skip degenerate single-cell shapes from accidental clicks.
        commit([...shapes, drag.shape])
        setSelectedId(drag.shape.id)
        if (isLineShape(drag.shape)) {
          setTool('select')
        } else {
          chooseTool('select')
        }
      }
    } else if (drag.kind === 'freedraw') {
      if (drag.shape.points.length > 1) {
        commit([...shapes, drag.shape])
        chooseTool('select')
        setSelectedId(drag.shape.id)
      }
    }
    setDrag(null)
  }

  function changeFill(fill: FillStyle) {
    setFillStyle(fill)
    if (selectedShape && 'fill' in selectedShape) {
      const updated: Shape = { ...selectedShape, fill }
      commit(shapes.map((s) => (s.id === selectedShape.id ? updated : s)))
    }
  }

  function changeLineVariant(variant: LineVariant) {
    setLineVariant(variant)
    if (tool === 'select' && selectedShape && isLineShape(selectedShape)) {
      const updated: Shape = { ...selectedShape, variant }
      commit(shapes.map((s) => (s.id === selectedShape.id ? updated : s)))
      return
    }
    if (lineDraft) {
      setLineDraft({ ...lineDraft, variant })
    }
  }

  // Change the text size for the selected shape (if it has a text label) OR
  // the standalone selected TextShape. Also stores the choice as the new
  // default so subsequent text/shapes pick it up.
  function changeTextSize(size: TextSize) {
    setTextSize(size)
    if (!selectedShape) return
    if (selectedShape.type === 'text') {
      const updated: Shape = { ...selectedShape, size }
      commit(shapes.map((s) => (s.id === selectedShape.id ? updated : s)))
    } else if ('text' in selectedShape) {
      const updated: Shape = { ...selectedShape, textSize: size }
      commit(shapes.map((s) => (s.id === selectedShape.id ? updated : s)))
    }
  }

  // Layer ordering — same semantics as Excalidraw's "to back / backward /
  // forward / to front". Shapes later in the array render on top.
  function reorderSelected(direction: 'back' | 'backward' | 'forward' | 'front') {
    if (!selectedId) return
    const idx = shapes.findIndex((s) => s.id === selectedId)
    if (idx < 0) return
    const without = [...shapes.slice(0, idx), ...shapes.slice(idx + 1)]
    const shape = shapes[idx]
    let next: Shape[]
    if (direction === 'back') next = [shape, ...without]
    else if (direction === 'front') next = [...without, shape]
    else if (direction === 'backward') {
      const ni = Math.max(0, idx - 1)
      next = [...without.slice(0, ni), shape, ...without.slice(ni)]
    } else {
      const ni = Math.min(without.length, idx + 1)
      next = [...without.slice(0, ni), shape, ...without.slice(ni)]
    }
    commit(next)
  }

  function deleteSelected() {
    if (!selectedId) return
    commit(shapes.filter((s) => s.id !== selectedId))
    setSelectedId(null)
  }

  function copySelectedShape(): boolean {
    if (!selectedShape) return false
    const copied = [cloneShape(selectedShape)]
    shapeClipboardRef.current = copied
    pasteOffsetRef.current = 1
    writeSystemClipboard(encodeShapeClipboard(copied))
    return true
  }

  function cutSelectedShape(): boolean {
    if (!selectedShape) return false
    const copied = [cloneShape(selectedShape)]
    shapeClipboardRef.current = copied
    pasteOffsetRef.current = 1
    writeSystemClipboard(encodeShapeClipboard(copied))
    commit(shapes.filter((s) => s.id !== selectedShape.id))
    setSelectedId(null)
    return true
  }

  function pasteShapes(sourceShapes: Shape[]): boolean {
    if (sourceShapes.length === 0) return false
    const offset = pasteOffsetRef.current
    const dx = offset * 2
    const dy = offset
    const pasted = sourceShapes.map((shape) => cloneShapeForPaste(shape, dx, dy))
    pasteOffsetRef.current = offset + 1
    commit([...shapes, ...pasted])
    setTool('select')
    setSelectedId(pasted[pasted.length - 1].id)
    return true
  }

  async function pasteFromClipboard() {
    if (shapeClipboardRef.current && pasteShapes(shapeClipboardRef.current)) return

    const text = await readSystemClipboard()
    const decoded = text ? decodeShapeClipboard(text) : null
    if (!decoded) return
    shapeClipboardRef.current = decoded.map((shape) => cloneShape(shape))
    pasteOffsetRef.current = 1
    pasteShapes(decoded)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // text-input mode swallows printable keys
    if (textInput) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        const key = e.key.toLowerCase()
        if (key === 'c') {
          e.preventDefault()
          writeSystemClipboard(textInput.value)
          return
        }
        if (key === 'x') {
          e.preventDefault()
          writeSystemClipboard(textInput.value)
          updateTextInputValue('')
          return
        }
        if (key === 'v') {
          e.preventDefault()
          void readSystemClipboard().then((text) => {
            if (!text || decodeShapeClipboard(text)) return
            const pastedText = text.replace(/\r\n?/g, '\n').replace(/\n+/g, ' ')
            setTextInput((prev) => {
              if (!prev) return null
              const value = prev.value + pastedText
              const x =
                prev.centerX !== undefined
                  ? Math.max(0, prev.centerX - Math.floor(value.length / 2))
                  : prev.x
              return { ...prev, value, x }
            })
          })
          return
        }
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        commitText()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        // Attached labels cancel without modifying the shape's existing
        // text. Standalone text inputs match the old behavior — commit if
        // anything was typed, dismiss otherwise.
        if (textInput.attachedShapeId) setTextInput(null)
        else commitText()
        return
      }
      if (e.key === 'Backspace') {
        e.preventDefault()
        updateTextInputValue(textInput.value.slice(0, -1))
        return
      }
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        updateTextInputValue(textInput.value + e.key)
      }
      return
    }

    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const key = e.key.toLowerCase()
      if (key === 'c') {
        e.preventDefault()
        copySelectedShape()
        return
      }
      if (key === 'x') {
        e.preventDefault()
        cutSelectedShape()
        return
      }
      if (key === 'v') {
        e.preventDefault()
        void pasteFromClipboard()
        return
      }
    }

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
      return
    }

    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (selectedId) {
        e.preventDefault()
        deleteSelected()
      }
      return
    }

    if (e.key === 'Escape') {
      if (lineDraft) {
        finishLineDraft('select')
        return
      }
      if (selectedId) setSelectedId(null)
      else if (tool !== 'select') setTool('select')
      return
    }

    // Tool shortcut (V/R/U/O/D/L/A/T/P/E)
    const matched = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase())
    if (matched && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      chooseTool(matched.id)
      return
    }

    // Fill style 1-5
    const fills: FillStyle[] = ['none', 'light', 'medium', 'dark', 'solid']
    const fIdx = ['1', '2', '3', '4', '5'].indexOf(e.key)
    if (fIdx >= 0) {
      e.preventDefault()
      changeFill(fills[fIdx])
    }
  }

  // Compose render shapes — include the in-flight drag preview if any.
  // While an attached label is being edited, hide the rasterized copy on
  // the shape itself so the positioned text input is the only visible text.
  const renderShapes: Shape[] = useMemo(() => {
    let base: Shape[]
    if (drag?.kind === 'creating' || drag?.kind === 'freedraw') {
      base = [...shapes, drag.shape]
    } else if (lineDraft) {
      const previewPoints = sameCell(lineDraft.points[lineDraft.points.length - 1], lineDraft.preview)
        ? lineDraft.points
        : [...lineDraft.points, lineDraft.preview]
      base = [
        ...shapes,
        {
          id: lineDraft.id,
          type: lineDraft.type,
          variant: lineDraft.variant,
          points: previewPoints,
        },
      ]
    } else {
      base = shapes
    }
    base = stripAttachedTextWhileEditing(base, textInput)
    return base
  }, [shapes, drag, lineDraft, textInput])

  // The editable grid is a viewport-sized render window plus pan headroom.
  // Export is handled separately from the full retained shape bounds, so
  // offscreen shapes are still saved even though the live raster only draws
  // the sliding window.
  // The rendered grid is always (viewportCells + 2 × HEADROOM). It slides
  // — via gridOriginX/Y — to follow pan, so the visible viewport is
  // always inside the rendered window.
  const gridSize = useMemo(
    () => ({
      w: viewportCells.w + 2 * PAN_HEADROOM_W,
      h: viewportCells.h + 2 * PAN_HEADROOM_H,
    }),
    [viewportCells],
  )

  // World cell at rendered (0, 0). Negative when the user has panned past
  // the original origin. Changes by 1 every time pan accumulates one
  // cell-worth of pixels.
  const gridOriginX = useMemo(
    () =>
      cellPx.w > 0
        ? Math.floor(-panPixels.x / cellPx.w) - PAN_HEADROOM_W
        : -PAN_HEADROOM_W,
    [panPixels.x, cellPx.w],
  )
  const gridOriginY = useMemo(
    () =>
      cellPx.h > 0
        ? Math.floor(-panPixels.y / cellPx.h) - PAN_HEADROOM_H
        : -PAN_HEADROOM_H,
    [panPixels.y, cellPx.h],
  )
  useEffect(() => {
    panPixelsRef.current = panPixels
    committedPanPixelsRef.current = panPixels
    applyPanTransform(panPixels)
  }, [panPixels, gridOriginX, gridOriginY, cellPx.w, cellPx.h])

  // Shift every shape into the rendered grid's local coords by subtracting
  // gridOrigin. setCell in the rasterizers clips out-of-range cells, so
  // shapes that fall outside the visible window just don't draw.
  const shiftedRenderShapes = useMemo(
    () =>
      renderShapes.map((s) => moveShape(s, -gridOriginX, -gridOriginY)),
    [renderShapes, gridOriginX, gridOriginY],
  )
  // Display rasterization SKIPS text — text is drawn as a CSS-sized overlay
  // on top of the grid (see `textOverlays` below) so sizes m/l/xl can render
  // at real font-size. Export uses the same rasterize without skipText so
  // the inserted markdown still contains the text characters.
  const grid = useMemo(
    () => rasterize(shiftedRenderShapes, gridSize.w, gridSize.h, { skipText: true }),
    [shiftedRenderShapes, gridSize],
  )
  const gridRows = useMemo(() => grid.map((row) => row.join('')), [grid])

  // Text overlay descriptors — one per text shape or labeled shape. Built
  // from world-cell coords; the JSX positions each by subtracting gridOrigin
  // and scaling by cellPx, the same convention as the selection box.
  const textOverlays = useMemo(() => {
    type Overlay = {
      key: string
      x: number // world cell coord (left edge of overlay box)
      y: number
      w: number // overlay box width in cells
      h: number // overlay box height in cells
      text: string
      size: TextSize
      align: 'left' | 'center'
    }
    const out: Overlay[] = []
    for (const s of renderShapes) {
      if (s.type === 'freedraw') continue
      if (s.type === 'text') {
        out.push({
          key: s.id,
          x: s.x,
          y: s.y,
          w: Math.max(s.text.length, 1),
          h: 1,
          text: s.text,
          size: s.size ?? 's',
          align: 'left',
        })
        continue
      }
      if (!('text' in s) || !s.text) continue
      const size: TextSize = s.textSize ?? 's'
      if (s.type === 'line' || s.type === 'arrow') {
        const mid = lineMidpoint(s.points, s.variant)
        if (!mid) continue
        out.push({
          key: s.id,
          x: mid.x - Math.floor(s.text.length / 2),
          y: mid.y,
          w: Math.max(s.text.length, 1),
          h: 1,
          text: s.text,
          size,
          align: 'center',
        })
      } else if (s.type === 'rect' || s.type === 'ellipse' || s.type === 'diamond') {
        const r = normalizeRect(s.rect)
        out.push({
          key: s.id,
          x: r.x1,
          y: r.y1,
          w: r.x2 - r.x1 + 1,
          h: r.y2 - r.y1 + 1,
          text: s.text,
          size,
          align: 'center',
        })
      }
    }
    return out
  }, [renderShapes])

  // Measure cell size + grid origin for overlay positioning. Anchors to the
  // first rendered cell so padding / scroll position can't cause drift.
  useEffect(() => {
    function measure() {
      const c = canvasRef.current
      const panViewport = c?.parentElement // .ascii-sketcher-pan-viewport
      const wrap = panViewport?.parentElement // .ascii-sketcher-canvas-wrap
      if (!c || !panViewport || !wrap) return
      const measureCell = c.querySelector<HTMLElement>('.ascii-sketcher-measure-cell')
      const firstRow = c.querySelector<HTMLElement>('.ascii-sketcher-row')
      if (!measureCell || !firstRow) return
      const cellRect = measureCell.getBoundingClientRect()
      const rowRect = firstRow.getBoundingClientRect()
      const viewportRect = panViewport.getBoundingClientRect()
      setCellPx({
        w: cellRect.width,
        h: rowRect.height,
        // Cell-to-viewport offset is unaffected by the viewport's own
        // transform — overlays inside the viewport stay aligned.
        originX: rowRect.left - viewportRect.left,
        originY: rowRect.top - viewportRect.top,
      })
      // Viewport in cells = how many fit in the visible wrap (the
      // overflow:hidden frame the pan-viewport lives inside).
      if (cellRect.width > 0 && rowRect.height > 0) {
        setViewportCells({
          w: Math.max(1, Math.ceil(wrap.clientWidth / cellRect.width)),
          h: Math.max(1, Math.ceil(wrap.clientHeight / rowRect.height)),
        })
      }
    }
    measure()
    const obs =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    if (obs) {
      if (canvasRef.current) obs.observe(canvasRef.current)
      const panViewport = canvasRef.current?.parentElement
      const wrap = panViewport?.parentElement
      if (panViewport) obs.observe(panViewport)
      if (wrap) obs.observe(wrap)
    }
    window.addEventListener('resize', measure)
    return () => {
      obs?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  // Track spacebar so the user can hold it down to switch any tool into a
  // temporary pan mode (Excalidraw / Figma convention).
  useEffect(() => {
    function onDown(e: KeyboardEvent) {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) {
        // Don't preventDefault if a text input is active (typing in
        // textInput) — the sketcher handles its own keyboard via
        // onKeyDown above.
        setSpaceHeld(true)
      }
    }
    function onUp(e: KeyboardEvent) {
      if (e.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
  }, [])

  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  const selectionBox = selectedShape ? shapeBounds(selectedShape) : null
  const fills: FillStyle[] = ['none', 'light', 'medium', 'dark', 'solid']
  const currentFill =
    selectedShape && 'fill' in selectedShape ? selectedShape.fill : fillStyle
  // What text size to show as "active" — prefer the selected shape's own
  // textSize when present, otherwise fall back to the global default.
  const currentTextSize: TextSize =
    selectedShape?.type === 'text'
      ? selectedShape.size ?? 's'
      : selectedShape && 'textSize' in selectedShape && selectedShape.textSize
        ? selectedShape.textSize
        : textSize
  const selectedLineShape = selectedShape && isLineShape(selectedShape) ? selectedShape : null
  const editingSelectedLine = tool === 'select' && selectedLineShape !== null
  const currentLineVariant: LineVariant =
    editingSelectedLine
      ? selectedLineShape?.variant ?? 'straight'
      : lineDraft?.variant ?? lineVariant
  const lineTypeRelevant =
    isLineTool(tool) || editingSelectedLine || lineDraft !== null
  const currentLineKind: LineShape['type'] =
    editingSelectedLine
      ? selectedLineShape?.type ?? 'arrow'
      : lineDraft?.type ?? (tool === 'line' ? 'line' : 'arrow')
  // Show the Size section when text is involved: text tool is active, OR the
  // selected shape is a TextShape, OR the selected shape is a text-carrying
  // shape (rect/ellipse/diamond/line/arrow — i.e., anything with a `text` slot).
  const sizeRelevant =
    tool === 'text' ||
    selectedShape?.type === 'text' ||
    (selectedShape != null &&
      selectedShape.type !== 'freedraw' &&
      'text' in selectedShape)
  const textSizes: { id: TextSize; label: string }[] = [
    { id: 's', label: 'S' },
    { id: 'm', label: 'M' },
    { id: 'l', label: 'L' },
    { id: 'xl', label: 'XL' },
  ]
  const canInsert =
    shapes.length > 0 ||
    lineDraftShape(lineDraft) !== null ||
    (!!textInput && textInput.value.length > 0)

  return (
    <div
      ref={rootRef}
      className="ascii-sketcher"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="ascii-sketcher-stage">
        {/* Excalidraw-style floating top toolbar — tools + undo/redo/clear */}
        <div className="ascii-sketcher-top-toolbar">
          <div className="ascii-sketcher-tools">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`ascii-sketcher-tool${tool === t.id ? ' active' : ''}`}
                onClick={() => chooseTool(t.id)}
                title={`${t.label} (${t.key})`}
                aria-label={t.label}
              >
                <span className="ascii-sketcher-tool-glyph">
                  {t.id === 'erase' ? (
                    <EraserIcon />
                  ) : t.id === 'freedraw' ? (
                    <PencilIcon />
                  ) : (
                    t.glyph
                  )}
                </span>
              </button>
            ))}
          </div>
          <div className="ascii-sketcher-divider" />
          <button
            type="button"
            className="ascii-sketcher-action"
            onClick={undo}
            disabled={historyIdx === 0}
            title="undo (⌘Z)"
            aria-label="undo"
          >
            ↶
          </button>
          <button
            type="button"
            className="ascii-sketcher-action"
            onClick={redo}
            disabled={historyIdx === history.length - 1}
            title="redo (⌘⇧Z)"
            aria-label="redo"
          >
            ↷
          </button>
          <button
            type="button"
            className="ascii-sketcher-action ascii-sketcher-action-text"
            onClick={() => commit([])}
            disabled={shapes.length === 0}
            title="clear all shapes"
            aria-label="clear all"
          >
            clear all
          </button>
        </div>

        {/* Excalidraw-style left properties panel — fill density + layer order.
         * Hidden in select tool when nothing is selected: there's nothing to
         * apply Fill to (it'd just set a default for future draws, but the
         * cursor tool doesn't draw) and nothing to reorder. The panel returns
         * the moment the user picks a draw tool OR selects a shape. */}
        {!(tool === 'select' && !selectedShape) && (
        <div className="ascii-sketcher-left-panel">
          <section className="ascii-sketcher-panel-section">
            <div className="ascii-sketcher-panel-label">Fill</div>
            <div className="ascii-sketcher-fills" aria-label="fill density">
              {fills.map((f, i) => (
                <button
                  key={f}
                  type="button"
                  className={`ascii-sketcher-fill${currentFill === f ? ' active' : ''}`}
                  onClick={() => changeFill(f)}
                  title={`${f} fill (${i + 1})`}
                  aria-label={`${f} fill`}
                >
                  <span className="ascii-sketcher-fill-glyph">
                    {f === 'none' ? '⊘' : FILL_CHARS[f]}
                  </span>
                </button>
              ))}
            </div>
          </section>
          {lineTypeRelevant && (
            <section className="ascii-sketcher-panel-section">
              <div className="ascii-sketcher-panel-label">
                {currentLineKind === 'arrow' ? 'Arrow type' : 'Line type'}
              </div>
              <div className="ascii-sketcher-fills" aria-label="line type">
                {LINE_VARIANTS.map((variant) => (
                  <button
                    key={variant.id}
                    type="button"
                    className={`ascii-sketcher-fill${currentLineVariant === variant.id ? ' active' : ''}`}
                    onClick={() => changeLineVariant(variant.id)}
                    title={`${variant.label} ${currentLineKind}`}
                    aria-label={`${variant.label} ${currentLineKind}`}
                  >
                    <span className="ascii-sketcher-line-type-icon">
                      {variant.id === 'straight' ? (
                        <StraightLineTypeIcon arrow={currentLineKind === 'arrow'} />
                      ) : (
                        <ElbowLineTypeIcon arrow={currentLineKind === 'arrow'} />
                      )}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
          {sizeRelevant && (
            <section className="ascii-sketcher-panel-section">
              <div className="ascii-sketcher-panel-label">Size</div>
              <div className="ascii-sketcher-fills" aria-label="text size">
                {textSizes.map((sz) => (
                  <button
                    key={sz.id}
                    type="button"
                    className={`ascii-sketcher-fill${currentTextSize === sz.id ? ' active' : ''}`}
                    onClick={() => changeTextSize(sz.id)}
                    title={`${sz.label} text size`}
                    aria-label={`${sz.label} text size`}
                  >
                    <span className="ascii-sketcher-fill-glyph ascii-sketcher-size-glyph">
                      {sz.label}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
          {selectedShape && (
            <section className="ascii-sketcher-panel-section">
              <div className="ascii-sketcher-panel-label">Layers</div>
              <div className="ascii-sketcher-layer-buttons">
                <button
                  type="button"
                  className="ascii-sketcher-action"
                  onClick={() => reorderSelected('back')}
                  title="send to back"
                  aria-label="send to back"
                >
                  ⤓
                </button>
                <button
                  type="button"
                  className="ascii-sketcher-action"
                  onClick={() => reorderSelected('backward')}
                  title="send backward"
                  aria-label="send backward"
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="ascii-sketcher-action"
                  onClick={() => reorderSelected('forward')}
                  title="bring forward"
                  aria-label="bring forward"
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="ascii-sketcher-action"
                  onClick={() => reorderSelected('front')}
                  title="bring to front"
                  aria-label="bring to front"
                >
                  ⤒
                </button>
              </div>
            </section>
          )}
        </div>
        )}

      <div className="ascii-sketcher-canvas-wrap">
        {/* Single transformed viewport — pan moves this container, not the
         * underlying scroll. All overlays (selection, handles, text input)
         * live inside so they pan with the canvas as one unit. */}
        <div
          ref={panViewportRef}
          className="ascii-sketcher-pan-viewport"
          style={{
            // Position the rendered grid so its first cell (world
            // gridOriginX/Y) sits at the right spot in screen space.
            // = where world (0,0) is (panPixels) + cells offset
            transform: panTransform(panPixels),
          }}
        >
        <div
          ref={canvasRef}
          className={`ascii-sketcher-canvas tool-${tool}${spaceHeld ? ' space-held' : ''}${drag?.kind === 'panning' ? ' panning' : ''}`}
          // faint grid: one square per measured character cell
          style={
            cellPx.w > 0
              ? { backgroundSize: `${cellPx.w}px ${cellPx.h}px` }
              : undefined
          }
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => setHoverCell(null)}
        >
          <span className="ascii-sketcher-cell ascii-sketcher-measure-cell" aria-hidden="true">
            M
          </span>
          {gridRows.map((row, y) => (
            <div key={y} className="ascii-sketcher-row">
              {row}
            </div>
          ))}
        </div>
        {/* snap indicator — the cell the cursor will draw into */}
        {hoverCell && cellPx.w > 0 && !spaceHeld && drag?.kind !== 'panning' && (
          <div
            className="ascii-sketcher-hover-cell"
            style={{
              left: `${cellPx.originX + (hoverCell.x - gridOriginX) * cellPx.w}px`,
              top: `${cellPx.originY + (hoverCell.y - gridOriginY) * cellPx.h}px`,
              width: `${cellPx.w}px`,
              height: `${cellPx.h}px`,
            }}
          />
        )}
        {selectionBox && cellPx.w > 0 && (
          <div
            className="ascii-sketcher-selection"
            style={{
              left: `${cellPx.originX + (selectionBox.x1 - gridOriginX) * cellPx.w - 2}px`,
              top: `${cellPx.originY + (selectionBox.y1 - gridOriginY) * cellPx.h - 2}px`,
              width: `${(selectionBox.x2 - selectionBox.x1 + 1) * cellPx.w + 4}px`,
              height: `${(selectionBox.y2 - selectionBox.y1 + 1) * cellPx.h + 4}px`,
            }}
          />
        )}
        {selectedShape && cellPx.w > 0 &&
          shapeHandles(selectedShape).map((h, i) => {
            const handleClass =
              h.spec.kind === 'corner'
                ? `handle-corner handle-${h.spec.corner}`
                : 'handle-point'
            // Corner handles anchor at the outside cell-corner of the shape
            // so they sit just past the bounding box and don't block clicks
            // on the shape interior. Line/arrow point handles stay at the
            // cell center (the point is literally there).
            let leftPx: number
            let topPx: number
            if (h.spec.kind === 'corner') {
              const xOff =
                h.spec.corner === 'tr' || h.spec.corner === 'br' ? 1 : 0
              const yOff =
                h.spec.corner === 'bl' || h.spec.corner === 'br' ? 1 : 0
              leftPx = cellPx.originX + (h.cell.x - gridOriginX + xOff) * cellPx.w - 5
              topPx = cellPx.originY + (h.cell.y - gridOriginY + yOff) * cellPx.h - 5
            } else {
              leftPx = cellPx.originX + (h.cell.x - gridOriginX + 0.5) * cellPx.w - 5
              topPx = cellPx.originY + (h.cell.y - gridOriginY + 0.5) * cellPx.h - 5
            }
            return (
              <div
                key={i}
                className={`ascii-sketcher-handle ${handleClass}`}
                style={{ left: `${leftPx}px`, top: `${topPx}px` }}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  // Manual double-click detection: if the user clicks the
                  // same cell twice quickly (even on a corner handle of a
                  // small shape), open the label editor instead of starting
                  // a resize.
                  const cell = cellFromEvent(e)
                  if (cell && tryDoubleClick(cell)) return
                  const resizeOriginal = textInput?.attachedShapeId
                    ? applyAttachedTextForImmediateInteraction()
                        .find((s) => s.id === selectedShape.id) ?? selectedShape
                    : selectedShape
                  e.currentTarget.setPointerCapture(e.pointerId)
                  setDrag({
                    kind: 'resizing',
                    shapeId: selectedShape.id,
                    handle: h.spec,
                    original: resizeOriginal,
                  })
                }}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              />
            )
          })}
        {/* CSS-sized text overlay. The grid below carries no text characters
         * (rasterize is called with skipText), so what you see here IS the
         * text. font-size scales with cellPx and the per-shape size, giving
         * real visual scaling for m/l/xl without ascii-art glyphs. */}
        {cellPx.w > 0 &&
          textOverlays.map((o) => {
            const scale = TEXT_SIZE_SCALE[o.size]
            const fontPx = cellPx.h * scale
            const areaLeftPx = cellPx.originX + (o.x - gridOriginX) * cellPx.w
            const areaTopPx = cellPx.originY + (o.y - gridOriginY) * cellPx.h
            const areaWidthPx = o.w * cellPx.w
            const areaHeightPx = o.h * cellPx.h
            const textWidthPx = Math.max(
              cellPx.w,
              Math.max(o.text.length, 1) * cellPx.w * scale * TEXT_WIDTH_CELL_SCALE,
            )
            const textHeightPx = Math.max(cellPx.h, cellPx.h * scale)
            const widthPx =
              o.align === 'center' ? Math.max(areaWidthPx, textWidthPx) : textWidthPx
            const heightPx =
              o.align === 'center' ? Math.max(areaHeightPx, textHeightPx) : textHeightPx
            const leftPx =
              o.align === 'center' ? areaLeftPx + (areaWidthPx - widthPx) / 2 : areaLeftPx
            const topPx =
              o.align === 'center' ? areaTopPx + (areaHeightPx - heightPx) / 2 : areaTopPx
            return (
              <div
                key={`overlay-${o.key}`}
                className={`ascii-sketcher-text-overlay align-${o.align} size-${o.size}`}
                style={{
                  left: `${leftPx}px`,
                  top: `${topPx}px`,
                  width: `${widthPx}px`,
                  height: `${heightPx}px`,
                  fontSize: `${fontPx}px`,
                  lineHeight: `${textHeightPx}px`,
                }}
              >
                {o.text}
              </div>
            )
          })}
        {textInput && cellPx.w > 0 && (() => {
          // The live text input's font-size mirrors the size of the shape
          // being edited (when attached) or the current default text size
          // (when free-floating). This way the user sees the final rendering
          // as they type.
          let liveSize: TextSize = textSize
          if (textInput.attachedShapeId) {
            const attached = shapes.find((sh) => sh.id === textInput.attachedShapeId)
            if (attached && attached.type !== 'freedraw' && attached.type !== 'text') {
              liveSize = attached.textSize ?? 's'
            } else if (attached?.type === 'text') {
              liveSize = attached.size ?? 's'
            }
          }
          const scale = TEXT_SIZE_SCALE[liveSize]
          const fontPx = cellPx.h * scale
          const textWidthPx = Math.max(
            cellPx.w * scale * TEXT_WIDTH_CELL_SCALE,
            Math.max(textInput.value.length, 1) * cellPx.w * scale * TEXT_WIDTH_CELL_SCALE,
          )
          const caretWidthPx = cellPx.w * scale * TEXT_WIDTH_CELL_SCALE
          const boxWidthPx = textWidthPx + caretWidthPx
          const boxHeightPx = Math.max(cellPx.h, cellPx.h * scale)
          const cellLeftPx = cellPx.originX + (textInput.x - gridOriginX) * cellPx.w
          const cellTopPx = cellPx.originY + (textInput.y - gridOriginY) * cellPx.h
          const leftPx =
            textInput.centerX !== undefined
              ? cellPx.originX +
                (textInput.centerX - gridOriginX + 0.5) * cellPx.w -
                textWidthPx / 2
              : cellLeftPx
          const topPx =
            textInput.centerX !== undefined
              ? cellPx.originY +
                (textInput.y - gridOriginY + 0.5) * cellPx.h -
                boxHeightPx / 2
              : cellTopPx
          return (
            <div
              className={`ascii-sketcher-textinput${textInput.attachedShapeId ? ' attached' : ''} size-${liveSize}`}
              style={{
                left: `${leftPx}px`,
                top: `${topPx}px`,
                width: `${boxWidthPx}px`,
                height: `${boxHeightPx}px`,
                fontSize: `${fontPx}px`,
                lineHeight: `${boxHeightPx}px`,
              }}
            >
              <span>{textInput.value}</span>
              <span className="ascii-sketcher-textinput-caret" />
            </div>
          )
        })()}
        </div>
      </div>
      </div>

      <div className="ascii-sketcher-actions">
        <span className="ascii-sketcher-hint">
          {textInput
            ? 'type · enter commits · esc cancels'
            : lineDraft
              ? 'move cursor · click to add point · esc finishes arrow'
            : tool === 'select'
              ? selectedId
                ? 'drag to move · backspace deletes · 1-5 changes fill'
                : 'click a shape to select'
              : tool === 'text'
                ? 'click to place · type'
                : tool === 'erase'
                  ? 'click a shape to delete'
                  : 'click+drag to draw · esc to switch to select'}
        </span>
        <div className="ascii-sketcher-spacer" />
        <button type="button" onClick={onCancel}>
          cancel
        </button>
        <button
          type="button"
          className="primary"
          onClick={insertSketch}
          disabled={!canInsert}
        >
          save
        </button>
      </div>
    </div>
  )
}
