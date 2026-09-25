import { ChevronDown, ChevronUp } from "lucide-react";
import type { SidebarSettings } from "../../settings/userSettings";
import { IconButton } from "../ui/controls";
import { activityViewLabel } from "../workbench/ActivityBar";
import { VIEW_IDS, type ViewId } from "../workbench/workbenchState";
import { SwitchControl } from "./SettingRow";

/**
 * dohc's own sidebar views, in the person's order, each with a switch to show
 * it and buttons to move it. Buttons rather than drag, so the keyboard can
 * reorder too.
 */
export function SidebarViewsControl(props: {
  sidebar: SidebarSettings;
  onChange: (sidebar: SidebarSettings) => void;
}) {
  const { sidebar } = props;
  const order: ViewId[] = [...new Set([...sidebar.order, ...VIEW_IDS])];

  const move = (index: number, offset: -1 | 1) => {
    const next = [...order];
    const [view] = next.splice(index, 1);
    if (view === undefined) return;
    next.splice(index + offset, 0, view);
    props.onChange({ ...sidebar, order: next });
  };
  const show = (view: ViewId, shown: boolean) =>
    props.onChange({
      ...sidebar,
      hidden: shown
        ? sidebar.hidden.filter((hidden) => hidden !== view)
        : [...sidebar.hidden, view],
    });

  return (
    <ul
      data-testid="sidebar-views"
      aria-label="Sidebar views"
      className="m-0 flex w-64 list-none flex-col gap-0.5 p-0"
    >
      {order.map((view, index) => {
        const label = activityViewLabel(view);
        return (
          <li
            key={view}
            data-testid="sidebar-view"
            data-view={view}
            className="flex h-8 items-center gap-1 rounded-md px-1"
          >
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{label}</span>
            <IconButton
              aria-label={`Move ${label} up`}
              title={`Move ${label} up`}
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              <ChevronUp size={13} aria-hidden />
            </IconButton>
            <IconButton
              aria-label={`Move ${label} down`}
              title={`Move ${label} down`}
              disabled={index === order.length - 1}
              onClick={() => move(index, 1)}
            >
              <ChevronDown size={13} aria-hidden />
            </IconButton>
            <span className="ml-1.5">
              <SwitchControl
                label={`Show ${label}`}
                checked={!sidebar.hidden.includes(view)}
                onChange={(checked) => show(view, checked)}
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
}
