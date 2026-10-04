import { useState } from "react";
import { Menu } from "./Menu";

export type MoreMenuItem = { label: string; onSelect: () => void; disabled?: boolean };

/** A ••• menu for a row or a panel: a Menu that holds its own open state. */
export function MoreMenu(props: { label: string; items: readonly MoreMenuItem[]; testId?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      label={props.label}
      testId={props.testId}
      open={open}
      onOpenChange={setOpen}
      items={props.items.map((item) => ({ ...item, id: item.label }))}
    />
  );
}
