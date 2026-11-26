export const SECRET_PREFIXES = [
  "phx_",
  "sk_live_",
  "ghp_",
  "github_pat_",
  "xoxb-",
  "xoxp-",
] as const;

export type SecretPrefix = (typeof SECRET_PREFIXES)[number];

const LIKELY_SECRET = /\b(phx_|sk_live_|ghp_|github_pat_|xoxb-|xoxp-)[A-Za-z0-9_-]{20,}/;

/** The prefix of the first likely live secret token in `text`, or null. It never returns the token. */
export function likelySecretPrefix(text: string): SecretPrefix | null {
  return (LIKELY_SECRET.exec(text)?.[1] as SecretPrefix | undefined) ?? null;
}

const LABELS: Record<SecretPrefix, string> = {
  phx_: "a PostHog personal API key",
  sk_live_: "a Stripe live secret key",
  ghp_: "a GitHub token",
  github_pat_: "a GitHub token",
  "xoxb-": "a Slack token",
  "xoxp-": "a Slack token",
};

export function secretPrefixLabel(prefix: SecretPrefix): string {
  return LABELS[prefix];
}
