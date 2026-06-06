import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ONBOARDING_SRC = readFileSync(resolve(__dirname, '../components/Onboarding.tsx'), 'utf8')
const APP_SRC = readFileSync(resolve(__dirname, '../routes/_app.tsx'), 'utf8')

describe('onboarding no intermediate flash regression', () => {
  it('switches directly to the app loading handoff while startOnboarding runs', () => {
    expect(ONBOARDING_SRC).toContain("setPhase('handoff')")
    expect(ONBOARDING_SRC).toContain('if (phase === \'handoff\') return <AppLoadingScreen />')
    expect(ONBOARDING_SRC).not.toContain('dohc:onboarding:view')
    expect(APP_SRC).toContain('onboardingWorkspaceReady')
    expect(APP_SRC).toContain('api.onboarding.completeIfReady')
  })

  it('starts onboarding from the final questionnaire submit without a transient new-chat screen', () => {
    expect(ONBOARDING_SRC).toMatch(/startOnboarding\(\{[\s\S]{0,260}\.\.\(intro \? \{ intro \} : \{\}\)[\s\S]{0,260}attachmentIds/)
    expect(ONBOARDING_SRC).toContain('setupStartedRef.current = true')
    expect(ONBOARDING_SRC).toContain('if (setupStartedRef.current) return')
  })
})
