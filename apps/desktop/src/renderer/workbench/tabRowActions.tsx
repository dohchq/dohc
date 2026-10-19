import { createContext, useContext, useState, type ReactNode } from "react";

// Where an open document's actions go: the right end of its editor group's
// tab row. Undefined outside an editor group; null until the row mounts.
const TabRowActionsSlot = createContext<HTMLElement | null | undefined>(undefined);

export function useTabRowActionsSlot(): HTMLElement | null | undefined {
  return useContext(TabRowActionsSlot);
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
