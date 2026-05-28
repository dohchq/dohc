export type ShareAccessMode = 'org-default' | 'private' | 'restricted'

export function getShareTargetPlaceholder(isPersonalWorkspace: boolean): string {
  return isPersonalWorkspace
    ? 'Add people by handle'
    : 'Add people or workspaces by handle'
}

export function getGeneralAccessCopy({
  isPersonalWorkspace,
  accessMode,
}: {
  isPersonalWorkspace: boolean
  accessMode: ShareAccessMode
}): {
  label: 'Restricted' | 'Workspace'
  description: string
  canChangeGeneralAccess: boolean
} {
  if (isPersonalWorkspace || accessMode !== 'org-default') {
    return {
      label: 'Restricted',
      description: 'Only people with access can open with the link.',
      canChangeGeneralAccess: !isPersonalWorkspace,
    }
  }

  return {
    label: 'Workspace',
    description: 'Anyone in this workspace can open with the link.',
    canChangeGeneralAccess: true,
  }
}
