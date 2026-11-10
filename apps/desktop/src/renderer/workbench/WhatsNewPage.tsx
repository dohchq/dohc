import { WHATS_NEW } from "../whatsNew";

// A date the notes give as YYYY-MM-DD, read as that calendar day everywhere.
function shippedOn(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { dateStyle: "long", timeZone: "UTC" });
}

export function WhatsNewPage(props: { appVersion: string | null }) {
  return (
    <div data-testid="whats-new-page" className="min-h-0 flex-1 overflow-y-auto bg-bg">
      <div className="mx-auto flex max-w-[640px] flex-col gap-10 px-8 py-12">
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="m-0 text-base font-semibold text-ink">What's new in dohc</h1>
          {props.appVersion && (
            <span data-testid="whats-new-app-version" className="text-[12px] text-muted">
              Version {props.appVersion}
            </span>
          )}
        </header>
        {WHATS_NEW.map((release) => (
          <section key={release.version} aria-labelledby={`whats-new-${release.version}`} className="flex flex-col gap-4">
            <h2 id={`whats-new-${release.version}`} className="dohc-section-label m-0">
              {release.version} · <time dateTime={release.date}>{shippedOn(release.date)}</time>
            </h2>
            <ul className="m-0 flex list-none flex-col gap-5 p-0">
              {release.items.map((item) => (
                <li key={item.title} className="flex gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-panel-2 text-muted">
                    <item.icon aria-hidden size={16} />
                  </span>
                  <div className="flex min-w-0 flex-col gap-1">
                    <h3 className="m-0 text-sm font-semibold text-ink">{item.title}</h3>
                    <p className="m-0 text-[13px] text-muted">{item.body}</p>
                  </div>
                </li>
              ))}
            </ul>
            {release.fixes.length > 0 && (
              <div className="flex flex-col gap-2 pl-11">
                <h3 className="m-0 text-sm font-semibold text-ink">Fixes</h3>
                <ul className="m-0 flex list-disc flex-col gap-1 pl-4 text-[13px] text-muted marker:text-subtle">
                  {release.fixes.map((fix) => <li key={fix}>{fix}</li>)}
                </ul>
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
