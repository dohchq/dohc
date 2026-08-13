export const MAX_PREFERRED_NAME_LENGTH = 80;

// ZWNJ and ZWJ are valid in Persian text and joined emoji. Other control and
// formatting characters can spoof or split the visible author label.
const CONTROL_CHARACTERS = /(?:[\p{Cc}\p{Zl}\p{Zp}]|(?![\u200c\u200d])\p{Cf})/u;

export function hasPreferredNameControlCharacters(value: string): boolean {
  return CONTROL_CHARACTERS.test(value);
}

export function preferredNameFromInput(value: string): string | undefined {
  const preferredName = value.trim();
  if (!preferredName) return undefined;
  if (preferredName.length > MAX_PREFERRED_NAME_LENGTH) {
    throw new Error(`Names must contain ${MAX_PREFERRED_NAME_LENGTH} characters or fewer.`);
  }
  if (hasPreferredNameControlCharacters(preferredName)) {
    throw new Error("Names cannot contain control characters.");
  }
  return preferredName;
}

export function agentDisplayLabel(ownerDisplayName: string): string {
  const owner = ownerDisplayName.trim();
  return /['’]s agent$/i.test(owner) ? owner : `${owner}'s agent`;
}
