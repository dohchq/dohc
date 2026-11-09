// What the Add people field needs to know about addresses: which typed or
// pasted text is an email, and which people to suggest for a query. Main checks
// every address again before it grants anything.

const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;".]+(\.[^\s@<>,;".]+)+$/;

export function isEmail(text: string): boolean {
  return text.length <= 320 && EMAIL.test(text);
}

export function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Splits pasted or typed text into the addresses it holds and what is left.
 * Commas, semicolons, spaces and new lines separate addresses, and
 * `Ana Silva <ana@example.com>`, as a mail app copies it, gives the address.
 */
export function splitAddresses(text: string): { emails: string[]; rest: string } {
  const emails: string[] = [];
  const rest: string[] = [];
  for (const part of text.split(/[,;\n]+/)) {
    // A part with bracketed addresses names people: keep every address in
    // it, bracketed or bare, and drop the names.
    const bracketed = [...part.matchAll(/<([^<>]+)>/g)].map((match) => match[1]!.trim()).filter(isEmail);
    const words = (bracketed.length > 0 ? part.replace(/<[^<>]*>/g, " ") : part).trim().split(/\s+/);
    emails.push(...bracketed);
    for (const word of words) {
      if (word === "") continue;
      if (isEmail(word)) emails.push(word);
      else if (bracketed.length === 0) rest.push(word);
    }
  }
  return { emails, rest: rest.join(" ") };
}

export type PersonOption = { email: string; member: boolean };

/**
 * The people to offer for a query: the people this account already shares
 * groups and messages with, then the typed address itself once it is a whole
 * email nobody else matches. Members stay in the list, marked, so a person
 * sees why they cannot be added twice.
 */
export function suggestPeople(input: {
  known: ReadonlyArray<string>;
  members: ReadonlySet<string>;
  picked: ReadonlySet<string>;
  query: string;
  limit?: number;
}): PersonOption[] {
  const query = emailKey(input.query);
  const seen = new Set<string>();
  const matches: PersonOption[] = [];
  for (const email of input.known) {
    const key = emailKey(email);
    if (seen.has(key) || input.picked.has(key)) continue;
    seen.add(key);
    if (query !== "" && !key.includes(query)) continue;
    matches.push({ email, member: input.members.has(key) });
  }
  matches.sort((a, b) =>
    Number(a.member) - Number(b.member) ||
    Number(!emailKey(a.email).startsWith(query)) - Number(!emailKey(b.email).startsWith(query)) ||
    emailKey(a.email).localeCompare(emailKey(b.email)),
  );
  const typed = input.query.trim();
  if (isEmail(typed) && !seen.has(query) && !input.picked.has(query)) {
    matches.unshift({ email: typed, member: input.members.has(query) });
  }
  return matches.slice(0, input.limit ?? 8);
}
