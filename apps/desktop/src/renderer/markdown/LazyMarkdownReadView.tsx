import {
  Suspense,
  lazy,
  useCallback,
  useMemo,
  useState,
  type ComponentType,
} from "react";
import { ErrorBoundary } from "../ErrorBoundary";
import { SkeletonRows } from "../ui/SkeletonRows";
import type { MarkdownReadViewProps } from "./IncrementalMarkdownDocument";

type MarkdownReadViewLoader = () => Promise<{
  default: ComponentType<MarkdownReadViewProps>;
}>;

// The read view once its chunk has loaded. A fresh React.lazy suspends on its
// first render even when the module is already loaded, and React holds that
// reveal for up to 300ms, so every open waited for a module it had.
let loadedReadView: ComponentType<MarkdownReadViewProps> | null = null;

const loadMarkdownReadView: MarkdownReadViewLoader = () =>
  import("./IncrementalMarkdownDocument").then((mod) => {
    loadedReadView = mod.default;
    return mod;
  });

export function LazyMarkdownReadView(
  props: MarkdownReadViewProps & {
    loader?: MarkdownReadViewLoader;
    resetKey: string;
  },
) {
  const { loader = loadMarkdownReadView, resetKey, ...viewProps } = props;
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  const ReadView = useMemo(
    () => (loader === loadMarkdownReadView ? loadedReadView : null) ?? lazy(loader),
    [attempt, loader],
  );

  return (
    <ErrorBoundary
      scope="markdown-read-view"
      resetKeys={[resetKey, attempt]}
      onRetry={retry}
    >
      <Suspense
        fallback={
          <SkeletonRows testId="markdown-read-loading" label="Loading document..." className="min-h-48" />
        }
      >
        <ReadView {...viewProps} />
      </Suspense>
    </ErrorBoundary>
  );
}
