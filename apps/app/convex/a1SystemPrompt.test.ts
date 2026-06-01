/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSystemPrompt } from './agent'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AGENT_SRC = readFileSync(resolve(__dirname, 'agent.ts'), 'utf8')

// A1 (multiplayer-and-h-followups §4) — workspace-kind-aware
// system prompt. Personal callers get SYSTEM_PROMPT verbatim (the
// v0 behavior); org callers get ORG_PREAMBLE prepended PLUS a
// `.context/me.md` → `.context/company.md` substitution so the agent's
// write_atom calls land at `.context/company.md` in an org workspace.
//
// These tests lock the contract that (a) personal is byte-identical,
// (b) org includes the preamble + org name + substitution, (c) the
// substitution catches every `.context/me.md` reference Jenny's H-1 audit found.

describe('buildSystemPrompt (H-1 / A1)', () => {
  it('personal kind returns the SYSTEM_PROMPT verbatim — zero regression risk', () => {
    const personal = buildSystemPrompt({ kind: 'personal' })
    // Sanity: it contains the personal-only literal phrases.
    expect(personal).toContain("ONE user's workspace")
    expect(personal).toContain('.context/me.md')
    expect(personal).toContain('the vault')
    // NO org preamble in personal output.
    expect(personal).not.toContain('ORG WORKSPACE CONTEXT')
    expect(personal).not.toContain('.context/company.md')
  })

  it('org kind prepends ORG WORKSPACE CONTEXT with the org name', () => {
    const org = buildSystemPrompt({ kind: 'org', orgName: 'Acme Inc' })
    expect(org).toMatch(/^## ORG WORKSPACE CONTEXT/)
    expect(org).toContain('Acme Inc')
    expect(org).toContain('You are operating in the **Acme Inc** team workspace')
  })

  it('org kind substitutes EVERY .context/me.md literal in the BODY → .context/company.md (Jenny H-1 audit)', () => {
    const org = buildSystemPrompt({ kind: 'org', orgName: 'Acme' })
    // The preamble itself references `.context/me.md` literally (explaining the
    // substitution to the model). The substitution-correctness check
    // here is: in the BODY (everything after the preamble divider
    // `---\n\n`), `.context/me.md` should not appear at all — every
    // reference should be `.context/company.md`.
    const bodyStart = org.indexOf('\n---\n\n')
    expect(bodyStart).toBeGreaterThan(0)
    const body = org.slice(bodyStart)
    expect(body).not.toContain('.context/me.md')
    // .context/company.md appears multiple times in the body.
    const countCompany = (body.match(/\.context\/company\.md/g) ?? []).length
    expect(countCompany).toBeGreaterThanOrEqual(4)
  })

  it('falls back to "this team" when orgName is missing/empty', () => {
    expect(
      buildSystemPrompt({ kind: 'org' }),
    ).toContain('You are operating in the **this team** team workspace')
    expect(
      buildSystemPrompt({ kind: 'org', orgName: '   ' }),
    ).toContain('You are operating in the **this team** team workspace')
  })

  it('preamble framing tells the model to read possessives + identity for the team', () => {
    const org = buildSystemPrompt({ kind: 'org', orgName: 'Acme' })
    expect(org).toMatch(/identity atom is `\.context\/company\.md`/)
    expect(org).toMatch(/the team's|the Acme workspace/)
    expect(org).toMatch(/starter setup.*for the TEAM/i)
    expect(org).toMatch(/Skills are Owner-only/i)
  })

  it('org and personal share the same body length except for preamble + substitution', () => {
    const personal = buildSystemPrompt({ kind: 'personal' })
    const org = buildSystemPrompt({ kind: 'org', orgName: 'Acme' })
    // Org should be longer than personal (the preamble adds ~50 lines).
    expect(org.length).toBeGreaterThan(personal.length)
    // But the body after the preamble (org-version) should be roughly
    // personal-length + the substitution delta (.context/me.md →
    // .context/company.md is 5 chars longer per occurrence × 5+
    // occurrences = ~25-50 extra chars).
    const bodyDelta = org.length - personal.length
    // ~2000-3000 chars for the preamble; +50ish for substitutions.
    expect(bodyDelta).toBeGreaterThan(500)
    expect(bodyDelta).toBeLessThan(5000)
  })

  it('tool metadata describes both personal and org identity paths', () => {
    expect(AGENT_SRC).toContain('.context/me.md in personal')
    expect(AGENT_SRC).toContain('.context/company.md in org')
    expect(AGENT_SRC).toContain('"lock .context/company.md"')
  })

  it('teaches the current dohc system model before task execution', () => {
    const personal = buildSystemPrompt({ kind: 'personal' })
    expect(personal).toContain('## CURRENT DOHC SYSTEM MAP')
    expect(personal).toContain('AI-native workspace, not a note-taking app')
    expect(personal).toContain('Agent is the primary work surface')
    expect(personal).toContain('not every folder is a project')
    expect(personal).toContain('project-scoped or no-project')
    expect(personal).toContain('Markdown atoms are the inspectable source')
    expect(personal).toContain('HTML atoms are polished presentation views')
    expect(personal).toContain('.views/ is the convention for folder-local custom views')
    expect(personal).toContain('View source code is normal web code')
    expect(personal).toContain('Use TypeScript/React by default')
    expect(personal).toContain('Source data lives outside .views')
    expect(personal).toContain('Do not store canonical user/work state in view-local JS state')
    expect(personal).toContain('Use {} live values, entities, imports/exports, and atoms as the substrate')
    expect(personal).toContain('imports/exports remain the only')
    expect(personal).toContain('cross-workspace data path')
    expect(personal).toContain('View actions must hand off to Agent or proposed patches for user review')
    expect(personal).toContain('they do not silently raw-patch canonical markdown/Y.Doc state')
    expect(personal).toContain('build source first, view second')
    expect(personal).toContain('show what changed, what is known, what is missing')
    expect(personal).toContain('respect locks, sharing boundaries, capture review, skill-turn gates, and review gates')
  })
})
