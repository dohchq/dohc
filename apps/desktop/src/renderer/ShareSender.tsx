import {normalizeShareLabel, shareSenderLabel} from "@dohc/security-contract/share-labels";

// Who sent a share: the full label, its address, and the name before the
// address, or null when the label is only the address.
export function shareSenderParts(name: string | null | undefined, email: string | null | undefined) {
  const address = normalizeShareLabel(email, 320);
  const full = shareSenderLabel(name, email);
  const displayName = address && full.endsWith(` (${address})`)
    ? full.slice(0, -address.length - 3) : address ? null : full;
  return {full, address, displayName};
}

export function ShareSender({name, email}: {name: string | null | undefined; email: string | null | undefined}) {
  const full = shareSenderLabel(name, email);
  return <span className="block truncate text-[11px] text-muted" title={full}>{full}</span>;
}
