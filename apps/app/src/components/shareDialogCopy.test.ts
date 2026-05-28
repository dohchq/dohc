import { describe, expect, it } from 'vitest'
import {
  getGeneralAccessCopy,
  getShareTargetPlaceholder,
} from './shareDialogCopy'

describe('share dialog copy', () => {
  it('uses personal-only language in personal workspaces', () => {
    const copy = getGeneralAccessCopy({
      isPersonalWorkspace: true,
      accessMode: 'org-default',
    })

    expect(copy.label).toBe('Restricted')
    expect(copy.description).toBe(
      'Only people with access can open with the link.',
    )
    expect(copy.canChangeGeneralAccess).toBe(false)
  })

  it('uses workspace language for shared workspace visibility', () => {
    const copy = getGeneralAccessCopy({
      isPersonalWorkspace: false,
      accessMode: 'org-default',
    })

    expect(copy.label).toBe('Workspace')
    expect(copy.description).toBe(
      'Anyone in this workspace can open with the link.',
    )
    expect(copy.canChangeGeneralAccess).toBe(true)
  })

  it('does not expose company, organization, org, or team wording', () => {
    const samples = [
      getShareTargetPlaceholder(true),
      getShareTargetPlaceholder(false),
      getGeneralAccessCopy({
        isPersonalWorkspace: true,
        accessMode: 'private',
      }).description,
      getGeneralAccessCopy({
        isPersonalWorkspace: false,
        accessMode: 'org-default',
      }).description,
    ].join(' ')

    expect(samples).not.toMatch(/\b(company|organization|org|team)\b/i)
  })
})
