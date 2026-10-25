import {
  Suspense,
  lazy,
  useCallback,
  useMemo,
  useState,
  type ComponentProps,
  type ComponentType,
} from "react";
import { X } from "lucide-react";
import { ErrorBoundary } from "../ErrorBoundary";
import { SkeletonRows } from "../ui/SkeletonRows";
import type { SettingsDialog } from "./SettingsDialog";

export type DesktopSettingsProps = ComponentProps<typeof SettingsDialog>;
type DesktopSettingsLoader = () => Promise<{
  default: ComponentType<DesktopSettingsProps>;
}>;

// Settings once its chunk has loaded. A fresh React.lazy suspends on its first
// render even when the module is already loaded, and React holds that reveal
// for up to 300ms, so every reopen flashed the loading skeleton.
let loadedSettings: ComponentType<DesktopSettingsProps> | null = null;

const loadDesktopSettings: DesktopSettingsLoader = () =>
  import("./SettingsDialog").then((mod) => {
    loadedSettings = mod.SettingsDialog;
    return { default: mod.SettingsDialog };
  });

// Where loaded Settings puts its own X, so the way out never moves.
function CloseSettings(props: { onClose: () => void }) {
  return (
    <button
      type="button"
      aria-label="Close settings"
      title="Close settings"
      onClick={props.onClose}
      className="absolute right-3 top-3 grid size-7 place-items-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-ink"
    >
      <X size={16} aria-hidden />
    </button>
  );
}

function SettingsLoading(props: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      data-testid="settings-loading"
      className="dohc-elevated relative flex h-[min(760px,calc(100vh-112px))] w-[min(1040px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border border-line bg-bg p-2"
    >
      <SkeletonRows layout="panel" label="Loading settings..." />
      <CloseSettings onClose={props.onClose} />
    </div>
  );
}

export function LazyDesktopSettings(
  props: DesktopSettingsProps & { loader?: DesktopSettingsLoader },
) {
  const { loader = loadDesktopSettings, ...settingsProps } = props;
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  const Settings = useMemo(
    () => (loader === loadDesktopSettings ? loadedSettings : null) ?? lazy(loader),
    [attempt, loader],
  );

  return (
    <ErrorBoundary
      scope="settings"
      resetKeys={[settingsProps.workspaceId, attempt]}
      onRetry={retry}
      fallbackClassName="dohc-elevated relative h-[min(760px,calc(100vh-112px))] w-[min(1040px,calc(100vw-32px))] rounded-xl border border-line"
      recoveryMessage="The workspace is still available. Try again."
      closeControl={<CloseSettings onClose={settingsProps.onClose} />}
    >
      <Suspense fallback={<SettingsLoading onClose={settingsProps.onClose} />}>
        <Settings {...settingsProps} />
      </Suspense>
    </ErrorBoundary>
  );
}
