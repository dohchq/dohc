// Single source of truth lives in convex/liveTotal.ts (so the Convex
// query adapter imports the SAME tested pure core — no dead copy;
// the Phase-3 lesson). This re-export keeps the editor + tests
// importing from src/lib unchanged.
export {
  resolveLiveTotal,
  type RollupOp,
  type RollupSpec,
  type ValueAtom,
} from '../../convex/liveTotal'
