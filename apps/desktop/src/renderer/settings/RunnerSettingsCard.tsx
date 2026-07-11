import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { FlaskConical, Terminal } from "lucide-react";
import type { RunnerSelfTestResult } from "../../ipc/bridgeContract";
import type { RunnerSettings } from "../../settings/userSettings";
import { bridge } from "../bridge";
import { SwitchControl } from "./SettingRow";

const RUNNER_COMMAND_PLACEHOLDER =
  'claude -p --permission-mode acceptEdits --allowedTools "Bash(dohc chat:*)"';

type SelfTestState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "success" | "error"; detail: string };

function validTimeoutMinutes(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 1440
    ? parsed
    : fallback;
}

function runnerSettingsEqual(left: RunnerSettings, right: RunnerSettings): boolean {
  return (
    left.command === right.command &&
    left.enabled === right.enabled &&
    left.timeoutMinutes === right.timeoutMinutes
  );
}

export function RunnerSettingsCard(props: {
  workspaceId: string;
  runner: RunnerSettings;
  onRunnerChange: (runner: RunnerSettings) => Promise<void>;
}) {
  const { workspaceId, runner, onRunnerChange } = props;
  const [commandDraft, setCommandDraft] = useState(runner.command);
  const [timeoutDraft, setTimeoutDraft] = useState(String(runner.timeoutMinutes));
  const [selfTest, setSelfTest] = useState<SelfTestState>({ status: "idle" });
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const requestVersionRef = useRef(0);

  useEffect(() => {
    setCommandDraft(runner.command);
  }, [runner.command]);

  useEffect(() => {
    setTimeoutDraft(String(runner.timeoutMinutes));
  }, [runner.timeoutMinutes]);

  useEffect(() => {
    requestVersionRef.current += 1;
    setSelfTest({ status: "idle" });
    return () => {
      requestVersionRef.current += 1;
    };
  }, [workspaceId]);

  const queueSave = useCallback(
    (next: RunnerSettings): Promise<void> => {
      const queued = saveQueueRef.current
        .catch(() => undefined)
        .then(() => onRunnerChange(next));
      saveQueueRef.current = queued;
      return queued;
    },
    [onRunnerChange],
  );

  const commitDrafts = useCallback(
    (enabled = runner.enabled): Promise<void> => {
      const timeoutMinutes = validTimeoutMinutes(
        timeoutDraft,
        runner.timeoutMinutes,
      );
      const command = commandDraft.trim();
      const next: RunnerSettings = {
        command,
        enabled,
        timeoutMinutes,
      };
      setCommandDraft(command);
      setTimeoutDraft(String(timeoutMinutes));
      return runnerSettingsEqual(next, runner)
        ? saveQueueRef.current
        : queueSave(next);
    },
    [commandDraft, queueSave, runner, timeoutDraft],
  );

  const handleInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") event.currentTarget.blur();
    },
    [],
  );

  const runSelfTest = useCallback(async () => {
    const version = requestVersionRef.current;
    setSelfTest({ status: "running" });
    try {
      await commitDrafts();
      const result: RunnerSelfTestResult = await bridge().runnerSelfTest({
        workspaceId,
      });
      if (requestVersionRef.current !== version) return;
      setSelfTest({
        status: result.ok ? "success" : "error",
        detail: result.detail,
      });
    } catch (cause) {
      if (requestVersionRef.current !== version) return;
      setSelfTest({
        status: "error",
        detail:
          cause instanceof Error && cause.message
            ? cause.message
            : "Runner self-test could not start.",
      });
    }
  }, [commitDrafts, workspaceId]);

  const configured = commandDraft.trim().length > 0;
  const selfTestRunning = selfTest.status === "running";

  return (
    <section
      data-testid="runner-settings-card"
      className="my-4 overflow-hidden rounded-lg border border-line bg-panel-2"
      aria-labelledby="runner-settings-title"
    >
      <div className="flex items-start gap-3 border-b border-line px-4 py-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-line bg-bg text-ink">
          <Terminal size={14} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3
              id="runner-settings-title"
              className="m-0 text-[13px] font-medium text-ink"
            >
              Chat runner
            </h3>
            <span
              data-testid="runner-configuration-status"
              data-state={runner.enabled && configured ? "active" : "inactive"}
              className="rounded-full border border-line bg-bg px-2 py-0.5 text-[10px] uppercase tracking-wide text-subtle"
            >
              {runner.enabled && configured ? "Dispatch on" : "Dispatch off"}
            </span>
          </div>
          <p className="m-0 mt-1 text-[11px] leading-relaxed text-muted">
            Run your local agent harness when a chat message is addressed to your
            agent.
          </p>
        </div>
      </div>

      <div className="px-4 py-3">
        <label
          htmlFor="runner-command"
          className="text-[11px] font-medium text-ink"
        >
          Runner command
        </label>
        <input
          id="runner-command"
          data-testid="runner-command-input"
          value={commandDraft}
          maxLength={4096}
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="off"
          placeholder={RUNNER_COMMAND_PLACEHOLDER}
          onChange={(event) => setCommandDraft(event.currentTarget.value)}
          onBlur={() => void commitDrafts()}
          onKeyDown={handleInputKeyDown}
          className="mt-1 w-full rounded-md border border-line bg-bg px-3 py-2 font-mono text-[11px] text-ink placeholder:text-subtle focus:border-ink"
        />
        <p className="m-0 mt-1.5 text-[10px] leading-relaxed text-subtle">
          The prompt is appended to this command when a run starts. Double quotes
          are supported for grouped arguments.
        </p>
      </div>

      <div className="grid grid-cols-2 border-y border-line max-[720px]:grid-cols-1">
        <div className="flex items-center justify-between gap-3 border-r border-line px-4 py-3 max-[720px]:border-b max-[720px]:border-r-0">
          <div>
            <p className="m-0 text-[11px] font-medium text-ink">Enable dispatch</p>
            <p className="m-0 mt-0.5 text-[10px] text-subtle">
              Runs in the background.
            </p>
          </div>
          <SwitchControl
            label="Enable chat runner"
            checked={runner.enabled}
            disabled={!configured && !runner.enabled}
            onChange={(enabled) => {
              if (enabled && !configured) return;
              void commitDrafts(enabled);
            }}
          />
        </div>

        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div>
            <label
              htmlFor="runner-timeout"
              className="text-[11px] font-medium text-ink"
            >
              Run timeout
            </label>
            <p className="m-0 mt-0.5 text-[10px] text-subtle">
              Minutes before the run is stopped.
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              spellCheck={false}
              id="runner-timeout"
              data-testid="runner-timeout-input"
              type="number"
              inputMode="numeric"
              min={1}
              max={1440}
              step={1}
              value={timeoutDraft}
              onChange={(event) => setTimeoutDraft(event.currentTarget.value)}
              onBlur={() => void commitDrafts()}
              onKeyDown={handleInputKeyDown}
              className="w-16 rounded-md border border-line bg-bg px-2 py-1.5 text-right text-[11px] text-ink focus:border-ink"
            />
            <span className="text-[10px] text-subtle">min</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 px-4 py-3 max-[720px]:items-start max-[720px]:flex-col">
        <div className="min-w-0 flex-1">
          <p className="m-0 text-[10px] leading-relaxed text-muted">
            Use a sandboxed runner command. An unsandboxed runner can read anything on
            this machine.
          </p>
          <p
            data-testid="runner-multi-device-note"
            className="m-0 mt-1 text-[10px] leading-relaxed text-subtle"
          >
            Enable the runner on one device per workspace — multiple enabled devices
            will each run tasks independently.
          </p>
        </div>
        <button
          type="button"
          data-testid="runner-self-test-button"
          disabled={!configured || selfTestRunning}
          onClick={() => void runSelfTest()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <FlaskConical size={13} aria-hidden />
          {selfTestRunning ? "Testing..." : "Test runner"}
        </button>
      </div>

      {selfTest.status === "success" || selfTest.status === "error" ? (
        <p
          data-testid="runner-self-test-result"
          data-state={selfTest.status}
          role={selfTest.status === "error" ? "alert" : "status"}
          className={`m-0 border-t border-line px-4 py-2 text-[11px] ${
            selfTest.status === "success" ? "text-success" : "text-danger"
          }`}
        >
          {selfTest.detail}
        </p>
      ) : null}
    </section>
  );
}
