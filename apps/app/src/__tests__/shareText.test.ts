import { describe, it, expect } from 'vitest'
import { buildShareText, extractShareProvenance } from '../lib/shareText'
import { extractFrontmatterId, isSkillAtomBody } from '../lib/atomId'

// Track-3 P4 — share = COPY (skills-commands-v1 §2-B + §7 P4).
// Sharing is byte-transfer of an atom body with `id:` stripped
// (Track-1 seeds a fresh id on the recipient's first write) and
// `source-share: <handle>/<sender-id>` advisory provenance.
//
// These tests are PURE-LOGIC over the buildShareText helper.
// The UI button (ShareSkillButton in AtomView.tsx) is a thin
// shell over this helper + navigator.clipboard.

const SENDER = 'user_01ALICE'
const RECIPIENT = 'user_02BOB'

describe('Track-3 P4 — buildShareText', () => {
  it('strips the id: line from frontmatter', () => {
    const body =
      '---\ntype: skill\nid: abc123\n---\nDo the weekly review.\n'
    const share = buildShareText(body, SENDER)
    expect(extractFrontmatterId(share)).toBeNull()
  })

  it('preserves type: skill after stripping the id (recipient run_skill still works)', () => {
    const body =
      '---\ntype: skill\nid: abc123\n---\nDo the weekly review.\n'
    const share = buildShareText(body, SENDER)
    expect(isSkillAtomBody(share)).toBe(true)
  })

  it('injects source-share: <handle>/<sender-id> AFTER the type line', () => {
    const body =
      '---\ntype: skill\nid: abc123\n---\nDo the thing.\n'
    const share = buildShareText(body, SENDER)
    const prov = extractShareProvenance(share)
    expect(prov).toEqual({ handle: SENDER, senderId: 'abc123' })
    // Verify the type:skill is STILL the first non-fence line
    // (isSkillAtomBody's grammar relies on this).
    expect(share).toMatch(/^---\ntype: skill\nsource-share:/)
  })

  it('round-trip: recipient pasting the share text gets a fresh-seeded skill atom (no id, has source-share)', () => {
    const original =
      '---\ntype: skill\nid: alice123\nname: "weekly review"\n---\n# Weekly Review\nStep 1...\n'
    const share = buildShareText(original, SENDER)
    // Recipient's vault will see this body on paste:
    expect(extractFrontmatterId(share)).toBeNull() // Track-1 will SEED a fresh id
    expect(isSkillAtomBody(share)).toBe(true) // run_skill will accept it
    // Provenance preserved:
    expect(extractShareProvenance(share)).toEqual({
      handle: SENDER,
      senderId: 'alice123',
    })
    // The body content (everything after the second ---) survives.
    expect(share).toContain('# Weekly Review')
    expect(share).toContain('Step 1...')
  })

  it('no-id source ⇒ no source-share line emitted (defensive: would otherwise emit malformed)', () => {
    const body = '---\ntype: skill\n---\nbody.\n'
    const share = buildShareText(body, SENDER)
    expect(extractShareProvenance(share)).toBeNull()
    expect(share).not.toMatch(/source-share/)
    // Body still type:skill ⇒ recipient can run it (Track-1 seeds id).
    expect(isSkillAtomBody(share)).toBe(true)
  })

  it('no-frontmatter source ⇒ returns body unchanged (can\'t carry id)', () => {
    const body = '# Just a markdown note\nno frontmatter here.\n'
    const share = buildShareText(body, SENDER)
    expect(share).toBe(body)
  })

  it('preserves non-id frontmatter fields (name, description) — they are owner-authored prose', () => {
    const body =
      '---\ntype: skill\nid: x1\nname: "My Skill"\ndescription: "A useful process."\n---\nBody.\n'
    const share = buildShareText(body, SENDER)
    expect(share).toContain('name: "My Skill"')
    expect(share).toContain('description: "A useful process."')
  })

  it('blank handle ⇒ no source-share line (provenance is opt-in)', () => {
    const body = '---\ntype: skill\nid: x1\n---\nx\n'
    expect(extractShareProvenance(buildShareText(body, ''))).toBeNull()
    expect(extractShareProvenance(buildShareText(body, '   '))).toBeNull()
  })

  it('whitespace around handle is trimmed (no `source-share:   abc  /id`)', () => {
    const body = '---\ntype: skill\nid: x1\n---\nx\n'
    const share = buildShareText(body, '  user_TRIMMED  ')
    expect(share).toContain('source-share: user_TRIMMED/x1')
    expect(share).not.toContain('  user_TRIMMED  ')
  })

  it('frontmatter without type: places source-share at the TOP', () => {
    const body =
      '---\nname: "older format"\nid: old1\n---\nThe body.\n'
    const share = buildShareText(body, SENDER)
    // No type: line, so source-share goes to the top of the fm.
    expect(share).toMatch(/^---\nsource-share:/)
  })

  it('multiple id: lines (malformed) — only matches the first; rest pass through', () => {
    // The id-line regex is strict (id: <token>); only the well-
    // formed first id is extracted and stripped. A malformed
    // duplicate would not match the regex.
    const body =
      '---\ntype: skill\nid: real-id\n---\nBody with embedded id: "fake".\n'
    const share = buildShareText(body, SENDER)
    expect(extractFrontmatterId(share)).toBeNull()
    expect(extractShareProvenance(share)).toEqual({
      handle: SENDER,
      senderId: 'real-id',
    })
    expect(share).toContain('id: "fake"') // body content untouched
  })

  // P3+P4 Codex fold F1: id grammar parity with extractFrontmatterId.
  it('strips DOTTED ids (e.g. weekly-review.q3) — design example, prior regex missed it', () => {
    const body =
      '---\ntype: skill\nid: weekly-review.q3\n---\nThe quarterly review.\n'
    const share = buildShareText(body, SENDER)
    expect(extractFrontmatterId(share)).toBeNull() // strip succeeds
    expect(extractShareProvenance(share)).toEqual({
      handle: SENDER,
      senderId: 'weekly-review.q3',
    })
  })

  // P3+P4 indep fold F1: the CANONICAL id form produced by
  // `normalizeFileId(path)` is dot-joined path segments
  // (e.g. `skills/team/standup.md` ⇒ `skills.team.standup`).
  // Every real skill at a sub-path has this shape; the prior
  // [A-Za-z0-9_-]+ regex missed all of them.
  it('strips CANONICAL dot-joined ids (skills.team.standup) — every real-world sub-path skill', () => {
    const body =
      '---\ntype: skill\nid: skills.team.standup\n---\nDaily standup process.\n'
    const share = buildShareText(body, SENDER)
    expect(extractFrontmatterId(share)).toBeNull()
    expect(extractShareProvenance(share)).toEqual({
      handle: SENDER,
      senderId: 'skills.team.standup',
    })
    // Round-trip: type:skill still classifies; body preserved.
    expect(isSkillAtomBody(share)).toBe(true)
    expect(share).toContain('Daily standup process.')
  })

  it('strips QUOTED ids (single and double)', () => {
    const single =
      '---\ntype: skill\nid: \'fancy.id-1\'\n---\nbody\n'
    const double =
      '---\ntype: skill\nid: "fancy.id-2"\n---\nbody\n'
    expect(extractFrontmatterId(buildShareText(single, SENDER))).toBeNull()
    expect(extractFrontmatterId(buildShareText(double, SENDER))).toBeNull()
    // Provenance carries the unquoted value.
    expect(extractShareProvenance(buildShareText(single, SENDER))?.senderId).toBe(
      'fancy.id-1',
    )
    expect(extractShareProvenance(buildShareText(double, SENDER))?.senderId).toBe(
      'fancy.id-2',
    )
  })

  // P3+P4 Codex fold F4: re-share idempotence.
  it('re-share REPLACES the existing source-share line, never chains (Codex fold F4)', () => {
    // Step 1: alice shares an atom to bob.
    const original = '---\ntype: skill\nid: alice-id\n---\nThe skill.\n'
    const aliceShare = buildShareText(original, 'alice_handle')
    expect(extractShareProvenance(aliceShare)).toEqual({
      handle: 'alice_handle',
      senderId: 'alice-id',
    })

    // Step 2: bob pastes, saves to his vault. Track-1 seeds a
    // fresh id; the source-share line is preserved as advisory.
    // Now bob re-shares to charlie. Simulate by injecting a
    // new id (what _upsertInternal would do on bob's save).
    const bobSaved = aliceShare.replace(
      /^---\n/,
      '---\nid: bob-new-id\n',
    )
    // Confirm bob's vault has: type:skill, id:bob-new-id, source-
    // share:alice_handle/alice-id (preserved from import).
    expect(extractFrontmatterId(bobSaved)).toBe('bob-new-id')
    expect(extractShareProvenance(bobSaved)).toEqual({
      handle: 'alice_handle',
      senderId: 'alice-id',
    })

    // Step 3: bob re-shares to charlie.
    const bobShare = buildShareText(bobSaved, 'bob_handle')
    // Bob's new id stripped:
    expect(extractFrontmatterId(bobShare)).toBeNull()
    // ONLY ONE source-share line — and it's bob's (REPLACES alice's):
    expect(extractShareProvenance(bobShare)).toEqual({
      handle: 'bob_handle',
      senderId: 'bob-new-id',
    })
    const sourceShareLineCount =
      bobShare.split('\n').filter((l) => /^source-share:/.test(l))
        .length
    expect(sourceShareLineCount).toBe(1)
    // Alice's identity does NOT appear:
    expect(bobShare).not.toContain('alice_handle')
    expect(bobShare).not.toContain('alice-id')
  })

  // P3+P4 Codex fold F5: defensive slash-stripping in the handle.
  it('handle with `/` is sanitized to `_` (defensive — extractShareProvenance anchors on /)', () => {
    const body = '---\ntype: skill\nid: x1\n---\nbody\n'
    const share = buildShareText(body, 'tenant/user_01')
    // The `/` in the handle would otherwise make
    // extractShareProvenance's parse ambiguous (anchors on the
    // first /). Sanitize to `_`.
    const prov = extractShareProvenance(share)
    expect(prov?.handle).toBe('tenant_user_01') // no /
    expect(prov?.senderId).toBe('x1')
  })

  it('CRLF line endings tolerated on input (returns LF-normalized output)', () => {
    const body = '---\r\ntype: skill\r\nid: x1\r\n---\r\nbody\r\n'
    const share = buildShareText(body, SENDER)
    expect(isSkillAtomBody(share)).toBe(true)
    expect(extractShareProvenance(share)?.senderId).toBe('x1')
  })
})

describe('Track-3 P4 — extractShareProvenance (reverse-direction helper)', () => {
  it('returns null when no source-share line exists', () => {
    expect(
      extractShareProvenance('---\ntype: skill\n---\nbody'),
    ).toBeNull()
    expect(extractShareProvenance('# plain markdown')).toBeNull()
  })

  it('parses a valid source-share line', () => {
    const body =
      '---\ntype: skill\nsource-share: ' + RECIPIENT + '/sender123\n---\nbody'
    expect(extractShareProvenance(body)).toEqual({
      handle: RECIPIENT,
      senderId: 'sender123',
    })
  })

  it('tolerates quoted form', () => {
    const body =
      '---\ntype: skill\nsource-share: "' + RECIPIENT + '/abc"\n---\nbody'
    expect(extractShareProvenance(body)).toEqual({
      handle: RECIPIENT,
      senderId: 'abc',
    })
  })

  it('round-trip with buildShareText', () => {
    const original =
      '---\ntype: skill\nid: round-trip-id\n---\noriginal.\n'
    const share = buildShareText(original, SENDER)
    const prov = extractShareProvenance(share)
    expect(prov).toEqual({ handle: SENDER, senderId: 'round-trip-id' })
  })
})
