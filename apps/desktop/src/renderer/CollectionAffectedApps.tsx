import { RetryRow, SecondaryButton } from "./ui/controls";
import { SkeletonRows } from "./ui/SkeletonRows";

interface Page {
  apps: ReadonlyArray<{ appId: string; binding: { operationIds: readonly string[] } }>;
  nextCursor: string | null;
}

/** The apps that use a Collection, one page at a time, in the archive and delete dialogs. */
export function CollectionAffectedApps(props: {
  page: Page | null; failed: boolean; busy: boolean; loadingLabel: string; retryTestId: string;
  onRetry(): void; onMore(after: string): void;
}) {
  const { page } = props;
  if (page && !props.failed && !page.apps.length && !page.nextCursor) return <p className="m-0 text-[12px] text-muted">No apps use this Collection.</p>;
  return <div className="min-h-0 overflow-auto"><h3 className="mb-2 mt-0 text-[12px] font-semibold">Affected apps</h3>
    {props.failed && !props.busy ? <RetryRow testId={props.retryTestId} onRetry={props.onRetry} />
      : !page || props.failed ? <SkeletonRows rows={2} label={props.loadingLabel} />
      : <>
        <ul className="m-0 list-none p-0">{page.apps.map(app => <li key={app.appId} className="border-b border-line py-2 text-[12px]"><div className="truncate font-mono" title={app.appId}>{app.appId}</div><div className="text-muted">{app.binding.operationIds.length} approved actions</div></li>)}</ul>
        {page.nextCursor && <SecondaryButton className="mt-2" disabled={props.busy} onClick={() => props.onMore(page.nextCursor!)}>More apps</SecondaryButton>}
      </>}
  </div>;
}
