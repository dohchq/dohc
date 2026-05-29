/**
 * Track-3 P3.1 — `detectSkillFire` slash-command parser tests.
 * P3+P4 indep fold F6: detectSkillFire is now EXPORTED from
 * Chat.tsx and IMPORTED here directly (kills the duplicate
 * that allowed silent prod-vs-test drift on refactor).
 */
import { describe, it, expect } from 'vitest'
import { detectCommandFire, detectSkillFire } from '../components/Chat'

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

describe('Track-3 P3.1 + P3+P4 fold — detectSkillFire (DESIGN-PINNED /skill <path> grammar)', () => {
  it('null when prompt has no leading /skill (P3+P4 indep fold F3)', () => {
    // The old `/<token>` grammar would have matched these as
    // skill-fires; the fold REVERTS to the design-pinned
    // `/skill <path>` strict grammar (skills-commands-v1 line
    // 317 SKILL_COMMAND_RE). A user typing `/help` (a near-
    // universal "chat help" idiom) no longer silently fires a
    // skill named "help"; it goes to regular chat.
    expect(detectSkillFire('/standup', skills)).toBeNull()
    expect(detectSkillFire('/help', skills)).toBeNull()
    expect(detectSkillFire('/.skills/weekly-review.md', skills)).toBeNull()
    expect(detectSkillFire('weekly-review', skills)).toBeNull()
    expect(detectSkillFire('please run weekly-review', skills)).toBeNull()
  })

  it('null when /skill has no path argument', () => {
    expect(detectSkillFire('/skill', skills)).toBeNull()
    expect(detectSkillFire('/skill ', skills)).toBeNull()
    expect(detectSkillFire('/skill   ', skills)).toBeNull()
  })

  it('null on case variation (case-sensitive `skill`)', () => {
    expect(detectSkillFire('/Skill .skills/foo.md', skills)).toBeNull()
    expect(detectSkillFire('/SKILL .skills/foo.md', skills)).toBeNull()
  })

  it('matches /skill <canonical-path>', () => {
    const r = detectSkillFire('/skill .skills/weekly-review.md', skills)
    expect(r).toEqual({
      matched: { path: '.skills/weekly-review.md', label: 'weekly-review' },
      extras: null,
    })
  })

  it('matches /skill <label> when label is unique', () => {
    const r = detectSkillFire('/skill standup', skills)
    expect(r).toEqual({
      matched: { path: '.skills/team/standup.md', label: 'standup' },
      extras: null,
    })
  })

  it('surfaces ambiguous on label collision', () => {
    const r = detectSkillFire('/skill weekly-review', skills)
    expect(r).not.toBeNull()
    expect(r).toHaveProperty('ambiguous')
    if (r && 'ambiguous' in r) {
      expect(r.ambiguous.map((s) => s.path).sort()).toEqual([
        '.skills/team/weekly-review.md',
        '.skills/weekly-review.md',
      ])
    }
  })

  it('extras AFTER the path are PRESERVED (P3+P4 indep fold F4)', () => {
    // Old behavior discarded extras silently; the fold preserves
    // them so the model sees the user's brief at step 1+ (after
    // run_skill returns the body).
    const r = detectSkillFire(
      '/skill standup with some context about today',
      skills,
    )
    expect(r).toEqual({
      matched: { path: '.skills/team/standup.md', label: 'standup' },
      extras: 'with some context about today',
    })
  })

  it('extras across multiple lines are preserved', () => {
    const r = detectSkillFire(
      '/skill standup\nLine 2.\nLine 3.',
      skills,
    )
    expect(r && 'matched' in r ? r.extras : null).toBe('Line 2.\nLine 3.')
  })

  it('null when path matches nothing', () => {
    expect(detectSkillFire('/skill nonexistent', skills)).toBeNull()
  })

  it('respects leading whitespace before /skill', () => {
    expect(detectSkillFire('  /skill standup', skills)).toEqual({
      matched: { path: '.skills/team/standup.md', label: 'standup' },
      extras: null,
    })
  })

  it('exact path wins over label-match (path is canonical)', () => {
    const colliding = [
      { path: '.skills/foo.md', label: 'foo' },
      { path: '.skills/bar.md', label: 'foo' }, // colliding label
    ]
    const r = detectSkillFire('/skill .skills/foo.md', colliding)
    expect(r).toEqual({
      matched: { path: '.skills/foo.md', label: 'foo' },
      extras: null,
    })
  })

  it('empty skills list ⇒ no match (graceful)', () => {
    expect(detectSkillFire('/skill anything', [])).toBeNull()
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
