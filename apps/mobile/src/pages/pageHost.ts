import type { ToPage } from "./liveBridge";
import type { PageLive } from "./pageLive";

// A page's web view and the live session that belongs to it. Each web view the screen mounts is a new `mount`. A
// session opens only for the mounted web view once it has drawn, and posts only to it. The web view that fails or
// leaves ends its session. A session ended from outside (appTeardown) replaces its web view with a read-only one and
// opens no other.

export interface PageHostState {
  /** The mounted web view, as its key. */
  readonly mount: number;
  /** The mounted web view has drawn its text. */
  readonly painted: boolean;
  readonly live: PageLive | null;
  /** A session ended from outside: the page stays read-only. */
  readonly stopped: boolean;
}

export function createPageHost(options: {
  /** Delivers a script to the mounted web view. */
  readonly inject: (script: string) => void;
}) {
  const listeners = new Set<() => void>();
  let state: PageHostState = { mount: 0, painted: false, live: null, stopped: false };
  let unfollow = () => {};
  const set = (next: Partial<PageHostState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  /** Ends the session of a web view that goes. */
  const drop = () => {
    unfollow();
    unfollow = () => {};
    state.live?.end();
  };

  return {
    state: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    painted() {
      if (!state.painted) set({ painted: true });
    },
    /** The mounted web view failed or left the screen. */
    gone() {
      drop();
      if (state.painted || state.live) set({ painted: false, live: null });
    },
    /** A new web view replaces the mounted one. */
    remount() {
      drop();
      set({ mount: state.mount + 1, painted: false, live: null });
    },
    /** Opens the mounted web view's session once it has drawn. */
    open(make: (post: (message: ToPage) => void) => PageLive) {
      if (!state.painted || state.live || state.stopped) return;
      const mount = state.mount;
      const live = make((message) => {
        if (state.mount === mount && state.live === live)
          options.inject(`window.__dohcLive?.(${JSON.stringify(message)}); true;`);
      });
      unfollow = live.subscribe(() => {
        if (live.state().phase !== "ended") return;
        unfollow();
        unfollow = () => {};
        set({ mount: state.mount + 1, painted: false, live: null, stopped: true });
      });
      set({ live });
      live.start();
    },
  };
}
export type PageHost = ReturnType<typeof createPageHost>;
