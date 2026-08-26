import {
  Suspense,
  lazy,
  useCallback,
  useMemo,
  useState,
  type ComponentProps,
  type ComponentType,
} from "react";
import { ErrorBoundary } from "../ErrorBoundary";
import type { DesktopSettings } from "./DesktopSettings";

export type DesktopSettingsProps = ComponentProps<typeof DesktopSettings>;
export type DesktopSettingsLoader = () => Promise<{
  default: ComponentType<DesktopSettingsProps>;
}>;

const loadDesktopSettings: DesktopSettingsLoader = () =>
  import("./DesktopSettings").then((mod) => ({
    default: mod.DesktopSettings,
  }));

function SettingsLoading() {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      data-testid="settings-loading"
      className="dohc-elevated flex h-[min(760px,calc(100vh-48px))] w-[min(1040px,calc(100vw-32px))] items-center justify-center overflow-hidden rounded-xl border border-line bg-bg px-4 text-xs text-subtle"
    >
      Loading settings...
    </div>
  );
}

export function LazyDesktopSettings(
  props: DesktopSettingsProps & { loader?: DesktopSettingsLoader },
) {
  const { loader = loadDesktopSettings, ...settingsProps } = props;
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  const Settings = useMemo(() => lazy(loader), [attempt, loader]);

  return (
    <ErrorBoundary
      scope="settings"
      resetKeys={[settingsProps.workspaceId, attempt]}
      onRetry={retry}
      fallbackClassName="dohc-elevated h-[min(760px,calc(100vh-48px))] w-[min(1040px,calc(100vw-32px))] rounded-xl border border-line"
      recoveryMessage="The workspace is still available. Try again."
    >
      <Suspense fallback={<SettingsLoading />}>
        <Settings {...settingsProps} />
      </Suspense>
    </ErrorBoundary>
  );
}
