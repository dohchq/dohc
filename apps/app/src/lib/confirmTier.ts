// Single source of truth lives in convex/confirmTier.ts (so the
// agent's capture path can import the SAME classifier — no dead copy).
// This re-export keeps the UI + existing unit tests importing from
// src/lib unchanged.
export {
  classifyAction,
  requiresConfirmation,
  type ConfirmTier,
  type ActionKind,
  type ActionTarget,
  type CaptureAction,
} from '../../convex/confirmTier'
