import { describe, it, expect } from 'vitest'
import { classifyAction, requiresConfirmation } from './confirmTier'
import type { CaptureAction } from './confirmTier'

const a = (p: Partial<CaptureAction>): CaptureAction => ({
  kind: 'create',
  target: 'atom',
  ...p,
})

describe('confirm tiers — no-tax path', () => {
  it('private agent-authored create is SILENT (zero interruption)', () => {
    expect(classifyAction(a({ kind: 'create', target: 'atom' }))).toBe('silent')
    expect(classifyAction(a({ kind: 'create', target: 'entity' }))).toBe('silent')
    expect(requiresConfirmation(a({ kind: 'create' }))).toBe(false)
  })
  it('overwrite of agent-authored content is NOT blocking', () => {
    expect(
      classifyAction(a({ kind: 'overwrite', overwritesUserContent: false })),
    ).toBe('silent')
  })
})

describe('confirm tiers — graduated friction', () => {
  it('shared → DIGEST (batched share review, never blocks work)', () => {
    expect(classifyAction(a({ kind: 'create', shared: true }))).toBe('digest')
  })
  it('unsure → INLINE nudge', () => {
    expect(classifyAction(a({ kind: 'create', unsure: true }))).toBe('inline')
  })
  it('destructive beats shared/unsure (precedence)', () => {
    expect(
      classifyAction(a({ kind: 'delete', shared: true, unsure: true })),
    ).toBe('blocking')
  })
})

describe('confirm tiers — destructive is BLOCKING (security)', () => {
  it('any delete is blocking', () => {
    for (const target of ['atom', 'entity', 'folder'] as const) {
      expect(classifyAction(a({ kind: 'delete', target }))).toBe('blocking')
      expect(requiresConfirmation(a({ kind: 'delete', target }))).toBe(true)
    }
  })
  it('overwrite of USER-authored content is blocking', () => {
    expect(
      classifyAction(a({ kind: 'overwrite', overwritesUserContent: true })),
    ).toBe('blocking')
  })
  it('PROMPT-INJECTION mitigation: destructive from an untrusted artifact is ALWAYS blocking', () => {
    expect(
      classifyAction(
        a({ kind: 'delete', target: 'folder', fromUntrustedArtifact: true }),
      ),
    ).toBe('blocking')
    expect(
      classifyAction(
        a({ kind: 'overwrite', fromUntrustedArtifact: true, overwritesUserContent: false }),
      ),
    ).toBe('blocking')
    // a benign create from an artifact is still fine (no false friction)
    expect(
      classifyAction(a({ kind: 'create', fromUntrustedArtifact: true })),
    ).toBe('silent')
  })
})
