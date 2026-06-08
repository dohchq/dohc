import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ONBOARDING_SRC = readFileSync(resolve(__dirname, '../components/Onboarding.tsx'), 'utf8')
const AGENT_SRC = readFileSync(resolve(__dirname, '../../convex/agent.ts'), 'utf8')
const ATTACHMENT_PROMPT_SRC = readFileSync(resolve(__dirname, '../../convex/attachmentPrompt.ts'), 'utf8')

describe('onboarding attachments regression', () => {
  it('passes uploaded material asset ids into startOnboarding', () => {
    expect(ONBOARDING_SRC).toContain('useAttachmentUploads')
    expect(ONBOARDING_SRC).toContain("purpose: 'chat'")
    expect(ONBOARDING_SRC).toContain('materialAttachments.readyAssetIds')
    expect(ONBOARDING_SRC).toMatch(/startOnboarding\(\{[\s\S]{0,260}attachmentIds/)
  })

  it('summarizes text attachments and avoids unsupported provider file parts', () => {
    expect(AGENT_SRC).toContain('buildUserMessageForAttachments')
    expect(AGENT_SRC).toContain('const inlineText =')
    expect(AGENT_SRC).toMatch(/if \(!inlineText && shouldSendModelFilePart\(asset\)\)/)
    expect(AGENT_SRC).toContain('read_asset')
    expect(ATTACHMENT_PROMPT_SRC).toContain('function csvPreview')
    expect(ATTACHMENT_PROMPT_SRC).toContain('CSV preview:')
  })
})
