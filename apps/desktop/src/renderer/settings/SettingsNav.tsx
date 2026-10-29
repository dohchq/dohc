import type { ReactNode } from "react";
import { Folder, Search } from "lucide-react";
import { desktopPins, settingsNavPin } from "../../testPins";
import { workspaceName } from "../Titlebar";
import { isSettingsSectionId, SETTINGS_SECTIONS, type SettingsSectionId } from "./settingsRegistry";

type Section = (typeof SETTINGS_SECTIONS)[number];

/**
 * Settings' aside: the title, search, and the sections grouped by where they
 * apply. Yours first, then this workspace's under its folder, then Advanced.
 * Below 720px the nav gives way to a section picker under search.
 */
export function SettingsNav(props: {
  workspacePath: string;
  // The sections search left, in registry order.
  sections: readonly Section[];
  activeSection: SettingsSectionId;
  onSelect: (section: SettingsSectionId) => void;
  query: string;
  onQuery: (query: string) => void;
  // Beside the title, such as whether the last change saved.
  status?: ReactNode;
}) {
  const group = (name: Section["group"]) => props.sections.filter((section) => section.group === name);
  const yours = group("you");
  const workspace = group("workspace");
  const advanced = group("advanced");
  const item = (section: Section) => (
    <button
      key={section.id}
      type="button"
      data-testid={settingsNavPin(section.id)}
      aria-current={props.activeSection === section.id ? "page" : undefined}
      onClick={() => props.onSelect(section.id)}
      className={`flex h-7 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-75 focus-visible:-outline-offset-2 ${
        props.activeSection === section.id
          ? "bg-selected text-ink"
          : "text-muted hover:bg-hover hover:text-ink"
      }`}
    >
      <section.Icon size={15} strokeWidth={1.9} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{section.label}</span>
    </button>
  );

  return (
    <aside
      data-testid="settings-sidebar"
      className="flex w-56 shrink-0 flex-col border-r border-line bg-panel-2 px-1 py-3 max-[720px]:w-full max-[720px]:border-b max-[720px]:border-r-0"
    >
      <div className="flex h-6 items-center gap-2 px-2 max-[720px]:pr-10">
        <h2 id="settings-title" className="m-0 text-sm font-semibold text-ink">
          Settings
        </h2>
        {props.status}
      </div>
      <div className="relative my-2">
        <Search
          size={14}
          aria-hidden
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-subtle"
        />
        <input
          spellCheck={false}
          data-testid={desktopPins.settingsSearch}
          aria-label="Search settings"
          value={props.query}
          onChange={(event) => props.onQuery(event.target.value)}
          placeholder="Search"
          className="h-8 w-full rounded-md border border-line bg-bg pl-7 pr-2 text-[13px] text-ink placeholder:text-subtle focus:border-ink"
        />
      </div>
      <select
        aria-label="Settings section"
        value={props.activeSection}
        onChange={(event) => {
          if (isSettingsSectionId(event.target.value)) props.onSelect(event.target.value);
        }}
        className="h-8 w-full rounded-md border border-line bg-bg px-2 text-[13px] text-ink min-[721px]:hidden"
      >
        {props.sections.map((section) => (
          <option key={section.id} value={section.id}>
            {section.label}
          </option>
        ))}
      </select>
      <nav className="flex min-h-0 flex-1 flex-col overflow-auto max-[720px]:hidden">
        {yours.map(item)}
        {workspace.length > 0 ? (
          <div
            data-testid="settings-row-current-workspace"
            title={props.workspacePath}
            className="mt-4 flex h-6 shrink-0 items-center gap-2 px-2 text-[12px] font-medium text-subtle first:mt-0"
          >
            <Folder size={12} strokeWidth={1.9} aria-hidden className="shrink-0" />
            <span className="min-w-0 truncate">{workspaceName({ rootPath: props.workspacePath })}</span>
          </div>
        ) : null}
        {workspace.map(item)}
        {advanced.length > 0 && advanced.length < props.sections.length ? (
          <div aria-hidden className="mx-2 my-2 h-px shrink-0 bg-line" />
        ) : null}
        {advanced.map(item)}
      </nav>
    </aside>
  );
}
