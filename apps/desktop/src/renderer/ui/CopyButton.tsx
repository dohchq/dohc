import { useContext, type ComponentProps, type ReactNode } from "react";
import { withErrorWords } from "../../ipc/errorWords";
import { ShellErrorReporter } from "../shell/useShellError";
import { PrimaryButton } from "./controls";
import { CopyButtonPart, createCopy as createCopyPart, type CopySecret } from "./CopyButtonPart";
export { COPY_FEEDBACK_MS, COPY_FAILURE, COPY_WORDS, COPY_TILE_CLASS, COPY_TILE_STATE_CLASS, type CopyFeedback, type CopySecret } from "./CopyButtonPart";

export function createCopy(options: Parameters<typeof createCopyPart>[0]) {
  return createCopyPart({...options, formatError: withErrorWords});
}

export function CopyButton(props: Omit<ComponentProps<typeof CopyButtonPart>, "report" | "formatError" | "className" | "primary"> & {
  // The primary of a surface whose action is the copy, such as Copy agent link.
  primary?: boolean;
}) {
  const report = useContext(ShellErrorReporter);
  const { primary, ...rest } = props;
  return <CopyButtonPart {...rest} primary={primary ? PrimaryButton : undefined} report={report} formatError={withErrorWords} />;
}

// Text a person hands on, such as a link or a code, on one line with its copy
// at the end: copy sits beside the text it copies. The caller's element holds
// the text, its test names, and a title with the whole text when it can run
// past the field. A link the clipboard refused can still be selected by hand.
// The copy is keyed by the text, so a new link or code is a new control: its
// answer starts fresh, and Try again never copies the text it replaced.
export function CopyField(props: {
  children: ReactNode;
  getText: () => string | null;
  label?: string | undefined;
  copiedLabel?: string | undefined;
  sensitive?: CopySecret | undefined;
  copyTestId?: string | undefined;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-panel py-0.5 pl-2.5 pr-1 font-mono text-[12px] text-muted">
      <div className="min-w-0 flex-1 select-text truncate py-1 leading-4">{props.children}</div>
      <CopyButton
        key={props.getText() ?? ""}
        iconOnly
        getText={props.getText}
        label={props.label}
        copiedLabel={props.copiedLabel}
        sensitive={props.sensitive}
        testId={props.copyTestId}
      />
    </div>
  );
}
