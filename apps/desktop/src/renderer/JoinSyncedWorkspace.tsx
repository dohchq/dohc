import { useMouseBackButton } from "./useMouseBackButton";
import { isComposingKey } from "./ui/keys";
import { useRequestSequence } from "./useRequestSequence";
import { ipcErrorMessage } from "./ipcError";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { bridge } from "./bridge";
import { CloudLogin } from "./CloudLogin";
import type { Workspace } from "./DesktopWorkspaceShell";
import type { ConnectionNoticeHost } from "./shell/connectionNotices";
import { FieldError, IconButton, PrimaryButton, RetryRow } from "./ui/controls";
import { FolderChip, Step } from "./ui/Step";

// "Join a synced workspace": the second-machine half of multi-machine sync.
// Three real gates, shown as three steps so the whole cost is visible up
// front: sign in, enter the code from the machine that has the workspace,
// pick an empty folder. Joining needs a server session, so step one embeds
// the normal connect panel until one exists.

type Gate =
  | { kind: "checking" }
  // The check itself failed, so dohc does not know whether this machine is
  // signed in. The notice carries the words; step one offers Try again.
  | { kind: "check-failed" }
  | { kind: "signed-out" }
  | { kind: "signed-in"; email: string };

// Each field's error as of its last check, when focus left it or the person
// pressed Join. Editing a field clears its own.
type FieldErrors = { code?: string; folder?: string; passphrase?: string };

const CODE_ERROR = "Enter a workspace code.";
const FOLDER_ERROR = "Choose an empty folder.";
const PASSPHRASE_ERROR = "Enter the protected-file passphrase.";
const WRONG_PASSPHRASE_ERROR = "That passphrase didn't unlock the protected files.";

function isWindows(): boolean {
  return bridge().platform === "win32";
}

function displayPath(path: string): string {
  return isWindows() ? path.replaceAll("/", "\\") : path;
}

export function JoinSyncedWorkspace(props: {
  onWorkspaceReady: (workspace: Workspace) => void;
  onBack: () => void;
} & ConnectionNoticeHost) {
  const [gate, setGate] = useState<Gate>({ kind: "checking" });
  const [code, setCode] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [needsPassphrase, setNeedsPassphrase] = useState(false);
  // The folder a passphrase-less attempt already filled. Its files stay
  // there, so the join needs another empty folder.
  const [usedFolder, setUsedFolder] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [joining, setJoining] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  useMouseBackButton(joining ? undefined : props.onBack);
  const codeField = useRef<HTMLInputElement>(null);
  const folderChip = useRef<HTMLButtonElement>(null);
  const passphraseField = useRef<HTMLInputElement>(null);
  const sessionRef = useRequestSequence();
  // Guards the async join against unmount: if the parent swaps this view
  // away while cloudJoinWorkspace is in flight, the resolved promise must not
  // navigate the app into the joined workspace the user just backed out of.
  const actionRequests = useRequestSequence();

  function checkSession() {
    const session = sessionRef.next();
    setGate({ kind: "checking" });
    void bridge()
      .cloudStatus({})
      .then((status) => {
        if (!sessionRef.isCurrent(session)) return;
        setGate(
          status.connected
            ? { kind: "signed-in", email: status.email ?? "" }
            : { kind: "signed-out" },
        );
      })
      .catch((cause: unknown) => {
        if (!sessionRef.isCurrent(session)) return;
        setGate({ kind: "check-failed" });
        props.onConnectionError?.({
          message: "dohc could not check your server connection.",
          cause,
          serverUrl: null,
          retry: () => {
            if (!sessionRef.isCurrent(session)) return false;
            checkSession();
            return true;
          },
        });
      });
  }

  useEffect(() => {
    checkSession();
    return () => {
      sessionRef.next();
    };
    // Session check runs once on mount; CloudLogin's onConnected re-runs it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The passphrase field appears after a join that needed it, with its error.
  useEffect(() => {
    if (needsPassphrase) passphraseField.current?.focus();
  }, [needsPassphrase]);

  function setFieldError(field: keyof FieldErrors, message: string | undefined) {
    setFieldErrors((errors) => ({ ...errors, [field]: message }));
  }

  async function chooseFolder() {
    const picked = await bridge().pickWorkspaceRoot();
    if (picked) {
      setFolder(picked);
      setFieldError("folder", undefined);
    }
  }

  async function join() {
    if (joining) return;
    const found: FieldErrors = {
      code: code.trim() ? undefined : CODE_ERROR,
      folder: folder ? undefined : FOLDER_ERROR,
      passphrase: !needsPassphrase || passphrase ? undefined : PASSPHRASE_ERROR,
    };
    setFieldErrors(found);
    if (found.code || found.passphrase || found.folder || !folder) {
      if (found.code) codeField.current?.focus();
      else if (found.passphrase) passphraseField.current?.focus();
      else folderChip.current?.focus();
      return;
    }
    const actionRequest = actionRequests.next();
    setJoining(true);
    setError(null);
    try {
      const result = await bridge().cloudJoinWorkspace({
        syncCode: code.trim(),
        rootPath: folder,
        ...(needsPassphrase ? { passphrase } : {}),
      });
      if (!actionRequests.isCurrent(actionRequest)) return;
      props.onWorkspaceReady(result.workspace);
    } catch (cause) {
      if (!actionRequests.isCurrent(actionRequest)) return;
      const message = ipcErrorMessage(cause, "Couldn't join the workspace.");
      const required = /passphrase required to unlock synced secrets/i.test(message);
      const wrong = /^Passphrase could not\b/u.test(message);
      if (required || wrong) {
        // Either way the attempt filled this folder, so the retry needs another.
        setNeedsPassphrase(true);
        setUsedFolder(folder);
        setFolder(null);
        setFieldErrors({ passphrase: wrong ? WRONG_PASSPHRASE_ERROR : PASSPHRASE_ERROR });
        // Selected, so typing replaces the passphrase that failed.
        passphraseField.current?.focus();
        passphraseField.current?.select();
      } else {
        setError(message);
      }
    } finally {
      if (actionRequests.isCurrent(actionRequest)) setJoining(false);
    }
  }

  function onEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && !isComposingKey(event)) void join();
  }

  const signedIn = gate.kind === "signed-in";
  // Both fields stay visible and editable after sign-in.
  const fieldState = signedIn ? "current" : "pending";

  return (
    <div
      data-testid="join-synced-workspace"
      className="dohc-elevated flex w-105 flex-col gap-5 rounded-xl border border-line bg-panel p-5"
    >
      <div className="flex items-center gap-2">
        {/* Gated while a join is in flight: the request cannot be cancelled. */}
        <IconButton
          aria-label="Back"
          disabled={joining}
          onClick={props.onBack}
          className="shrink-0"
        >
          <ArrowLeft size={13} aria-hidden />
        </IconButton>
        <h2 className="m-0 text-base font-semibold text-ink">Join a synced workspace</h2>
      </div>

      {/* Not a <form>: the embedded sign-in panel owns one, and nested forms
          collapse so Connect would submit the join instead. Enter in either
          join field submits through onKeyDown. */}
      <div className="flex flex-col">
        <Step
          number={1}
          title="Connect your server"
          state={gate.kind === "signed-in" ? "done" : "current"}
          summary={gate.kind === "signed-in" ? gate.email : undefined}
        >
          {gate.kind === "checking" ? (
            <p className="m-0 text-xs text-subtle">Checking your server connection…</p>
          ) : gate.kind === "check-failed" ? (
            <RetryRow testId="join-check-failed" onRetry={checkSession} />
          ) : (
            <>
              <p className="sr-only">Connect your server first, then enter the code from your other machine.</p>
              <CloudLogin
                onConnected={checkSession}
                embedded
                untitled
                onConnectionError={props.onConnectionError}
                initialServerUrl={props.initialServerUrl}
              />
            </>
          )}
        </Step>

        <Step
          number={2}
          title="Enter the code from your other machine"
          state={fieldState}
          labelFor="join-sync-code"
        >
          <input
            ref={codeField}
            id="join-sync-code"
            data-testid="join-sync-code"
            value={code}
            onChange={(event) => {
              setCode(event.currentTarget.value);
              setNeedsPassphrase(false);
              setUsedFolder(null);
              setPassphrase("");
              setFieldErrors(({ folder: folderError }) => ({ folder: folderError }));
              setError(null);
            }}
            onBlur={() => setFieldError("code", code.trim() ? undefined : CODE_ERROR)}
            aria-invalid={fieldErrors.code ? true : undefined}
            aria-describedby={fieldErrors.code ? "join-sync-code-error" : undefined}
            placeholder="dohc-sync:…"
            spellCheck={false}
            onKeyDown={onEnter}
            className={`h-9 w-full rounded-md border bg-bg px-3 font-mono text-[13px] text-ink placeholder:text-subtle ${fieldErrors.code ? "border-danger focus:border-danger!" : "border-line focus:border-ink"}`}
          />
          {fieldErrors.code ? (
            <FieldError id="join-sync-code-error">{fieldErrors.code}</FieldError>
          ) : null}
          {needsPassphrase ? (
            <>
              <label htmlFor="join-sync-passphrase" className="w-fit text-[12px] text-muted">
                Protected-file passphrase
              </label>
              <input
                ref={passphraseField}
                id="join-sync-passphrase"
                data-testid="join-sync-passphrase"
                value={passphrase}
                type="password"
                spellCheck={false}
                onChange={(event) => {
                  setPassphrase(event.currentTarget.value);
                  setFieldError("passphrase", undefined);
                }}
                // Adds only the empty error: one that failed to unlock stays until edited.
                onBlur={() => {
                  if (!passphrase) setFieldError("passphrase", PASSPHRASE_ERROR);
                }}
                aria-invalid={fieldErrors.passphrase ? true : undefined}
                aria-describedby={fieldErrors.passphrase ? "join-sync-passphrase-error" : undefined}
                onKeyDown={onEnter}
                className={`h-9 w-full rounded-md border bg-bg px-3 text-[13px] text-ink placeholder:text-subtle ${fieldErrors.passphrase ? "border-danger focus:border-danger!" : "border-line focus:border-ink"}`}
              />
              {fieldErrors.passphrase ? (
                <FieldError id="join-sync-passphrase-error">{fieldErrors.passphrase}</FieldError>
              ) : null}
            </>
          ) : null}
        </Step>

        <Step number={3} title="Choose an empty folder on this machine" state={fieldState} last>
          <FolderChip
            ref={folderChip}
            folder={folder ? displayPath(folder) : null}
            placeholder={usedFolder ? "Choose another empty folder" : "Choose an empty folder"}
            testId="join-choose-folder"
            errorId={fieldErrors.folder ? "join-choose-folder-error" : undefined}
            onClick={() => void chooseFolder()}
          />
          {fieldErrors.folder ? (
            <FieldError id="join-choose-folder-error">{fieldErrors.folder}</FieldError>
          ) : null}
          {usedFolder ? (
            <p data-testid="join-used-folder" className="m-0 text-xs text-muted">
              Files stay in {displayPath(usedFolder)}.
            </p>
          ) : null}

          {error ? (
            <p data-testid="join-error" role="alert" className="m-0 text-xs leading-relaxed text-danger">
              {error}
            </p>
          ) : null}
          <PrimaryButton
            type="button"
            data-testid="join-workspace-start"
            onClick={() => void join()}
            disabled={joining}
            className="mt-2"
          >
            {joining ? "Joining…" : "Join workspace"}
          </PrimaryButton>
        </Step>
      </div>
    </div>
  );
}
