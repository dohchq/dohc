import {
  Component,
  type ErrorInfo,
  type ReactNode,
} from "react";

type EditorErrorBoundaryProps = {
  children: ReactNode;
  resetKey: string;
};

type EditorErrorBoundaryState = {
  failed: boolean;
};

export class EditorErrorBoundary extends Component<
  EditorErrorBoundaryProps,
  EditorErrorBoundaryState
> {
  state: EditorErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): EditorErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[dohc] editor recovered from a rendering error", error, info);
  }

  componentDidUpdate(previousProps: EditorErrorBoundaryProps): void {
    if (this.state.failed && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <div
        className="flex min-h-48 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
        data-testid="editor-crash-recovery"
      >
        <p className="text-sm font-medium text-ink">This document hit an editor error.</p>
        <p className="max-w-md text-xs text-muted">
          Your workspace is still running. Retry the editor, or switch documents and come
          back.
        </p>
        <button
          type="button"
          className="rounded-md border border-line bg-panel px-3 py-1.5 text-xs text-ink hover:bg-panel-2"
          onClick={() => this.setState({ failed: false })}
        >
          Retry editor
        </button>
      </div>
    );
  }
}
