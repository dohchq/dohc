import { useMemo } from "react";
import { shortcutName, shortcutShown } from "../../shortcuts/shortcutNames";
import { SHORTCUTS, shortcutChords, type ShortcutId, type ShortcutOwner } from "../../shortcuts/shortcutRegistry";
import { SectionLabel } from "../ui/controls";
import { SettingRow } from "./SettingRow";

// A heading says where its keys work, so a chord with two meanings, such as
// Ctrl+B for Toggle sidebar and Bold, or Enter for Next match and Open,
// reads once under each.
const HEADINGS = ["Workbench", "Document", "Find field", "Command palette and Go to"] as const;
type Heading = (typeof HEADINGS)[number];

// Who answers a key decides where it works. Find next's F3 works from the
// document while finding, and Next match's Enter only in the find field.
const OWNER_HEADINGS = {
  shell: "Workbench",
  main: "Workbench",
  native: "Workbench",
  "history-restore": "Workbench",
  dev: "Workbench",
  document: "Document",
  editor: "Document",
  find: "Document",
  "find-field": "Find field",
  palette: "Command palette and Go to",
} as const satisfies Record<ShortcutOwner, Heading>;

type KeyboardRow = { name: string; ids: ShortcutId[]; chords: (readonly string[])[] };

// The shortcuts Settings lists on this platform, under their headings in
// registry order. Shortcuts that share a name under a heading share a row.
export function keyboardGroups(platform: string | undefined, devTools: boolean): { heading: Heading; rows: KeyboardRow[] }[] {
  const groups = HEADINGS.map((heading) => ({ heading, rows: [] as KeyboardRow[] }));
  for (const id of Object.keys(SHORTCUTS) as ShortcutId[]) {
    if (!shortcutShown(id, platform, devTools)) continue;
    const { rows } = groups.find((group) => group.heading === OWNER_HEADINGS[SHORTCUTS[id].owner])!;
    const name = shortcutName(id);
    const chords = shortcutChords(id, platform);
    const row = rows.find((existing) => existing.name === name);
    if (row) {
      row.ids.push(id);
      row.chords.push(...chords);
    } else {
      rows.push({ name, ids: [id], chords: [...chords] });
    }
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
                      <kbd key={key} className="rounded border border-line bg-bg px-1 font-sans text-[11px] text-muted">
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
