// resolveLiveTotal — the pure rollup core for the FROZEN
// `{identifier}` live-total form (inline-atom-format-v0.md).
//
// UC-3 / EF4 (the #1 Phase-4 risk): a live total is a RENDERED
// PROJECTION — explicitly non-authoritative, NEVER written back into
// a note body. This module is pure + total: it is fed already-gathered
// value atoms (no IO, like resolveWindow is fed stores) and returns a
// number or null. It NEVER throws and NEVER produces an error string
// (format contract: a non-resolving atom renders as `___`, never an
// error). Lives in convex/ so the Convex query adapter imports the
// SAME tested core; src/lib re-exports it for the editor + tests.

export type RollupOp = 'sum' | 'count'

/** What an `{identifier}` binds to. Authored by beam/workflow (a
 *  `rollups` row) or derived from a Phase-3 window aggregate. */
export type RollupSpec = { op: RollupOp; key: string }

/** A parsed value atom (the InlineAtom 'value' subset). The markdown
 *  body stays the source of truth; this is extracted by the single
 *  FROZEN parser, never re-written. */
export type ValueAtom = {
  key: string
  value: string | number | boolean
}

// Spec keys may be authored (table/window) → treat as untrusted, even
// though we never build an object keyed by them here (defence-in-depth
// + parity with resolveWindow).
const FORBIDDEN_KEY = new Set(['__proto__', 'prototype', 'constructor'])
const safeKey = (k: unknown): k is string =>
  typeof k === 'string' && k.length > 0 && !FORBIDDEN_KEY.has(k)

function validSpec(s: unknown): s is RollupSpec {
  if (s == null || typeof s !== 'object') return false
  const sp = s as Record<string, unknown>
  return (
    (sp.op === 'sum' || sp.op === 'count') && safeKey(sp.key)
  )
}

/**
 * Resolve a live total. Fail-soft by contract:
 *  - no/!valid spec        → null  (renders `___`)
 *  - `count`               → integer ≥ 0 (0 is a real answer)
 *  - `sum`, no numeric hit → null  (absent ≠ a misleading authoritative 0)
 *  - `sum`                 → sum of NUMBER-typed values for that key
 *
 * Only genuine `number` values are summed (the FROZEN grammar types
 * `{k: 6}` as number; `{k: "6"}` is a string and is NOT coerced —
 * a rollup must never invent numeric truth from prose).
 */
export function resolveLiveTotal(
  spec: RollupSpec | null | undefined,
  atoms: ReadonlyArray<ValueAtom>,
): number | null {
  if (!validSpec(spec)) return null
  const matching = atoms.filter(
    (a) => a != null && a.key === spec.key,
  )
  if (spec.op === 'count') return matching.length
  const nums = matching
    .map((a) => a.value)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (nums.length === 0) return null
  return nums.reduce((s, n) => s + n, 0)
}
