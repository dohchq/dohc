// Editor-side re-export of the PURE frontmatter split/join helpers
// (atom-address-v1 Phase-1 b1: strip the leading YAML frontmatter
// before Tiptap, reattach the exact bytes on save). Same one-impl
// pattern as src/lib/inlineAtom.ts: the canonical code lives in
// convex/atomId.ts; its only Convex import is `import type
// MutationCtx` (fully type-erased), so this re-export is client-safe
// and never pulls server code into the bundle. The async ctx
// functions are not re-exported here (editor never needs them).
export {
  splitFrontmatter,
  joinFrontmatter,
  extractFrontmatterId,
  // The ONE html-atom predicate (regex over the split frontmatter).
  // Re-exported so the editor/view gate on the EXACT same check the
  // §2-B route + §5 tree projection use — never a 2nd notion of
  // "is this html" (P3 dual-review FAIL-2: js-yaml vs regex
  // divergence on `type: html # comment` ⇒ a dead frame).
  isHtmlAtomBody,
  // D4.13 — extension-determined html rendering (case-insensitive).
  // Same one-source discipline: every render-decision site imports
  // this single helper.
  isHtmlPath,
  // Track-3 P1: parallel predicates for the skill atom shape +
  // the unified §6 non-data predicate. Same one-source discipline.
  isSkillAtomBody,
  isLegacySkillPath,
  isWorkspaceViewPath,
  isNonDataAtom,
  countTypeLines,
} from '../../convex/atomId'
