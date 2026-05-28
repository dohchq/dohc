/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from './agent'

// A1 (multiplayer-and-h-followups §4) — workspace-kind-aware
// system prompt. Personal callers get SYSTEM_PROMPT verbatim (the
// v0 behavior); org callers get ORG_PREAMBLE prepended PLUS a
// `me.md` → `company.md` substitution so the agent's write_atom
// calls land at company.md in an org workspace.
//
// These tests lock the contract that (a) personal is byte-identical,
// (b) org includes the preamble + org name + substitution, (c) the
// substitution catches every me.md reference Jenny's H-1 audit found.

describe('buildSystemPrompt (H-1 / A1)', () => {
  it('personal kind returns the SYSTEM_PROMPT verbatim — zero regression risk', () => {
    const personal = buildSystemPrompt({ kind: 'personal' })
    // Sanity: it contains the personal-only literal phrases.
    expect(personal).toContain("ONE user's workspace")
    expect(personal).toContain('me.md')
    expect(personal).toContain('the vault')
    // NO org preamble in personal output.
    expect(personal).not.toContain('ORG WORKSPACE CONTEXT')
    expect(personal).not.toContain('company.md')
  })

  it('org kind prepends ORG WORKSPACE CONTEXT with the org name', () => {
    const org = buildSystemPrompt({ kind: 'org', orgName: 'Acme Inc' })
    expect(org).toMatch(/^## ORG WORKSPACE CONTEXT/)
    expect(org).toContain('Acme Inc')
    expect(org).toContain('You are operating in the **Acme Inc** team workspace')
  })

  it('org kind substitutes EVERY me.md literal in the BODY → company.md (Jenny H-1 audit)', () => {
    const org = buildSystemPrompt({ kind: 'org', orgName: 'Acme' })
    // The preamble itself references `me.md` literally (explaining the
    // substitution to the model). The substitution-correctness check
    // here is: in the BODY (everything after the preamble divider
    // `---\n\n`), `me.md` should not appear at all — every reference
    // should be `company.md`.
    const bodyStart = org.indexOf('\n---\n\n')
    expect(bodyStart).toBeGreaterThan(0)
    const body = org.slice(bodyStart)
    expect(body).not.toContain('me.md')
    // company.md appears multiple times in the body. Actual count of
    // `me.md` references in the original SYSTEM_PROMPT body is 4 (lines
    // covering: vault-must-contain, identity-atom-definition, show-back-
    // line, finish-onboarding-precondition). Jenny's "5+" audit included
    // tool descriptions, which now also live in this prompt body.
    const countCompany = (body.match(/company\.md/g) ?? []).length
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
    expect(org).toMatch(/identity atom is `company\.md`/)
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
    // personal-length + the substitution delta (me.md → company.md is
    // 5 chars longer per occurrence × 5+ occurrences = ~25-50 extra chars).
    const bodyDelta = org.length - personal.length
    // ~2000-3000 chars for the preamble; +50ish for substitutions.
    expect(bodyDelta).toBeGreaterThan(500)
    expect(bodyDelta).toBeLessThan(5000)
  })
})
