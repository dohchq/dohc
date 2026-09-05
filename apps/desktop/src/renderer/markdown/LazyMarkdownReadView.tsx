import {
  Suspense,
  lazy,
  useCallback,
  useMemo,
  useState,
  type ComponentType,
} from "react";
import { ErrorBoundary } from "../ErrorBoundary";
import type { MarkdownReadViewProps } from "./IncrementalMarkdownDocument";

type MarkdownReadViewLoader = () => Promise<{
  default: ComponentType<MarkdownReadViewProps>;
}>;

const loadMarkdownReadView: MarkdownReadViewLoader = () =>
  import("./IncrementalMarkdownDocument");

export function LazyMarkdownReadView(
  props: MarkdownReadViewProps & {
    loader?: MarkdownReadViewLoader;
    resetKey: string;
  },
) {
  const { loader = loadMarkdownReadView, resetKey, ...viewProps } = props;
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  const ReadView = useMemo(() => lazy(loader), [attempt, loader]);

  return (
    <ErrorBoundary
      scope="markdown-read-view"
      resetKeys={[resetKey, attempt]}
      onRetry={retry}
    >
      <Suspense
        fallback={
          <div
            data-testid="markdown-read-loading"
            className="flex min-h-48 flex-1 items-center justify-center text-xs text-subtle"
          >
            Loading document...
          </div>
        }
      >
        <ReadView {...viewProps} />
      </Suspense>
    </ErrorBoundary>
  );
}
