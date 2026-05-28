export type DohcEditorReadiness = {
  readOnly?: boolean
  collaborationRequired?: boolean
  collaborationEnabled: boolean
  collaborationPending?: boolean
  localReady: boolean
  remoteReady?: boolean
  hasLocalCache?: boolean
  syncError: string | null
}

export function canEditDohcEditor({
  readOnly,
  collaborationRequired,
  collaborationEnabled,
  collaborationPending,
  localReady,
  remoteReady,
  hasLocalCache,
  syncError,
}: DohcEditorReadiness): boolean {
  if (readOnly) return false
  if (collaborationPending) return false
  if (collaborationRequired && !collaborationEnabled) return false
  if (!collaborationEnabled) return true
  return localReady && !syncError && (remoteReady === true || hasLocalCache === true)
}
