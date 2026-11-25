import { X } from "lucide-react";
import { useId } from "react";
import type { PrivacySettings } from "../../settings/userSettings";
import { Overlay } from "../Overlay";
import { ReportsSettings } from "./ReportsSettings";
import { SettingsSection } from "./SettingRow";

export function ReportsPrivacyDialog(props: {
  privacy: PrivacySettings;
  onChange(privacy: PrivacySettings): void;
  onError(message: string, cause?: unknown): void;
  onClose(): void;
}) {
  const titleId = useId();
  return (
    <Overlay
      onClose={props.onClose}
      panelProps={{
        role: "dialog",
        "aria-modal": true,
        "aria-labelledby": titleId,
      }}
    >
      <div
        data-testid="first-run-privacy-dialog"
        className="dohc-elevated relative -mb-[var(--dohc-toast-room,0px)] flex max-h-[calc(100vh-112px)] w-[min(600px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border border-line bg-bg text-ink"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-6 py-4">
          <h2 id={titleId} className="m-0 text-base font-semibold text-ink">
            Privacy
          </h2>
          <button
            type="button"
            aria-label="Close privacy settings"
            title="Close privacy settings"
            onClick={props.onClose}
            className="grid size-7 place-items-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-ink"
          >
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <SettingsSection title="Reports">
            <ReportsSettings
              privacy={props.privacy}
              onChange={props.onChange}
              onError={props.onError}
            />
          </SettingsSection>
        </div>
      </div>
    </Overlay>
  );
}
