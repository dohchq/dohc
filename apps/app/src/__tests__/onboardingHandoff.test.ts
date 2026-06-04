import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { onboardingWorkspaceReady } from '../lib/onboarding-ready'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ONBOARDING_SRC = readFileSync(
  resolve(__dirname, '../../src/components/Onboarding.tsx'),
  'utf8',
)
const APP_SRC = readFileSync(resolve(__dirname, '../../src/routes/_app.tsx'), 'utf8')

describe('Onboarding ready handoff', () => {
  it('asks the server to complete a ready workspace instead of waiting forever', () => {
    expect(APP_SRC).toMatch(/api\.onboarding\.completeIfReady/)
    expect(APP_SRC).toMatch(/completeIfReady\(\{\s*activeWorkspaceId\s*\}/)
    expect(APP_SRC).toMatch(/workspaceReady[\s\S]{0,300}completeIfReady/)
  })

  it('keeps client readiness aligned with the server source invariant', () => {
    const base = {
      hasMe: true,
      hasCockpitView: true,
      hasSetupRun: true,
    }

    expect(onboardingWorkspaceReady({ ...base, sourceCount: 0 })).toBe(false)
    expect(onboardingWorkspaceReady({ ...base, sourceCount: 1 })).toBe(true)
  })

  it('does not keep artifact preview/edit code in onboarding', () => {
    expect(ONBOARDING_SRC).not.toMatch(/api\.atoms\.getByPath/)
    expect(ONBOARDING_SRC).not.toMatch(/upsertAtom\(/)
    expect(ONBOARDING_SRC).not.toContain('HtmlAtomFrame')
    expect(ONBOARDING_SRC).not.toContain('Markdown')
  })

  it('keeps onboarding handoff focused on the agent dashboard', () => {
    expect(ONBOARDING_SRC).not.toContain('dohc:onboarding:view')
    expect(ONBOARDING_SRC).not.toContain('isViewPackageRoot')
    expect(APP_SRC).toContain('dohc:onboarding:view')
    expect(APP_SRC).toMatch(/initialViewPackageRootRef[\s\S]{0,500}openView/)
  })

  it('opens the normal agent dashboard while onboarding is in progress', () => {
    expect(APP_SRC).toMatch(/state === 'NEW'[\s\S]{0,120}<Onboarding/)
    expect(APP_SRC).toMatch(
      /state === 'IN_PROGRESS'[\s\S]{0,160}<App initialView="agent"/,
    )
    expect(APP_SRC).toMatch(/function App\(\{\s*initialView/)
  })

  it('removes the old custom setup working screen from onboarding', () => {
    expect(ONBOARDING_SRC).not.toContain("'working'")
    expect(ONBOARDING_SRC).not.toContain('Your Setup Run, live')
    expect(ONBOARDING_SRC).not.toContain('StatusBar')
    expect(ONBOARDING_SRC).not.toContain('BuildChecklist')
    expect(ONBOARDING_SRC).not.toContain('useUIMessages')
    expect(ONBOARDING_SRC).not.toContain("setPhase('working')")
  })

  it('starts onboarding directly from the final questionnaire submit', () => {
    expect(ONBOARDING_SRC).toMatch(
      /startOnboarding\(\{[\s\S]{0,240}\.\.\(intro \? \{ intro \} : \{\}\)[\s\S]{0,240}attachmentIds/,
    )
    expect(ONBOARDING_SRC).toMatch(/setPhase\('handoff'\)/)
    expect(ONBOARDING_SRC).toContain('AppLoadingScreen')
  })

  it('lets the normal app complete ready onboarding after handoff', () => {
    expect(APP_SRC).toContain('onboardingWorkspaceReady')
    expect(APP_SRC).toMatch(/api\.onboarding\.progress/)
    expect(APP_SRC).toMatch(/api\.onboarding\.completeIfReady/)
    expect(APP_SRC).toMatch(/workspaceReady[\s\S]{0,300}completeIfReady/)
  })
})
