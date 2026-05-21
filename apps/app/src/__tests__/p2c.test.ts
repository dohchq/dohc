import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SKILL_MAX_BYTES,
  pathDeriveLabel,
  skillBodyBytes,
} from '../../convex/agent'

// Track-3 P2c — `run_skill` tool implementation + `read_atom`
// skill/plugin body INERT preview (§3.1) + SKILL_MAX_BYTES +
// pathDeriveLabel. Behavioral tests of run_skill require driving
// the agent's tool surface end-to-end (P3-level integration); v1
// locks the pure-helper + structural surface here. The gate
// primitive (P2b.1) is already unit-locked; combined with these
// structural tests run_skill's correctness is well-evidenced.

const __dirname = dirname(fileURLToPath(import.meta.url))
const AGENT_SRC = readFileSync(
  resolve(__dirname, '../../convex/agent.ts'),
  'utf8',
)

// Slice each tool's handler body from source. Reads from
// `<op>: createTool({` to the next tool's declaration; bounds
// each handler as a single string regex-scannable in isolation.
const TOOL_BODIES: Record<string, string> = (() => {
  const bodies: Record<string, string> = {}
  const re = /(\w+):\s*createTool\(\{/g
  const matches: Array<{ name: string; start: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(AGENT_SRC))) {
    matches.push({ name: m[1], start: m.index })
  }
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i]
    const next = matches[i + 1]
    const end = next ? next.start : AGENT_SRC.length
    bodies[cur.name] = AGENT_SRC.slice(cur.start, end)
  }
  return bodies
})()

describe('Track-3 P2c — SKILL_MAX_BYTES + pathDeriveLabel pure helpers', () => {
  it('SKILL_MAX_BYTES is 32 KiB (design §1.1 lock)', () => {
    expect(SKILL_MAX_BYTES).toBe(32 * 1024)
  })

  it('pathDeriveLabel: falls back to path for malformed inputs (P2c fold Codex F5)', () => {
    expect(pathDeriveLabel('/')).toBe('/')
    expect(pathDeriveLabel('')).toBe('(untitled)')
  })

  it('pathDeriveLabel: strips dirs + .md extension', () => {
    expect(pathDeriveLabel('skills/weekly-review.md')).toBe('weekly-review')
    expect(pathDeriveLabel('skills/team/standup.md')).toBe('standup')
    expect(pathDeriveLabel('me.md')).toBe('me')
  })

  it('pathDeriveLabel: case-insensitive .md strip', () => {
    expect(pathDeriveLabel('skills/foo.MD')).toBe('foo')
    expect(pathDeriveLabel('skills/foo.Md')).toBe('foo')
  })

  it('pathDeriveLabel: preserves dotted basenames before the .md ext', () => {
    expect(pathDeriveLabel('skills/weekly-review.q3.md')).toBe(
      'weekly-review.q3',
    )
  })

  it('pathDeriveLabel: collision case — same label at different paths', () => {
    // Design line 511: `skills/team/weekly-review.md` and
    // `skills/client/weekly-review.md` both label as
    // `weekly-review`. The agent MUST use canonical path, not
    // label, as the identifier (run_skill({path})).
    expect(pathDeriveLabel('skills/team/weekly-review.md')).toBe(
      'weekly-review',
    )
    expect(pathDeriveLabel('skills/client/weekly-review.md')).toBe(
      'weekly-review',
    )
  })

  it('pathDeriveLabel is a PURE function (no side effects)', () => {
    const before = 'skills/foo.md'
    pathDeriveLabel(before)
    expect(before).toBe('skills/foo.md') // input unchanged
  })

  it('skillBodyBytes: counts UTF-8 bytes, not chars (P2c fold Codex F2)', () => {
    expect(skillBodyBytes('hello')).toBe(5)
    expect(skillBodyBytes('café')).toBe(5) // é = 2 bytes
    expect(skillBodyBytes('日本語')).toBe(9) // 3 chars × 3 bytes
    expect(skillBodyBytes('🔥')).toBe(4)
    expect(skillBodyBytes('')).toBe(0)
  })

  it('skillBodyBytes correctly identifies a >cap UTF-8 body that would pass char-count check', () => {
    // 10923 CJK chars: length=10923 (passes a length cap) but
    // bytes=32769 (fails the byte cap). A character-count cap
    // would WRONGLY accept this; the byte cap correctly refuses.
    const cjk = '日'.repeat(10923)
    expect(cjk.length).toBeLessThanOrEqual(SKILL_MAX_BYTES)
    expect(skillBodyBytes(cjk)).toBeGreaterThan(SKILL_MAX_BYTES)
  })
})

describe('Track-3 P2c — `run_skill` tool surface (structural)', () => {
  const runSkillBody = TOOL_BODIES['run_skill']

  it('run_skill is registered as a tool in dohcAgent', () => {
    expect(runSkillBody).toMatch(/run_skill:\s*createTool\(\{/)
  })

  it('run_skill input schema is { path: string }', () => {
    expect(runSkillBody).toMatch(/inputSchema:\s*z\.object\(\{\s*path:\s*z\.string\(\)\s*\}\)/)
  })

  it('run_skill reads ctx.threadId + (promptMessageId ?? messageId)', () => {
    expect(runSkillBody).toMatch(/c\.threadId/)
    expect(runSkillBody).toMatch(/c\.promptMessageId\s*\?\?\s*c\.messageId/)
  })

  it('run_skill refuses recursion atomically via _beginSkillTurnIfClear (P2c fold Codex F3)', () => {
    // The recursion-refusal path is now an ATOMIC mutation
    // (single-transaction read+write) — closes the same-step
    // Promise.all race where two run_skill calls each read depth=0
    // then both write depth=1.
    expect(runSkillBody).toMatch(/_beginSkillTurnIfClear/)
    expect(runSkillBody).toMatch(/!\s*begun\.ok/)
    expect(runSkillBody).toMatch(/recursion/i)
  })

  it('run_skill validates isSkillAtomBody before running', () => {
    expect(runSkillBody).toMatch(/!\s*isSkillAtomBody\(body\)/)
  })

  it('run_skill enforces SKILL_MAX_BYTES cap by BYTE COUNT, not char count (P2c fold Codex F2)', () => {
    expect(runSkillBody).toMatch(/SKILL_MAX_BYTES/)
    // Was `body.length`; fold replaces with `skillBodyBytes(body)`.
    expect(runSkillBody).toMatch(/skillBodyBytes\(body\)/)
    expect(runSkillBody).toMatch(/bytes\s*>\s*SKILL_MAX_BYTES/)
  })

  it('run_skill writes depth=1 via the atomic _beginSkillTurnIfClear (not the two-step read-then-write)', () => {
    // P2c fold (Codex F3): the explicit _writeTurnState call is
    // GONE — the atomic mutation handles read+write in one txn.
    expect(runSkillBody).toMatch(/_beginSkillTurnIfClear/)
    // The naked _writeTurnState({depth:1}) pattern is no longer
    // present (would re-introduce the race).
    expect(runSkillBody).not.toMatch(/_writeTurnState,/)
  })

  it('run_skill returns the body so the next step sees skill instructions', () => {
    expect(runSkillBody).toMatch(/return\s+body/)
  })

  it('run_skill handles missing atom calmly (returns "not found" message)', () => {
    expect(runSkillBody).toMatch(/skill not found/i)
  })

  it('run_skill handles non-skill atom calmly (returns "not a skill" message)', () => {
    expect(runSkillBody).toMatch(/not a type:skill/i)
  })

  it('run_skill THROWS on missing threadId/promptMessageId — invariant violation, not calm result (P2c fold Codex F4)', () => {
    expect(runSkillBody).toMatch(/throw new Error\(/)
    expect(runSkillBody).toMatch(/invariant violation/i)
  })

  it('run_skill is NOT gated by requireDirectUserAuthorization (it IS the entry — gating it would defeat §2-A)', () => {
    expect(runSkillBody).not.toMatch(/requireDirectUserAuthorization\(ctx,\s*['"]run_skill['"]\)/)
  })
})

describe('Track-3 P2c — `read_atom` skill/plugin body INERT preview (§3.1)', () => {
  const readAtomBody = TOOL_BODIES['read_atom']

  it('read_atom checks isSkillAtomBody on the resolved body', () => {
    expect(readAtomBody).toMatch(/isSkillAtomBody\(body\)/)
  })

  it('read_atom checks isPluginAtomBody on the resolved body', () => {
    expect(readAtomBody).toMatch(/isPluginAtomBody\(body\)/)
  })

  it('read_atom returns INERT skill-preview shape — kind/path/label/size/command (P2c indep fold F3)', () => {
    expect(readAtomBody).toMatch(/kind:\s*['"]skill-preview['"]/)
    expect(readAtomBody).toMatch(/label:\s*pathDeriveLabel\(path\)/)
    // Size is via byte counter (P2c Codex fold F2), not body.length.
    expect(readAtomBody).toMatch(/size:\s*skillBodyBytes\(body\)/)
    // P2c indep fold F3: design-mandated `command` bool field.
    expect(readAtomBody).toMatch(/command:\s*extractSkillCommandFlag\(body\)/)
    // The hint mentions run_skill as the ONLY authorized route.
    expect(readAtomBody).toMatch(/run_skill/)
  })

  it('read_atom returns INERT plugin-preview shape — kind/path/label/size/kernel/handles (P2c indep fold F3)', () => {
    expect(readAtomBody).toMatch(/kind:\s*['"]plugin-preview['"]/)
    expect(readAtomBody).toMatch(/kernel:\s*extractPluginKernelFlag\(body\)/)
    expect(readAtomBody).toMatch(/handles:\s*extractPluginHandlesFlag\(body\)/)
  })

  it('read_atom returns the body for normal (non-skill, non-plugin) atoms', () => {
    // The fallthrough after both preview branches.
    expect(readAtomBody).toMatch(/return body/)
  })

  it('read_atom does NOT leak the body via the preview (no body.slice / no body included in JSON)', () => {
    // Search the body for any indication the body bytes are in
    // the preview JSON. The only `body.length` is allowed (size).
    const previewLines = readAtomBody
      .split('\n')
      .filter((l) =>
        /skill-preview|plugin-preview|kind:\s*['"]skill|kind:\s*['"]plugin/.test(l) ||
        /JSON\.stringify/.test(l),
      )
    // No `body:` field, no `body.slice`, no `body.substring` in
    // the preview construction.
    for (const line of previewLines) {
      expect(line).not.toMatch(/body:|body\.slice|body\.substring/)
    }
  })
})

describe('Track-3 P2c — list_skills returns label + path (for collision disambiguation)', () => {
  const listSkillsBody = TOOL_BODIES['list_skills']

  it('list_skills delegates to api.skills.list (P2c indep fold F5 — filters non-skill atoms)', () => {
    // P2c indep fold F5: list_skills now uses api.skills.list
    // which filters by isSkillAtomBody OR isLegacySkillPath —
    // non-skill atoms under skills/* (e.g. README.md) are
    // EXCLUDED from the listing so the model doesn't suggest
    // unrunnable skills to run_skill.
    expect(listSkillsBody).toMatch(/api\.skills\.list/)
  })

  it('list_skills output format: `- ${label} (${path})` for both label and canonical path', () => {
    expect(listSkillsBody).toMatch(/\$\{r\.label\}.*\$\{r\.path\}|`-\s+\$\{r\.label\}\s*\(\$\{r\.path\}\)`/)
  })
})
