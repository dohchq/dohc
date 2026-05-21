// Reviewed-by-default confirm tiers (Phase 2 / Design D5).
//
// Confirm friction tracks BLAST RADIUS, not atom count:
//   silent   — private, agent-authored, non-destructive. Captured
//              with zero interruption (the no-tax path).
//   digest   — feeds a window another person can see. Batched into a
//              once-a-session "ready to share?" review. Never blocks
//              work; nothing reaches another human un-reviewed.
//   inline   — beam is genuinely unsure (ambiguous value/owner). One
//              lightweight nudge, dismissible.
//   blocking — DESTRUCTIVE (delete / overwrite of user-authored
//              content) or destructive-from-untrusted-artifact. Must
//              be explicitly confirmed (Phase-1 prompt-injection
//              mitigation).
//
// WIRED — single source of truth, no dead code (verified by review):
//  • capture routing: captures.recordCapture → classifyAction
//    (silent/digest/inline).
//  • delete confirmation: agent.ts delete_atom/entity/folder gate on
//    requiresConfirmation({kind:'delete',...}) — the classifier IS the
//    live decision point for the `blocking` tier.
//  • overwrite of user content: enforced STRUCTURALLY at the data
//    layer (atoms._upsertInternal throws) — stronger than a prompt
//    gate; classifyAction models it, the DB enforces it.
// `src/lib` re-exports this for the UI + existing unit tests. There is
// exactly one physical copy and every branch has a real caller.

export type ConfirmTier = 'silent' | 'digest' | 'inline' | 'blocking'

export type ActionKind = 'create' | 'overwrite' | 'delete'
export type ActionTarget = 'atom' | 'entity' | 'folder'

export type CaptureAction = {
  kind: ActionKind
  target: ActionTarget
  /** the value/atom feeds a window another principal can see */
  shared?: boolean
  /** beam is not confident about the value or its owner */
  unsure?: boolean
  /** the existing content being overwritten was authored by the
   *  human (not by a prior agent write) */
  overwritesUserContent?: boolean
  /** this action was induced by content from a pasted/untrusted
   *  artifact (prompt-injection surface) */
  fromUntrustedArtifact?: boolean
}

export function classifyAction(a: CaptureAction): ConfirmTier {
  const destructive =
    a.kind === 'delete' ||
    (a.kind === 'overwrite' && a.overwritesUserContent === true)
  if (destructive) return 'blocking'

  if (
    a.fromUntrustedArtifact &&
    (a.kind === 'delete' || a.kind === 'overwrite')
  ) {
    return 'blocking'
  }

  if (a.unsure) return 'inline'
  if (a.shared) return 'digest'
  return 'silent'
}

/** The destructive-tool gate. A `blocking` action must NOT execute
 *  until explicitly confirmed. */
export function requiresConfirmation(a: CaptureAction): boolean {
  return classifyAction(a) === 'blocking'
}
