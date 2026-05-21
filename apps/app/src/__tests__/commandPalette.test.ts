import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Track-3 P3.2 — STRUCTURAL coverage of the CommandPalette's
// skill integration. Component-level behavioral tests would need
// @testing-library/react + jsdom (not currently configured); the
// SLASH-fire INTEGRATION CHAIN — Palette → onFirePrompt('/<path>')
// → Chat.submit() → detectSkillFire → sendMessage({entry:'skill-
// fire'}) → prepareStep BRACE — is BEHAVIORALLY unit-tested at
// every other layer (detectSkillFire 10 tests; sendMessage 5
// tests; prepareStep 9 tests). This file locks the palette's
// WIRING: skills consulted, slash-prefix prepended, kind tag set.

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(
  resolve(__dirname, '../../src/components/CommandPalette.tsx'),
  'utf8',
)

describe('Track-3 P3.2 — CommandPalette wires skills via api.skills.list', () => {
  it('imports api.skills.list', () => {
    expect(SRC).toMatch(
      /import\s+\{[^}]*useQuery[^}]*\}\s+from\s+['"]convex\/react['"]/,
    )
    expect(SRC).toMatch(/import\s+\{[^}]*api[^}]*\}\s+from\s+['"]\.\.\/\.\.\/convex\/_generated\/api['"]/)
  })

  it('subscribes to api.skills.list', () => {
    expect(SRC).toMatch(/useQuery\(api\.skills\.list\)/)
  })

  it('iterates skills and pushes a Command per skill', () => {
    expect(SRC).toMatch(/for\s*\(const\s+s\s+of\s+skills\)/)
    expect(SRC).toMatch(/id:\s*`skill\.\$\{s\.path\}`/)
    expect(SRC).toMatch(/title:\s*s\.label/)
  })

  it('skill commands fire via the DEDICATED onFireSkill channel (Codex fold F3 — no longer onFirePrompt)', () => {
    // P3+P4 Codex fold F3: a plugin command's prompt text could
    // start with `/<path>` and trigger Chat's detectSkillFire,
    // silently upgrading a generic-fire into a skill-fire. The
    // fix: skill rows call a SEPARATE callback (onFireSkill);
    // plugin commands keep onFirePrompt. The two channels never
    // cross.
    expect(SRC).toMatch(/onFireSkill\(s\.path\)/)
    // The OLD onFirePrompt(`/${s.path}`) chain MUST NOT exist
    // anymore — that would be a regression.
    expect(SRC).not.toMatch(/onFirePrompt\(`\/\$\{s\.path\}`\)/)
  })

  it('plugin commands still use onFirePrompt (channels are mutually exclusive)', () => {
    // Plugin commands' .run() blocks call onFirePrompt(c.prompt)
    // — same as before P3+P4 fold. Verify that surface
    // unchanged so the fold's channel-separation claim holds
    // bidirectionally.
    expect(SRC).toMatch(/onFirePrompt\(c\.prompt\)/)
  })

  it('skill commands tag kind:"skill" for the Sparkles icon', () => {
    expect(SRC).toMatch(/kind:\s*['"]skill['"]/)
  })

  it('renders Sparkles icon ONLY for kind="skill" rows', () => {
    expect(SRC).toMatch(/c\.kind\s*===\s*['"]skill['"]/)
    expect(SRC).toMatch(/<Sparkles/)
  })

  it('skills are listed BEFORE plugin commands (most-relevant first)', () => {
    const skillBlock = SRC.indexOf('for (const s of skills)')
    const pluginBlock = SRC.indexOf('for (const p of plugins)')
    expect(skillBlock).toBeGreaterThan(0)
    expect(pluginBlock).toBeGreaterThan(0)
    expect(skillBlock).toBeLessThan(pluginBlock)
  })

  it('skills are reactive — useMemo dep array includes skills', () => {
    // Without this, a newly-saved skill would not appear until
    // some other dep changed. After P3+P4 fold the deps were
    // reformatted to multiline; the test pins by token, not
    // by inline-comma layout.
    expect(SRC).toMatch(/useMemo\([\s\S]*?\[[\s\S]*?\bskills\b[\s\S]*?\bplugins\b[\s\S]*?\benabled\b/)
  })

  it('skill hint format is `skill · ${path}` (matches the design canonical-id discipline)', () => {
    expect(SRC).toMatch(/hint:\s*`skill\s*·\s*\$\{s\.path\}`/)
  })

  it('skill commands close the palette before firing (UX consistency with plugin commands)', () => {
    // Search for the skill's run() body specifically; it must
    // call onClose() before onFireSkill() so the palette isn't
    // visible during the chat-roundtrip.
    const skillBlock = SRC.slice(
      SRC.indexOf('for (const s of skills)'),
      SRC.indexOf('for (const p of plugins)'),
    )
    const closeIdx = skillBlock.indexOf('onClose()')
    const fireIdx = skillBlock.indexOf('onFireSkill(')
    expect(closeIdx).toBeGreaterThan(0)
    expect(fireIdx).toBeGreaterThan(0)
    expect(closeIdx).toBeLessThan(fireIdx)
  })

  // P3+P4 Codex fold F2: palette dispatches MUST open chat and
  // close competing panels — without it, Chat is unmounted when
  // the user fires from the palette while chat is hidden, and
  // the stale pendingPrompt replays later on remount.
  it('palette callbacks in _app.tsx open chat + close other panels (Codex fold F2)', () => {
    const indexSrc = readFileSync(
      resolve(__dirname, '../../src/routes/_app.tsx'),
      'utf8',
    )
    // Slice from <CommandPalette to its closing `/>` — JSX
    // self-closing tag.
    const start = indexSrc.indexOf('<CommandPalette')
    expect(start).toBeGreaterThan(0)
    const end = indexSrc.indexOf('/>', start)
    const paletteBlock = indexSrc.slice(start, end + 2)
    // Both onFirePrompt and onFireSkill at the palette callsite
    // must call setChatOpen(true) (the route-level state setter
    // for the chat panel visibility).
    expect(paletteBlock).toMatch(/onFirePrompt=\{[\s\S]+?setChatOpen\(true\)/)
    expect(paletteBlock).toMatch(/onFireSkill=\{[\s\S]+?setChatOpen\(true\)/)
    // pendingSkillFire is set on the dedicated channel:
    expect(paletteBlock).toMatch(/setPendingSkillFire\(path\)/)
  })
})
