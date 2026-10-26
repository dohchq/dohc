import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import type { ActorPresentation, DohcDesktopBridge } from "../../ipc/bridgeContract";
import { ipcErrorMessage } from "../ipcError";
import { HueControl } from "../settings/SettingRow";
import type { IdentityHue } from "../tokens";
import { MENU_ENTER, MENU_FRAME, menuEnterFrom } from "../ui/Menu";
import { useDismiss } from "../ui/useDismiss";
import { agentChoice, canChooseAgentColor, subscribePresentation } from "./actorPresentation";

type SaveAgentColor = (group: string, hue: IdentityHue | null) => void;

/**
 * Saves one agent's color in this window's workspace. The avatar repaints
 * from main's event, not from the save. A surface without it offers no choice.
 */
export const AgentColorContext = createContext<SaveAgentColor | null>(null);

/** The shell's save: a personal setting on this computer, and a failure as a notice with Try again. */
export function saveAgentColor(
  api: Pick<DohcDesktopBridge, "setAgentColor">,
  workspaceId: string,
  report: (message: string, error: Error, retry: () => void) => void,
): SaveAgentColor {
  const save: SaveAgentColor = (group, hue) => {
    api.setAgentColor({ workspaceId, group, hue }).catch((error: unknown) => {
      report("dohc could not save this agent's color.", new Error(ipcErrorMessage(error)), () => save(group, hue));
    });
  };
  return save;
}

type Scope = {
  name: string;
  presentation: ActorPresentation;
  open: boolean;
  setOpen: (open: boolean) => void;
  trigger: RefObject<HTMLButtonElement | null>;
};
const ScopeContext = createContext<Scope | null>(null);

// Between the trigger and the popover, and the popover and the window's edge, as the Menu part keeps.
const GAP_PX = 4;
const EDGE_PX = 12;

/**
 * Where a conversation shows an agent, its avatar and name open one color
 * popover. Wrap both in the scope; a person, an automation, or an agent main
 * did not issue a group for, renders its children alone.
 */
export function AgentColorScope(props: {
  name: string;
  kind: "human" | "agent" | "automation" | "link";
  presentation: ActorPresentation;
  children: ReactNode;
}) {
  const save = useContext(AgentColorContext);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  if (!save || props.kind !== "agent" || !canChooseAgentColor(props.presentation)) return <>{props.children}</>;
  return (
    <ScopeContext.Provider value={{ name: props.name, presentation: props.presentation, open, setOpen, trigger }}>
      {props.children}
    </ScopeContext.Provider>
  );
}

/** The agent's avatar as the popover's trigger. */
export function AgentColorAvatar(props: { children: ReactNode }) {
  const scope = useContext(ScopeContext);
  if (!scope) return <>{props.children}</>;
  const label = `Color for ${scope.name}`;
  return (
    <>
      <button
        ref={scope.trigger}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={scope.open}
        data-testid="agent-color-trigger"
        onClick={() => scope.setOpen(!scope.open)}
        className="inline-grid shrink-0 cursor-pointer place-items-center rounded-lg"
      >
        {props.children}
      </button>
      {scope.open ? <AgentColorPopover scope={scope} label={label} /> : null}
    </>
  );
}

/**
 * The agent's name opens the same popover from a pointer. The avatar is its
 * one keyboard stop, so the name stays the author's text to a screen reader.
 */
export function AgentColorName(props: { children: ReactNode }) {
  const scope = useContext(ScopeContext);
  if (!scope) return <>{props.children}</>;
  return (
    <span className="cursor-pointer hover:underline" onClick={() => scope.setOpen(true)}>
      {props.children}
    </span>
  );
}

function AgentColorPopover(props: { scope: Scope; label: string }) {
  const { scope } = props;
  const save = useContext(AgentColorContext);
  const container = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number; above: boolean } | null>(null);
  const value = useSyncExternalStore(subscribePresentation, () => agentChoice(scope.presentation));
  useDismiss({ open: true, container, trigger: scope.trigger, onClose: () => scope.setOpen(false) });

  useLayoutEffect(() => {
    const box = scope.trigger.current?.getBoundingClientRect();
    const popover = container.current;
    // The top layer, as the reaction picker uses: a virtualized list's
    // transformed rows would otherwise hold a fixed box under the next row.
    popover?.showPopover?.();
    if (box && popover) {
      const left = Math.max(EDGE_PX, Math.min(box.left, window.innerWidth - EDGE_PX - popover.offsetWidth));
      const above = window.innerHeight - box.bottom - GAP_PX - EDGE_PX < popover.offsetHeight && box.top > window.innerHeight - box.bottom;
      setPlace(above
        ? { left, bottom: window.innerHeight - box.top + GAP_PX, above }
        : { left, top: box.bottom + GAP_PX, above });
    }
    popover?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')?.focus({ preventScroll: true });
  }, [scope.trigger]);

  // Placed once, so it closes when its chat scrolls or the window resizes.
  // useDismiss's focus return puts focus back on the trigger only when it was inside.
  const { setOpen } = scope;
  useEffect(() => {
    const close = (event: Event) => {
      if (event.target instanceof Node && container.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [setOpen]);

  return (
    <div
      ref={container}
      popover="manual"
      role="dialog"
      aria-label={props.label}
      data-testid="agent-color-popover"
      // Escape closes this popover, not the conversation under it.
      data-chat-escape-local="true"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // useDismiss already closed it; one Escape closes one surface.
        if (event.key === "Escape") event.stopPropagation();
        // Tab and Shift+Tab close it, as the Menu part does, and the browser
        // moves focus on from the trigger, wherever the arrows had left it.
        else if (event.key === "Tab") {
          scope.trigger.current?.focus({ preventScroll: true });
          setOpen(false);
        }
      }}
      style={{
        inset: "auto",
        ...(place
          ? { left: place.left, top: place.top, bottom: place.bottom, ...menuEnterFrom(place.above ? "above" : "below") }
          : { left: 0, top: 0 }),
      } as CSSProperties}
      className={`fixed m-0 overflow-visible border-0 bg-transparent p-0 ${place ? MENU_ENTER : ""}`}
    >
      <AgentColorSwatches
        label={props.label}
        value={value}
        onChange={(hue) => {
          scope.setOpen(false);
          scope.trigger.current?.focus();
          save?.(scope.presentation.group, hue);
        }}
      />
    </div>
  );
}

/** The popover's frame and swatches, olive first. Olive is no color chosen, so it stores nothing. */
export function AgentColorSwatches(props: { label: string; value: IdentityHue | null; onChange: (hue: IdentityHue | null) => void }) {
  return (
    <div className={MENU_FRAME}>
      <div className="p-1">
        <HueControl label={props.label} shape="agent" value={props.value ?? "olive"} arrowsMoveFocus
          onChange={(hue) => props.onChange(hue === "olive" ? null : hue)} />
      </div>
    </div>
  );
}
