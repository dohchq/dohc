import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ONBOARDING_SRC = readFileSync(
  resolve(__dirname, '../../src/components/Onboarding.tsx'),
  'utf8',
)
const AGENT_SRC = readFileSync(
  resolve(__dirname, '../../convex/agent.ts'),
  'utf8',
)

describe('setup-first onboarding wedge', () => {
  it('opens by asking what dohc should set up, not what job the user has', () => {
    expect(ONBOARDING_SRC).toContain('What should dohc set up for you first?')
    expect(ONBOARDING_SRC).toContain('Personal finance tracker')
    expect(ONBOARDING_SRC).toContain('Client pipeline / CRM')
    expect(ONBOARDING_SRC).toContain('Notes and research vault')
    expect(ONBOARDING_SRC).not.toContain('What kind of work do you do?')
  })

  it('anchors the setup in real material before building', () => {
    expect(ONBOARDING_SRC).toContain('Add anything you already have')
    expect(ONBOARDING_SRC).toContain('Paste notes, lists, CSV rows, goals, client details, or the mess you were about to turn into a template.')
    expect(ONBOARDING_SRC).toContain('Use the real material I gave you first')
  })

  it('uses team-workflow language for org onboarding surfaces', () => {
    expect(ONBOARDING_SRC).toContain('What should this team workspace run first?')
    expect(ONBOARDING_SRC).toContain('Saved the workspace brief')
    expect(ONBOARDING_SRC).toContain('What dohc learned about this workspace')
  })

  it('asks generated follow-ups about the desired setup instead of the user role', () => {
    expect(AGENT_SRC).toContain('A new user wants dohc to set up:')
    expect(AGENT_SRC).toContain('not their job title')
    expect(AGENT_SRC).not.toContain('A new user just told us their work is:')
  })
})
