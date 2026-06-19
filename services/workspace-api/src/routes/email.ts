// One canonical email normalizer for the share/invite surfaces (E5 security
// review note): the routes previously diverged — invites accepted any string
// containing "@" while Better Auth lowercases and validates — which made
// stored and looked-up addresses drift. BOTH routes normalize through here,
// and the normalized form is what gets stored and compared.
//
// Deliberately a SHAPE check, not RFC validation: non-empty local part, one
// "@", and a dot-bearing domain without whitespace. Provider-specific
// canonicalization (gmail dots, plus-addressing) is intentionally absent —
// claims match the literal verified address only.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return EMAIL_SHAPE.test(email) ? email : null;
}
