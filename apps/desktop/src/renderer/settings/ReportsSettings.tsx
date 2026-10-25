import { useEffect, useRef, useState } from "react";
import type { ReadDiagnosticsResult } from "../../ipc/bridgeContract";
import { DEFAULT_PRIVACY_SETTINGS, type PrivacySettings } from "../../settings/userSettings";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { CopyButton } from "../ui/CopyButton";
import { SettingRow, SwitchControl } from "./SettingRow";

const BUTTON =
  "h-8 rounded-lg border border-line bg-transparent px-3 text-[13px] text-muted transition-colors hover:bg-hover hover:text-ink";

/**
 * The report switches, which apply to this computer, and the diagnostics a
 * person can read, copy, or save. Main sends a kind of report only when this
 * launch can reach its service, and only while its switch is on.
 */
export function ReportsSettings(props: {
  privacy: PrivacySettings;
  onChange(privacy: PrivacySettings): void;
  onError?: ((message: string, cause?: unknown) => void) | undefined;
}) {
  const [diagnostics, setDiagnostics] = useState<ReadDiagnosticsResult | null>(null);
  const [shown, setShown] = useState(false);
  const onError = useRef(props.onError);
  onError.current = props.onError;

  // The text names the switches, so it is read again when they change.
  // Latest wins, so an older read never repaints a newer one.
  useEffect(() => {
    let current = true;
    void bridge()
      .readDiagnostics({})
      .then((result) => {
        if (current) setDiagnostics(result);
      })
      .catch((cause: unknown) => {
        if (current) onError.current?.(ipcErrorMessage(cause, "dohc could not read diagnostics."), cause);
      });
    return () => {
      current = false;
    };
  }, [props.privacy]);

  const unavailable = (available: boolean | undefined) => available === false ? " Unavailable for this launch." : "";
  const save = async () => {
    try {
      await bridge().saveDiagnostics({});
    } catch (cause) {
      props.onError?.(ipcErrorMessage(cause, "dohc could not save diagnostics."), cause);
    }
  };

  return (
    <>
      <SettingRow
        title="Send usage reports"
        description={`Counts when you open dohc, create or open a workspace, share, publish an app, or send a chat message. Includes a random ID for this installation. No names, content, or links.${unavailable(diagnostics?.available.usage)}`}
        modified={props.privacy.usageReports !== DEFAULT_PRIVACY_SETTINGS.usageReports}
        onReset={() => props.onChange({ ...props.privacy, usageReports: DEFAULT_PRIVACY_SETTINGS.usageReports })}
        testId="settings-row-usage-reports"
      >
        <SwitchControl
          label="Send usage reports"
          checked={props.privacy.usageReports}
          onChange={(usageReports) => props.onChange({ ...props.privacy, usageReports })}
        />
      </SettingRow>
      <SettingRow
        title="Send error reports"
        description={`Sends an error's type and where in dohc's code it happened. No messages, file names, or other paths.${unavailable(diagnostics?.available.errors)}`}
        modified={props.privacy.errorReports !== DEFAULT_PRIVACY_SETTINGS.errorReports}
        onReset={() => props.onChange({ ...props.privacy, errorReports: DEFAULT_PRIVACY_SETTINGS.errorReports })}
        testId="settings-row-error-reports"
      >
        <SwitchControl
          label="Send error reports"
          checked={props.privacy.errorReports}
          onChange={(errorReports) => props.onChange({ ...props.privacy, errorReports })}
        />
      </SettingRow>
      <SettingRow
        title="Diagnostics"
        description="Version, system, report settings, and recent problems. They stay on this computer until you copy or save them."
        testId="settings-row-diagnostics"
      >
        <button
          type="button"
          aria-expanded={shown}
          aria-controls="settings-diagnostics-text"
          data-testid="diagnostics-show"
          onClick={() => setShown((value) => !value)}
          className={BUTTON}
        >
          {shown ? "Hide" : "Show"}
        </button>
        <CopyButton
          label="Copy diagnostics"
          testId="diagnostics-copy"
          getText={async () => (await bridge().readDiagnostics({})).text}
        />
        <button type="button" data-testid="diagnostics-save" onClick={() => void save()} className={BUTTON}>
          Save…
        </button>
      </SettingRow>
      {shown ? (
        <pre
          id="settings-diagnostics-text"
          data-testid="diagnostics-text"
          tabIndex={0}
          className="mb-3 max-h-72 select-text overflow-auto whitespace-pre-wrap rounded-md bg-panel-2 p-3 font-mono text-[11px] leading-relaxed text-ink"
        >
          {diagnostics?.text ?? ""}
        </pre>
      ) : null}
    </>
  );
}
