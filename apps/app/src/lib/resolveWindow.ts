// Single source of truth lives in convex/resolveWindow.ts (so the
// Phase-3 adapter imports the SAME tested fail-closed function — no
// dead copy). This re-export keeps the UI + the T5 property tests
// importing from src/lib unchanged.
export {
  resolveWindow,
  unreviewedKey,
  type WorkspaceId,
  type StoredAtom,
  type WindowDef,
  type Grant,
  type Stores,
  type ResolveRequest,
  type ResolveResult,
} from '../../convex/resolveWindow'
