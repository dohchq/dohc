// Pure window-state model: parse/clamp/serialize for {bounds, isMaximized},
// persisted to stateDir()/dohc-window-state.json by createMainWindow. Pure so
// the display-clamping rules are unit-tested without Electron.

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  bounds: WindowBounds;
  isMaximized: boolean;
}

export const WINDOW_STATE_FILE = "dohc-window-state.json";
export const DEFAULT_WINDOW_SIZE = { width: 1280, height: 800 } as const;
export const MIN_WINDOW_SIZE = { width: 840, height: 620 } as const;

// How much of the window must remain on SOME display to trust saved bounds —
// enough to grab the titlebar and drag it back.
const MIN_VISIBLE_PX = 64;

function isFiniteInt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// Tolerant: a missing, corrupt, or foreign-shaped file is "no saved state",
// never a launch failure.
export function parseWindowState(raw: string | null | undefined): WindowState | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as {
      bounds?: Partial<WindowBounds>;
      isMaximized?: unknown;
    };
    const b = data.bounds;
    if (
      !b ||
      !isFiniteInt(b.x) ||
      !isFiniteInt(b.y) ||
      !isFiniteInt(b.width) ||
      !isFiniteInt(b.height) ||
      b.width < MIN_WINDOW_SIZE.width ||
      b.height < MIN_WINDOW_SIZE.height
    ) {
      return null;
    }
    return {
      bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
      isMaximized: data.isMaximized === true,
    };
  } catch {
    return null;
  }
}

export function serializeWindowState(state: WindowState): string {
  return JSON.stringify(state, null, 2);
}

function visibleOn(bounds: WindowBounds, display: WindowBounds): boolean {
  const w =
    Math.min(bounds.x + bounds.width, display.x + display.width) -
    Math.max(bounds.x, display.x);
  const h =
    Math.min(bounds.y + bounds.height, display.y + display.height) -
    Math.max(bounds.y, display.y);
  return w >= MIN_VISIBLE_PX && h >= MIN_VISIBLE_PX;
}

// bounds: null means "no trustworthy position — center a default window".
// A saved position off every current display (monitor unplugged, resolution
// change) resets rather than opening an unreachable window.
export function planWindowPlacement(
  state: WindowState | null,
  displays: WindowBounds[],
): { bounds: WindowBounds | null; isMaximized: boolean } {
  if (!state) return { bounds: null, isMaximized: false };
  const onScreen = displays.some((display) => visibleOn(state.bounds, display));
  return onScreen
    ? { bounds: state.bounds, isMaximized: state.isMaximized }
    : { bounds: null, isMaximized: state.isMaximized };
}

// Trailing-edge debounce for resize/move bursts; flush() runs a pending save
// immediately (used on close so the last geometry is never lost).
export function createDebouncedSaver(
  save: () => void,
  delayMs: number,
): { schedule(): void; flush(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        save();
      }, delayMs);
    },
    flush() {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      save();
    },
  };
}
