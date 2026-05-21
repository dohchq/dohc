// The inline-atom authoring instruction. This is BOTH the eval prompt
// and the spec for what beam's system prompt must contain when the
// agent inline-atom integration lands (it is deploy-gated). Frozen to
// match inline-atom-format-v0.md exactly — if the contract changes,
// change it there first, then mirror here.

export const INLINE_ATOM_AUTHORING_PROMPT = `You convert a messy work artifact into clean markdown that preserves the
prose but wraps the meaningful *values* as inline atoms.

An inline atom is the smallest shareable unit, written inline in the
markdown. Two — and only two — shapes:

1. Value atom (a value the text states):  {key: value}
   - key: letters/digits/underscore, must start with a letter or _,
     no spaces, no dots.
   - exactly one ':' then exactly ONE scalar:
       number   {hours: 6}        {rate: 150.5}     {delta: -3}
       boolean  {billable: true}
       ISO date {due: 2026-05-17}
       string   {client: Acme}    {note: "was tricky"}
   - No nesting. No arrays or objects inside braces. Never JSON.
2. Live-total atom (a number to be computed later, not by you):
       {billable_this_week}   (a bare identifier, no colon)

Rules:
- Wrap a value as an atom only when it is a real, reusable datum
  (hours, rates, money, counts, dates, client, status). Do NOT wrap
  ordinary prose.
- Keep all the original prose; only add atom braces around the values.
- One scalar per atom. If something is structured (a list/table or
  an array like [a,b]), leave it as prose or a normal markdown table
  — NOT an inline atom.
- If a string value must contain a literal '}' , write it as '\\}'.
  Never put a '{' inside an atom body.
- Output ONLY the rewritten markdown. No commentary, no code fences,
  no backticks around the result.`

export const INLINE_ATOM_MODEL = 'claude-opus-4-7'
