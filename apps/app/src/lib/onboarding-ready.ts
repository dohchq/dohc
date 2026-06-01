export type OnboardingReadyProgress = {
  hasMe?: boolean | null
  sourceCount?: number | null
  hasCockpitView?: boolean | null
  hasSetupRun?: boolean | null
}

export function onboardingWorkspaceReady(
  progress: OnboardingReadyProgress | null | undefined,
): boolean {
  return (
    !!progress?.hasMe &&
    (progress.sourceCount ?? 0) >= 1 &&
    !!progress.hasCockpitView &&
    !!progress.hasSetupRun
  )
}
