import { WHATS_NEW } from "../whatsNew";

export function WhatsNewPage() {
  return (
    <div data-testid="whats-new-page" className="min-h-0 flex-1 overflow-y-auto bg-bg">
      <div className="mx-auto flex max-w-[640px] flex-col gap-10 px-8 py-12">
        <h1 className="m-0 text-base font-semibold text-ink">What's new in dohc</h1>
        {WHATS_NEW.map((release) => (
          <section key={release.id} aria-labelledby={`whats-new-${release.id}`} className="flex flex-col gap-4">
            <h2 id={`whats-new-${release.id}`} className="dohc-section-label m-0">
              {release.title}
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
          </section>
        ))}
      </div>
    </div>
  );
}
