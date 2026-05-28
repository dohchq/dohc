import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ONBOARDING_SRC = readFileSync(
  resolve(__dirname, '../../src/components/Onboarding.tsx'),
  'utf8',
)

describe('Onboarding ready handoff', () => {
  it('asks the server to complete a ready workspace instead of waiting forever', () => {
    expect(ONBOARDING_SRC).toMatch(/api\.onboarding\.completeIfReady/)
    expect(ONBOARDING_SRC).toMatch(/completeIfReady\(\{\s*activeWorkspaceId\s*\}/)
    expect(ONBOARDING_SRC).toMatch(/workspaceReady[\s\S]{0,300}completeIfReady/)
  })

  it('previews and edits ready artifacts in the active workspace', () => {
    expect(ONBOARDING_SRC).toMatch(
      /api\.atoms\.getByPath,\s*[\s\S]{0,180}activeWorkspaceId/,
    )
    expect(ONBOARDING_SRC).toMatch(
      /upsertAtom\(\{[\s\S]{0,120}path:\s*meAtom\.path[\s\S]{0,120}activeWorkspaceId/,
    )
  })
})
