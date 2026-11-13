import { createContext, useContext, useState, type ReactNode } from "react";

// Where an open document's actions go: the right end of its editor group's
// tab row. Undefined outside an editor group; null until the row mounts.
const TabRowActionsSlot = createContext<HTMLElement | null | undefined>(undefined);

// A group's tab row narrower than 352px hides Share file and New editor group
// right, so the active tab keeps its glyph and name: below it, a document's
// controls, a state mark and the row's three buttons leave a short name's tab
// (about 132px with the strip's end) no room. Both stay in the group's tab
// list. A container query on the row, so a resize does no layout work of its
// own. Outside an editor group there is no row, and nothing hides.
export const NARROW_GROUP_HIDDEN = "@max-[352px]/file-row:hidden";
// The strip's end keeps no minimum there, so a tab that fits doesn't scroll
// under the strip's fades.
export const NARROW_GROUP_NO_MIN_WIDTH = "@max-[352px]/file-row:min-w-0";

export function useTabRowActionsSlot(): HTMLElement | null | undefined {
  return useContext(TabRowActionsSlot);
}

// Whether a view's own row of actions sits inside a page that has its own
// frame, such as the record panel: the row then draws no band of its own.
const PlainActionsRow = createContext(false);
export function usePlainActionsRow(): boolean {
  return useContext(PlainActionsRow);
}

// A view drawn inside another tab's page, such as a record's body in its
// Collection's record panel, keeps its actions with it: they draw in a row of
// their own, as outside an editor group, and not in the row of a tab that is
// not the view's. The page frames the row, so it has a line above it and no
// band.
export function OwnActionsRow(props: { children: ReactNode }) {
  return (
    <TabRowActionsSlot.Provider value={undefined}>
      <PlainActionsRow.Provider value>{props.children}</PlainActionsRow.Provider>
    </TabRowActionsSlot.Provider>
  );
}

// One editor group: its tab row, given the element the actions land in, then
// the view under it. Each group has its own slot, so a split shows each
// group's document actions in that group's row.
export function EditorGroupFrame(props: {
  tabs: (actionsRef: (element: HTMLElement | null) => void) => ReactNode;
  children: ReactNode;
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <>
      {props.tabs(setSlot)}
      <TabRowActionsSlot.Provider value={slot}>{props.children}</TabRowActionsSlot.Provider>
    </>
  );
}
