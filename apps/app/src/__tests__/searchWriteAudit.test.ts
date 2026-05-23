import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Search-indexing completeness guard (docs/development/search-plan.md §5):
// `searchText`/`searchable` must be recomputed at EVERY atom path/body
// write, or renames/moves/restores leave stale search results.

const CONVEX = join(__dirname, '..', '..', 'convex')
const SOURCES = readdirSync(CONVEX).filter(
  (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'),
)
const read = (f: string) => readFileSync(join(CONVEX, f), 'utf8')
// Built fresh per use — a shared /g regex carries `lastIndex` across calls.
const ATOM_INSERT_SRC = "ctx\\.db\\.insert\\(\\s*['\"]atoms['\"]\\s*,"

// Extract the balanced `{ … }` object starting at the first `{` in `from`.
function objectAt(src: string, from: number): string {
  const open = src.indexOf('{', from)
  if (open === -1) return ''
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1)
  }
  return src.slice(open)
}

// Closing the blind spot: only these files may write atoms directly. A new
// file inserting atoms fails here, forcing the author to wire reindexing.
it('no atom-inserting convex file outside the known set', () => {
  const writers = SOURCES.filter((f) =>
    new RegExp(ATOM_INSERT_SRC).test(read(f)),
  ).sort()
  expect(writers).toEqual(['atoms.ts', 'folders.ts', 'seed.ts', 'trash.ts'])
})

describe('every atom path/body write derives search fields', () => {
  for (const f of ['atoms.ts', 'folders.ts', 'trash.ts', 'seed.ts', 'skillsMigration.ts']) {
    it(`${f}`, () => {
      const src = read(f)

      // 1. Each atom insert: an inline object literal must contain
      //    deriveSearchFields; a `insert('atoms', someVar)` form must have
      //    it assigned just before (trash.ts's Object.assign pattern).
      const insertRe = new RegExp(ATOM_INSERT_SRC, 'g')
      for (let m = insertRe.exec(src); m; m = insertRe.exec(src)) {
        const tail = src.slice(m.index + m[0].length)
        const inlineObject = /^\s*\{/.test(tail)
        if (inlineObject) {
          const obj = objectAt(src, m.index + m[0].length)
          expect(obj, `${f} @${m.index}: insert object missing deriveSearchFields`).toContain(
            'deriveSearchFields',
          )
        } else {
          const before = src.slice(Math.max(0, m.index - 500), m.index)
          expect(before, `${f} @${m.index}: insert(var) missing nearby deriveSearchFields`).toContain(
            'deriveSearchFields',
          )
        }
      }

      // 2. Each patch whose object sets `body:` must reindex.
      const patchRe = /ctx\.db\.patch\(/g
      for (let m = patchRe.exec(src); m; m = patchRe.exec(src)) {
        const obj = objectAt(src, m.index)
        if (/\bbody:/.test(obj)) {
          expect(obj, `${f} @${m.index}: body patch missing deriveSearchFields`).toContain(
            'deriveSearchFields',
          )
        }
      }
    })
  }
})
