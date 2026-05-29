import { describe, expect, it } from 'vitest'
import {
  getGeneralAccessCopy,
  getGeneralAccessOptions,
  getShareRoutingHint,
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

  it('frames email as routing into a workspace, not as the workspace itself', () => {
    expect(getShareTargetPlaceholder(true)).toBe('Email address or dohc handle')
    expect(getShareTargetPlaceholder(false)).toBe('Email address, handle, or workspace')
    expect(getShareRoutingHint(true)).toBe(
      'Routed addresses open in their chosen workspace. Unrouted emails wait in the recipient inbox.',
    )
    expect(getShareRoutingHint(false)).toBe(
      'Work emails can route here without making this workspace require an email.',
    )
  })
})
