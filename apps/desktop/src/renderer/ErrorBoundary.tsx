import { Component, type ErrorInfo, type ReactNode } from "react";
import { DohcMark } from "@dohc/brand";
import { requestGuardedReload } from "./RecoveryCloseGuard";

// Crash containment for the renderer. React unmounts the ENTIRE tree when a
// render/lifecycle error reaches the root with no boundary — the user sees a
// permanently blank window ("the app broke"). Two layers stop that:
//
//   1. Scoped <ErrorBoundary> around each risky island (editor area, side
//      panel, chats/history rail): one island crashing renders a small inline
//      "this view hit an error" card with a Try again affordance while the
//      REST of the app keeps working. `resetKeys` clear the error when the
//      user navigates away (switch tab/view) — the crashed render is gone, so
//      the next one gets a clean start.
//   2. The app-level <AppErrorBoundary> (main.tsx) as the last line: a
//      branded full-window recovery screen with a Reload button — never a
//      blank window, whatever threw.
//
// Both log through the existing console path (main/e2e capture stderr and
// pageerror), including React's component stack.

function reportBoundaryError(scope: string, error: unknown, info?: ErrorInfo) {
  console.error(
    `[desktop] renderer crash contained by the "${scope}" boundary:`,
    error,
    info?.componentStack ?? "",
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function arraysDiffer(a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): boolean {
  return a.length !== b.length || a.some((value, index) => !Object.is(value, b[index]));
}

type ErrorBoundaryProps = {
  // Names the island in logs and testids ("editor", "side-panel", "rail").
  scope: string;
  // When any of these change (e.g. the active tab or view), a shown error is
  // cleared and the children re-render fresh — navigating away recovers.
  resetKeys?: ReadonlyArray<unknown>;
  children: ReactNode;
};

type ErrorBoundaryState = { error: unknown; hasError: boolean };

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, hasError: false };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error, hasError: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    reportBoundaryError(this.props.scope, error, info);
  }

  override componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (
      this.state.hasError &&
      arraysDiffer(prev.resetKeys ?? [], this.props.resetKeys ?? [])
    ) {
      this.setState({ error: null, hasError: false });
    }
  }

  private reset = () => {
    this.setState({ error: null, hasError: false });
  };

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        data-testid={`error-boundary-${this.props.scope}`}
        role="alert"
        className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-2 bg-bg px-6 py-8 text-center"
      >
        <span className="text-sm font-semibold text-ink">
          This view ran into a problem
        </span>
        <span className="max-w-md break-words text-xs leading-relaxed text-muted">
          {errorMessage(this.state.error)}
        </span>
        <span className="max-w-md text-[11px] text-subtle">
          The rest of dohc keeps working. Try again, or switch to another
          file or view.
        </span>
        <button
          type="button"
          data-testid={`error-boundary-${this.props.scope}-retry`}
          onClick={this.reset}
          className="mt-1 cursor-pointer rounded border border-line px-3 py-1 text-xs text-muted hover:bg-line/50 hover:text-ink"
        >
          Try again
        </button>
      </div>
    );
  }
}

type AppErrorBoundaryState = { error: unknown; hasError: boolean };

// The last line of defense at the root of the tree: whatever escaped every
// scoped boundary lands on a branded full-window recovery screen instead of a
// blank window. Reload restarts the renderer cleanly (workspace state is in
// main / on disk, so nothing is lost).
export class AppErrorBoundary extends Component<
  { children: ReactNode },
  AppErrorBoundaryState
> {
  override state: AppErrorBoundaryState = { error: null, hasError: false };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { error, hasError: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    reportBoundaryError("app", error, info);
  }

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        data-testid="app-crash-screen"
        role="alert"
        className="flex h-screen flex-col items-center justify-center gap-3 bg-bg px-8 text-center"
      >
        <DohcMark size={30} className="text-line" />
        <span className="text-sm font-semibold text-ink">
          something went wrong
        </span>
        <span className="max-w-lg break-words text-xs leading-relaxed text-muted">
          {errorMessage(this.state.error)}
        </span>
        <span className="max-w-lg text-[11px] text-subtle">
          Your files are safe on disk. Reload to pick up where you left off.
        </span>
        <button
          type="button"
          data-testid="app-crash-reload"
          // Through the guard, so a blocked reload resumes as a RELOAD — the
          // set-aside-draft warning must not turn it into an exit (#579
          // review, r7).
          onClick={requestGuardedReload}
          className="mt-1 cursor-pointer rounded border border-line px-3 py-1 text-xs font-semibold text-muted hover:bg-line/50 hover:text-ink"
        >
          Reload dohc
        </button>
      </div>
    );
  }
}

// Global reporters for errors React never sees: uncaught exceptions outside
// render (event handlers, timers) and unhandled promise rejections. They do
// NOT blank the app by themselves, but silently swallowing them hides the
// exact failures that precede "it just went blank" reports — log them through
// the same console path everything else uses (captured by e2e pageerror /
// main stderr).
export function installGlobalErrorReporters(target: Window = window): void {
  target.addEventListener("error", (event) => {
    console.error("[desktop] uncaught renderer error:", event.error ?? event.message);
  });
  target.addEventListener("unhandledrejection", (event) => {
    console.error("[desktop] unhandled promise rejection:", event.reason);
  });
}
