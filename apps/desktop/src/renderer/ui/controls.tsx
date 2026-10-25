import { forwardRef } from "react";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { TriangleAlert, type LucideIcon } from "lucide-react";
import { DohcMark } from "@dohc/brand";

// The dohc control primitives — the canonical implementations of the recipes
// in the dohc-interface skill. Surfaces compose these instead of re-typing
// class strings so the language cannot drift file by file. Styling changes
// happen here (or in the spec) — never inline at a call site.

type NativeButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

const primaryButtonClass =
  "rounded-lg bg-accent px-3 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50";
const secondaryButtonClass =
  "rounded-lg border border-line bg-transparent px-3 py-1.5 text-xs text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-50";
const iconButtonClass =
  "grid size-6 place-items-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-40";

type ActionButtonProps = NativeButtonProps & { size?: "default" | "compact" };
type SecondaryButtonProps = NativeButtonProps & { size?: "default" | "compact" | "row" };
type DangerButtonProps = NativeButtonProps & { size?: "default" | "compact" | "row" };
const compactPrimaryButtonClass =
  "h-7 cursor-pointer rounded-md bg-accent px-2.5 text-[11px] font-semibold text-bg hover:opacity-90 dohc-focus-visible focus-visible:outline-offset-1 disabled:cursor-wait disabled:opacity-50";
// The secondary recipe at a table row's height, for a control inside a
// cell. `aria-disabled` keeps a button that says why it cannot run in the
// tab order, where `disabled` would drop it.
const rowSecondaryButtonClass =
  "inline-flex h-6 max-w-full items-center gap-1 rounded-md border border-line bg-transparent px-2 text-xs text-muted transition-colors hover:bg-hover hover:text-ink aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted";
const compactSecondaryButtonClass =
  "h-7 cursor-pointer rounded-md border border-line px-2.5 text-[11px] text-muted hover:bg-hover hover:text-ink dohc-focus-visible focus-visible:-outline-offset-2 disabled:cursor-wait disabled:opacity-50";
// The primary recipe on the danger fill, for the confirm of an action that
// removes or revokes something. Paper text on danger clears AA in both
// themes (tokens.test.ts guards the pair).
const dangerButtonClass =
  "rounded-lg bg-danger px-3 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50";
const compactDangerButtonClass =
  "h-7 cursor-pointer rounded-md bg-danger px-2.5 text-[11px] font-semibold text-bg hover:opacity-90 dohc-focus-visible focus-visible:outline-offset-1 disabled:cursor-wait disabled:opacity-50";
// The danger confirm at the secondary row button's height, so a row's
// confirm takes its place without the row growing.
const rowDangerButtonClass =
  "inline-flex h-6 cursor-pointer items-center rounded-md bg-danger px-2 text-xs font-semibold text-bg hover:opacity-90 dohc-focus-visible focus-visible:outline-offset-1 disabled:cursor-wait disabled:opacity-50";

/** Filled brand-accent CTA — at most one per surface. */
export const PrimaryButton = forwardRef<HTMLButtonElement, ActionButtonProps>(
  function PrimaryButton({ className, type, size, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        className={cx(size === "compact" ? compactPrimaryButtonClass : primaryButtonClass, className)}
        {...rest}
      />
    );
  },
);

/** Filled danger confirm for an action that removes or revokes something.
 * Ordinary confirms keep PrimaryButton. */
export const DangerButton = forwardRef<HTMLButtonElement, DangerButtonProps>(
  function DangerButton({ className, type, size, ...rest }, ref) {
    const sized = size === "compact" ? compactDangerButtonClass : size === "row" ? rowDangerButtonClass : dangerButtonClass;
    return <button ref={ref} type={type ?? "button"} className={cx(sized, className)} {...rest} />;
  },
);

/** Quiet bordered action — the default button. */
export const SecondaryButton = forwardRef<HTMLButtonElement, SecondaryButtonProps>(
  function SecondaryButton({ className, type, size, ...rest }, ref) {
    const sized = size === "compact" ? compactSecondaryButtonClass : size === "row" ? rowSecondaryButtonClass : secondaryButtonClass;
    return <button ref={ref} type={type ?? "button"} className={cx(sized, className)} {...rest} />;
  },
);

/** Ghost icon affordance for toolbars and row actions. Pass the icon as
 * children; size stays 24px unless a `size-*` class overrides it. Forwards its
 * ref so callers can restore focus to the trigger (e.g. a menu returning focus
 * on Escape/dismiss). */
export const IconButton = forwardRef<HTMLButtonElement, NativeButtonProps>(
  function IconButton({ className, type, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        className={cx(iconButtonClass, className)}
        {...rest}
      />
    );
  },
);

const pillToneClass = {
  muted: "text-muted",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  agent: "text-agent",
} as const;

/** Quiet count/status pill. A tone changes the TEXT color, never the fill. */
export function Pill({
  tone = "muted",
  children,
}: {
  tone?: keyof typeof pillToneClass;
  children: ReactNode;
}) {
  return (
    <span className={cx("rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[11px]", pillToneClass[tone])}>
      {children}
    </span>
  );
}

/** Section label for panel groups. */
export function SectionLabel({
  as: Element = "span",
  className,
  children,
  ...rest
}: {
  as?: "span" | "p" | "div" | "header" | "h3" | "h4";
  children: ReactNode;
} & HTMLAttributes<HTMLElement>) {
  return (
    <Element
      {...rest}
      className={cx(
        "dohc-section-label",
        className,
      )}
    >
      {children}
    </Element>
  );
}

// The mark is larger and heavier than a 20px glyph, so its ghost is one
// step fainter: in text-subtle a glyph still reads, and in text-line it
// all but disappears.
const emptyGlyphToneClass = {
  ghost: { glyph: "text-subtle", mark: "text-line" },
  danger: { glyph: "text-danger", mark: "text-danger" },
  // A state that holds something back on purpose, such as Restricted Mode.
  warning: { glyph: "text-warning", mark: "text-warning" },
} as const;

/** Centered empty state: a ghost glyph, one muted line that says what is
 * missing, and the surface's own next action as children. The glyph is the
 * drop-lobe mark unless the surface names its own; a state that exists
 * because something failed draws it in the danger tone. Every other
 * attribute, such as a pinned `data-testid` or `role`, lands on the root. */
export function EmptyState({
  icon: Icon,
  tone = "ghost",
  title,
  hint,
  children,
  ...rest
}: {
  icon?: LucideIcon;
  tone?: keyof typeof emptyGlyphToneClass;
  title: ReactNode;
  hint?: string;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "title" | "className" | "children">) {
  const toneClass = emptyGlyphToneClass[tone];
  return (
    <div {...rest} className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      {Icon ? (
        <Icon size={20} strokeWidth={1.9} aria-hidden className={toneClass.glyph} />
      ) : (
        <DohcMark size={30} className={toneClass.mark} />
      )}
      <div className="flex max-w-sm flex-col gap-1 text-balance wrap-anywhere">
        <span className="text-sm text-muted">{title}</span>
        {hint ? <span className="text-[11px] text-subtle">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** A list or section whose read failed. Its words are in the toast and its
 * Notices row, reported through the shell's error hook; here the mark says it
 * failed and Try again reads again. */
export function RetryRow(props: { testId: string; onRetry: () => void }) {
  return (
    <div data-testid={props.testId} className="flex items-center gap-2 px-2 py-1">
      <TriangleAlert size={12} aria-hidden className="shrink-0 text-danger" />
      <SecondaryButton size="compact" onClick={props.onRetry}>
        Try again
      </SecondaryButton>
    </div>
  );
}
