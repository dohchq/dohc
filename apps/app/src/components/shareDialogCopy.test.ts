import { describe, expect, it } from 'vitest'
import {
  getGeneralAccessCopy,
  getGeneralAccessOptions,
  getShareTargetPlaceholder,
} from './shareDialogCopy'

describe('share dialog copy', () => {
  it('uses personal-only language in personal workspaces', () => {
    const copy = getGeneralAccessCopy({
      isPersonalWorkspace: true,
      accessMode: 'org-default',
      hasPublicLink: false,
    })

    expect(copy.label).toBe('Restricted')
    expect(copy.description).toBe(
      'Only people with access can open with the link.',
    )
    expect(copy.canChangeGeneralAccess).toBe(true)
  })

  it('uses workspace language for shared workspace visibility', () => {
    const copy = getGeneralAccessCopy({
      isPersonalWorkspace: false,
      accessMode: 'org-default',
      hasPublicLink: false,
    })

    expect(copy.label).toBe('Workspace')
    expect(copy.description).toBe(
      'Anyone in this workspace can open with the link.',
    )
    expect(copy.canChangeGeneralAccess).toBe(true)
  })

  it('shows anyone-with-link copy when a public link exists', () => {
    const copy = getGeneralAccessCopy({
      isPersonalWorkspace: true,
      accessMode: 'private',
      hasPublicLink: true,
    })

    expect(copy.label).toBe('Anyone with the link')
    expect(copy.description).toBe(
      'Anyone with this link can open the document.',
    )
    expect(copy.canChangeGeneralAccess).toBe(true)
  })

  it('offers link access in personal workspaces without workspace access', () => {
    expect(getGeneralAccessOptions(true).map((o) => o.value)).toEqual([
      'restricted',
      'link',
    ])
  })

  it('offers workspace access in shared workspaces', () => {
    expect(getGeneralAccessOptions(false).map((o) => o.value)).toEqual([
      'restricted',
      'link',
      'workspace',
    ])
  })

  it('does not expose company, organization, org, or team wording', () => {
    const samples = [
      getShareTargetPlaceholder(true),
      getShareTargetPlaceholder(false),
      getGeneralAccessCopy({
        isPersonalWorkspace: true,
        accessMode: 'private',
        hasPublicLink: false,
      }).description,
      getGeneralAccessCopy({
        isPersonalWorkspace: false,
        accessMode: 'org-default',
        hasPublicLink: false,
      }).description,
    ].join(' ')

    expect(samples).not.toMatch(/\b(company|organization|org|team)\b/i)
  })

  it('asks for people by email instead of handle', () => {
    expect(getShareTargetPlaceholder(true)).toBe('Add people by email')
    expect(getShareTargetPlaceholder(false)).toBe(
      'Add people or workspaces by email',
    )
  })
})
