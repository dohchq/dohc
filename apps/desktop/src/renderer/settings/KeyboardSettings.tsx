import { useMemo } from "react";
import { shortcutName } from "../../shortcuts/shortcutNames";
import { SHORTCUTS, shortcutChords, type ShortcutId, type ShortcutOwner } from "../../shortcuts/shortcutRegistry";
import { SectionLabel } from "../ui/controls";
import { SettingRow } from "./SettingRow";

// A heading says where its keys work, so a chord with two meanings, such as
// Ctrl+B for Toggle sidebar and Bold, reads once under each.
const HEADINGS = ["Workbench", "Document", "Find", "Command palette and Go to"] as const;
type Heading = (typeof HEADINGS)[number];

// Who answers a key decides where it works.
const OWNER_HEADINGS = {
  shell: "Workbench",
  main: "Workbench",
  native: "Workbench",
  "history-restore": "Workbench",
  dev: "Workbench",
  document: "Document",
  editor: "Document",
  find: "Find",
  palette: "Command palette and Go to",
} as const satisfies Record<ShortcutOwner, Heading>;

type KeyboardRow = { name: string; chords: (readonly string[])[] };

// The shortcuts this platform answers, under their headings in registry
// order. Shortcuts that share a name under a heading share a row. Dev tools'
// key shows only where the dev tools do.
export function keyboardGroups(platform: string | undefined, devTools: boolean): { heading: Heading; rows: KeyboardRow[] }[] {
  const groups = HEADINGS.map((heading) => ({ heading, rows: [] as KeyboardRow[] }));
  for (const id of Object.keys(SHORTCUTS) as ShortcutId[]) {
    const shortcut: { owner: ShortcutOwner; platform?: string } = SHORTCUTS[id];
    if ((shortcut.platform && shortcut.platform !== platform) || (shortcut.owner === "dev" && !devTools)) continue;
    const { rows } = groups.find((group) => group.heading === OWNER_HEADINGS[shortcut.owner])!;
    const name = shortcutName(id);
    const chords = shortcutChords(id, platform);
    const row = rows.find((existing) => existing.name === name);
    if (row) row.chords.push(...chords);
    else rows.push({ name, chords: [...chords] });
  }
  return groups;
}

/**
 * Every shortcut dohc answers on this platform, read-only: each name and its
 * keys. A Settings search that names shortcuts, such as "bold", shows only
 * theirs; one that found the page another way, such as "keys", shows them all.
 */
export function KeyboardSettings(props: { platform: string | undefined; devTools: boolean; query?: string }) {
  const groups = useMemo(() => keyboardGroups(props.platform, props.devTools), [props.platform, props.devTools]);
  const query = (props.query ?? "").trim().toLowerCase();
  const named = groups
    .map((group) => ({ ...group, rows: group.rows.filter((row) => row.name.toLowerCase().includes(query)) }))
    .filter((group) => group.rows.length > 0);
  return (
    <>
      {(named.length > 0 ? named : groups).map(({ heading, rows }) => (
        <section key={heading} className="mt-8 first:mt-0">
          <SectionLabel as="h4" className="m-0 mb-1">
            {heading}
          </SectionLabel>
          {rows.map((row) => (
            <SettingRow key={row.name} title={row.name} compact>
              <span className="flex flex-wrap justify-end gap-x-3 gap-y-1">
                {row.chords.map((keys, index) => (
                  <span key={keys.join("+")} className="flex items-center gap-1">
                    {index > 0 ? <span className="sr-only">or</span> : null}
                    {keys.map((key) => (
                      <kbd key={key} className="rounded border border-line bg-bg px-1 font-mono text-[11px] text-muted">
                        {key}
                      </kbd>
                    ))}
                  </span>
                ))}
              </span>
            </SettingRow>
          ))}
        </section>
      ))}
    </>
  );
}
