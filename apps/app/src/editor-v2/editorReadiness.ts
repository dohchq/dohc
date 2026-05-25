export type DohcEditorReadiness = {
  readOnly?: boolean
  collaborationEnabled: boolean
  collaborationPending?: boolean
  localReady: boolean
  syncError: string | null
}

export function canEditDohcEditor({
  readOnly,
  collaborationEnabled,
  collaborationPending,
  localReady,
  syncError,
}: DohcEditorReadiness): boolean {
  if (readOnly) return false
  if (collaborationPending) return false
  if (!collaborationEnabled) return true
  return localReady && !syncError
}
