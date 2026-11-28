import type { ToPage } from "./liveBridge";
import type { PageLive } from "./pageLive";

// A page's web view and the live session that belongs to it. A session opens only for the mounted web view once it
// has drawn, and posts only to it. `end`, from the account's teardown, works before any session exists: the page stays
// read-only from then on.

interface PageHostState {
  /** The mounted web view, as its key. */
  readonly mount: number;
  /** The mounted web view has drawn its text. */
  readonly painted: boolean;
  readonly live: PageLive | null;
  /** Ended from outside: the page stays read-only. */
  readonly stopped: boolean;
}

export function createPageHost(options: {
  /** Delivers a script to the mounted web view. */
  readonly inject: (script: string) => void;
}) {
  const listeners = new Set<() => void>();
  let state: PageHostState = { mount: 0, painted: false, live: null, stopped: false };
  const set = (next: Partial<PageHostState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  return {
    state: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** The web view mounted as `mount` has drawn. A late report from an earlier one changes nothing. */
    painted(mount: number) {
      if (mount === state.mount && !state.painted) set({ painted: true });
    },
    /** The mounted web view failed, left the screen, or is replaced. The next one is a new mount. */
    gone(): Promise<void> {
      const closed = state.live?.end() ?? Promise.resolve();
      set({ mount: state.mount + 1, painted: false, live: null });
      return closed;
    },
    /** Ends the session, if any, and replaces the web view with a read-only one that opens none. */
    end() {
      if (state.stopped) return;
      void state.live?.end();
      set({ mount: state.mount + 1, painted: false, live: null, stopped: true });
    },
    /** Opens the mounted web view's session once it has drawn. */
    open(make: (post: (message: ToPage) => void) => PageLive) {
      if (!state.painted || state.live || state.stopped) return;
      const mount = state.mount;
      const live = make((message) => {
        if (state.mount === mount && state.live === live)
          options.inject(`window.__dohcLive?.(${JSON.stringify(message)}); true;`);
      });
      set({ live });
      live.start();
    },
  };
}
