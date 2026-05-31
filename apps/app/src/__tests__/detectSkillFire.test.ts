/**
 * Track-3 P3.1 — `detectSkillFire` slash-command parser tests.
 * P3+P4 indep fold F6: detectSkillFire is now EXPORTED from
 * Chat.tsx and IMPORTED here directly (kills the duplicate
 * that allowed silent prod-vs-test drift on refactor).
 */
import { describe, it, expect } from 'vitest'
import {
  composerTokenForRunnable,
  detectCommandFire,
  detectComposerTrigger,
  detectSkillFire,
  replaceTextRange,
} from '../components/Chat'

const skills = [
  { path: '.skills/weekly-review.md', label: 'weekly-review' },
  { path: '.skills/team/standup.md', label: 'standup' },
  { path: '.skills/team/weekly-review.md', label: 'weekly-review' }, // collision
] as const

const commands = [
  { path: '.commands/draft-invoice.md', label: 'draft-invoice' },
  { path: '.commands/team/hours.md', label: 'hours' },
  { path: '.commands/client/hours.md', label: 'hours' },
] as const

describe('T3-style composer triggers', () => {
  it('detects /command only at the start of the current line', () => {
    expect(detectComposerTrigger('/dra', 4)).toEqual({
      kind: 'command',
      query: 'dra',
      rangeStart: 0,
      rangeEnd: 4,
    })
    expect(detectComposerTrigger('Please run /dra', 'Please run /dra'.length)).toBeNull()
  })

  it('detects $skill at the cursor as an inline token', () => {
    const text = 'Use $stand'
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: 'skill',
      query: 'stand',
      rangeStart: 'Use '.length,
      rangeEnd: text.length,
    })
  })

  it('replaces a composer trigger with a trailing-space token', () => {
    expect(replaceTextRange('Use $sta today', 4, 8, '$standup ')).toEqual({
      text: 'Use $standup today',
      cursor: 'Use $standup '.length,
    })
  })

  it('uses canonical paths for duplicate labels selected from the menu', () => {
    expect(
      composerTokenForRunnable(
        'skill',
        { path: '.skills/team/weekly-review.md', label: 'weekly-review' },
        skills,
      ),
    ).toBe('.skills/team/weekly-review.md')
    expect(
      composerTokenForRunnable(
        'command',
        { path: '.commands/draft-invoice.md', label: 'draft-invoice' },
        commands,
      ),
    ).toBe('draft-invoice')
  })

  it('returns null when cursor is at position 0 with no trigger character', () => {
    expect(detectComposerTrigger('hello world', 0)).toBeNull()
  })

  it('detects /command with cursor at exact end of command text', () => {
    const text = '/invoice'
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: 'command',
      query: 'invoice',
      rangeStart: 0,
      rangeEnd: text.length,
    })
  })

  it('detects $ at start of text as a skill trigger', () => {
    const text = '$standup'
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: 'skill',
      query: 'standup',
      rangeStart: 0,
      rangeEnd: text.length,
    })
  })

  it('clamps cursor beyond text length to text length', () => {
    const text = '/cmd'
    // cursor beyond length should be treated the same as at-end
    expect(detectComposerTrigger(text, 9999)).toEqual({
      kind: 'command',
      query: 'cmd',
      rangeStart: 0,
      rangeEnd: text.length,
    })
  })

  it('detects /command on second line when cursor is on that line', () => {
    const text = 'Some context\n/weekly'
    const cursor = text.length
    expect(detectComposerTrigger(text, cursor)).toEqual({
      kind: 'command',
      query: 'weekly',
      rangeStart: 'Some context\n'.length,
      rangeEnd: cursor,
    })
  })

  it('replaceTextRange handles out-of-bounds rangeStart by clamping to 0', () => {
    const result = replaceTextRange('hello', -5, 2, 'X')
    expect(result.text).toBe('Xllo')
    expect(result.cursor).toBe(1)
  })

  it('replaceTextRange inserts at the end when rangeStart equals text length', () => {
    const result = replaceTextRange('hello', 5, 5, ' world')
    expect(result.text).toBe('hello world')
    expect(result.cursor).toBe(11)
  })

  it('composerTokenForRunnable uses label when it is unique in the list', () => {
    const singleSkill = [{ path: '.skills/standup.md', label: 'standup' }]
    expect(
      composerTokenForRunnable('skill', singleSkill[0], singleSkill),
    ).toBe('standup')
  })

  it('composerTokenForRunnable uses path when same label appears more than once', () => {
    const colliding = [
      { path: '.skills/a/standup.md', label: 'standup' },
      { path: '.skills/b/standup.md', label: 'standup' },
    ]
    expect(
      composerTokenForRunnable('skill', colliding[0], colliding),
    ).toBe('.skills/a/standup.md')
  })
})

describe('Skills — detectSkillFire ($skill grammar, T3-style)', () => {

    expect(detectSkillFire('/standup', skills)).toBeNull()
    expect(detectSkillFire('/help', skills)).toBeNull()
    expect(detectSkillFire('/.skills/weekly-review.md', skills)).toBeNull()
    expect(detectSkillFire('please run weekly-review', skills)).toBeNull()
  })

  it('null when $ has no skill token', () => {
    expect(detectSkillFire('$', skills)).toBeNull()
    expect(detectSkillFire('Use $ ', skills)).toBeNull()
  })

  it('matches $<canonical-path>', () => {
    const r = detectSkillFire('$.skills/weekly-review.md', skills)
    expect(r).toEqual({
      matched: { path: '.skills/weekly-review.md', label: 'weekly-review' },
      extras: '$.skills/weekly-review.md',
    })
  })

  it('matches $<label> when label is unique', () => {
    const r = detectSkillFire('$standup', skills)
    expect(r).toEqual({
      matched: { path: '.skills/team/standup.md', label: 'standup' },
      extras: '$standup',
    })
  })

  it('surfaces ambiguous on label collision', () => {
    const r = detectSkillFire('$weekly-review', skills)
    expect(r).not.toBeNull()
    expect(r).toHaveProperty('ambiguous')
    if (r && 'ambiguous' in r) {
      expect(r.ambiguous.map((s) => s.path).sort()).toEqual([
        '.skills/team/weekly-review.md',
        '.skills/weekly-review.md',
      ])
    }
  })

  it('preserves the full prompt as extras so inline skill use keeps user context', () => {
    const r = detectSkillFire(
      'Use $standup with some context about today',
      skills,
    )
    expect(r).toEqual({
      matched: { path: '.skills/team/standup.md', label: 'standup' },
      extras: 'Use $standup with some context about today',
    })
  })

  it('extras across multiple lines are preserved', () => {
    const r = detectSkillFire(
      '$standup\nLine 2.\nLine 3.',
      skills,
    )
    expect(r && 'matched' in r ? r.extras : null).toBe('$standup\nLine 2.\nLine 3.')
  })

  it('null when path matches nothing', () => {
    expect(detectSkillFire('$nonexistent', skills)).toBeNull()
  })

  it('exact path wins over label-match (path is canonical)', () => {
    const colliding = [
      { path: '.skills/foo.md', label: 'foo' },
      { path: '.skills/bar.md', label: 'foo' }, // colliding label
    ]
    const r = detectSkillFire('$.skills/foo.md', colliding)
    expect(r).toEqual({
      matched: { path: '.skills/foo.md', label: 'foo' },
      extras: '$.skills/foo.md',
    })
  })

  it('empty skills list ⇒ no match (graceful)', () => {
    expect(detectSkillFire('$anything', [])).toBeNull()
  })
})

describe('Commands — detectCommandFire (/<command> grammar)', () => {
  it('matches a canonical .commands path', () => {
    expect(detectCommandFire('/.commands/draft-invoice.md', commands)).toEqual({
      matched: { path: '.commands/draft-invoice.md', label: 'draft-invoice' },
      extras: null,
    })
  })

  it('matches a unique command label and preserves extras', () => {
    expect(
      detectCommandFire('/draft-invoice for Acme this week', commands),
    ).toEqual({
      matched: { path: '.commands/draft-invoice.md', label: 'draft-invoice' },
      extras: 'for Acme this week',
    })
  })

  it('respects leading whitespace before a command fire', () => {
    expect(detectCommandFire('  /draft-invoice for Acme', commands)).toEqual({
      matched: { path: '.commands/draft-invoice.md', label: 'draft-invoice' },
      extras: 'for Acme',
    })
  })

  it('does not treat /skill as a command', () => {
    expect(detectCommandFire('/skill .skills/foo.md', commands)).toBeNull()
  })

  it('surfaces ambiguous label collisions', () => {
    const r = detectCommandFire('/hours', commands)
    expect(r).not.toBeNull()
    expect(r).toHaveProperty('ambiguous')
    if (r && 'ambiguous' in r) {
      expect(r.ambiguous.map((c) => c.path).sort()).toEqual([
        '.commands/client/hours.md',
        '.commands/team/hours.md',
      ])
    }
  })
})
