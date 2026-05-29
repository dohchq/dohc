export type ShareAccessMode = 'org-default' | 'private' | 'restricted'
export type GeneralAccessValue = 'restricted' | 'link' | 'workspace'

export function getShareTargetPlaceholder(isPersonalWorkspace: boolean): string {
  return isPersonalWorkspace
    ? 'Email address or dohc handle'
    : 'Email address, handle, or workspace'
}

export function getShareRoutingHint(isPersonalWorkspace: boolean): string {
  return isPersonalWorkspace
    ? 'Routed addresses open in their chosen workspace. Unrouted emails wait in the recipient inbox.'
    : 'Work emails can route here without making this workspace require an email.'
}

export function getGeneralAccessCopy({
  isPersonalWorkspace,
  accessMode,
  hasPublicLink,
}: {
  isPersonalWorkspace: boolean
  accessMode: ShareAccessMode
  hasPublicLink: boolean
}): {
  label: 'Restricted' | 'Anyone with the link' | 'Workspace'
  description: string
  canChangeGeneralAccess: boolean
} {
  if (hasPublicLink) {
    return {
      label: 'Anyone with the link',
      description: 'Anyone with this link can open the document.',
      canChangeGeneralAccess: true,
    }
  }

  if (isPersonalWorkspace || accessMode !== 'org-default') {
    return {
      label: 'Restricted',
      description: 'Only people with access can open with the link.',
      canChangeGeneralAccess: true,
    }
  }

  return {
    label: 'Workspace',
    description: 'Anyone in this workspace can open with the link.',
    canChangeGeneralAccess: true,
  }
}

export function getGeneralAccessOptions(
  isPersonalWorkspace: boolean,
): Array<{
  value: GeneralAccessValue
  label: string
  description: string
}> {
  const options: Array<{
    value: GeneralAccessValue
    label: string
    description: string
  }> = [
    {
      value: 'restricted',
      label: 'Restricted',
      description: 'Only people with access can open.',
    },
    {
      value: 'link',
      label: 'Anyone with the link',
      description: 'Anyone with this link can open.',
    },
  ]

  if (!isPersonalWorkspace) {
    options.push({
      value: 'workspace',
      label: 'Workspace',
      description: 'Anyone in this workspace can open.',
    })
  }

  return options
}
