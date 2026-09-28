import {normalizeShareLabel, shareSenderLabel} from "@dohc/security-contract/share-labels";

export function ShareSender({name, email}: {name: string | null | undefined; email: string | null | undefined}) {
  const address = normalizeShareLabel(email, 320);
  const full = shareSenderLabel(name, email);
  const displayName = address && full.endsWith(` (${address})`)
    ? full.slice(0, -address.length - 3) : address ? null : full;
  return (
    <span className="flex min-w-0 items-baseline text-[11px] text-muted" title={full}>
      {displayName ? <span className="min-w-0 truncate">{displayName}</span> : null}
      {address ? <span className="max-w-full shrink-0 whitespace-pre-wrap break-all font-mono">{displayName ? ` (${address})` : address}</span> : null}
    </span>
  );
}
