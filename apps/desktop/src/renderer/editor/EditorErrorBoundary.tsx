import {
  Component,
  type ErrorInfo,
  type ReactNode,
} from "react";
import type { MarkdownNestingRefusal } from "@dohc/ydoc-projection";
import { reportRendererError } from "../rendererErrorReport";

type EditorErrorBoundaryProps = {
  children: ReactNode;
  resetKey: string;
  // What shows instead of the editor for a note the live document contract
  // does not read as rich text, so the note is not rendered again.
  refused?: (limit: MarkdownNestingRefusal["limit"]) => ReactNode;
};

type EditorErrorBoundaryState = {
  failed: boolean;
  refused: MarkdownNestingRefusal["limit"] | null;
};

// Read by name, so the boundary does not load the projection's parser.
function refusedLimit(error: unknown): MarkdownNestingRefusal["limit"] | null {
  if (!(error instanceof Error) || error.name !== "MarkdownNestingRefusal") return null;
  const { limit } = error as MarkdownNestingRefusal;
  return limit === "depth" || limit === "lexing" ? limit : null;
}

export class EditorErrorBoundary extends Component<
  EditorErrorBoundaryProps,
  EditorErrorBoundaryState
> {
  state: EditorErrorBoundaryState = { failed: false, refused: null };

  static getDerivedStateFromError(error: unknown): EditorErrorBoundaryState {
    return { failed: true, refused: refusedLimit(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (refusedLimit(error) && this.props.refused) return;
    console.error("[dohc] editor recovered from a rendering error", error, info);
    reportRendererError("boundary", error);
  }

  componentDidUpdate(previousProps: EditorErrorBoundaryProps): void {
    if (this.state.failed && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ failed: false, refused: null });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    if (this.state.refused && this.props.refused) return this.props.refused(this.state.refused);

    return (
      <div
        className="flex min-h-48 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
        data-testid="editor-crash-recovery"
      >
        <p className="text-sm font-medium text-ink">The editor could not render this document.</p>
        <p className="max-w-md text-xs text-muted">
          Your workspace is still running. Try rendering this document again, or switch
          documents and come back.
        </p>
        <button
          type="button"
          className="rounded-md border border-line bg-panel px-3 py-1.5 text-xs text-ink hover:bg-hover"
          onClick={() => this.setState({ failed: false, refused: null })}
        >
          Render again
        </button>
      </div>
    );
  }
}
