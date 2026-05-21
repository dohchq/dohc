// The single FROZEN parser now lives in convex/inlineAtom.ts so the
// Convex own-desk live-total resolver imports the SAME parser (the
// masterplan §5 "one parser, editor + harness" invariant — never a
// 2nd copy). This re-export keeps the editor plugin + eval harness +
// tests importing from src/lib unchanged. (Same pattern as
// resolveWindow / confirmTier / liveTotal.)
export {
  isEscaped,
  parseInlineAtoms,
  parseInlineAtomsFromMarkdown,
  formatValueAtomText,
  ATOM_BODY_MAX_BYTES,
  type InlineAtomValueType,
  type InlineAtom,
} from '../../convex/inlineAtom'
