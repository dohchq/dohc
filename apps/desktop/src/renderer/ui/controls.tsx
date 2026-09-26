import { forwardRef } from "react";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
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
  "rounded-lg border border-line bg-transparent px-3 py-1.5 text-xs text-muted transition-colors hover:bg-panel-2 hover:text-ink disabled:opacity-50";
const iconButtonClass =
  "grid size-6 place-items-center rounded-md text-subtle transition-colors hover:bg-line/50 hover:text-ink disabled:pointer-events-none disabled:opacity-40";

type ActionButtonProps = NativeButtonProps & { size?: "default" | "compact" };
type SecondaryButtonProps = NativeButtonProps & { size?: "default" | "compact" | "row" };
const compactPrimaryButtonClass =
  "h-7 cursor-pointer rounded-md bg-accent px-2.5 text-[11px] font-semibold text-bg hover:opacity-90 dohc-focus-visible focus-visible:outline-offset-1 disabled:cursor-wait disabled:opacity-50";
// The secondary recipe at a table row's height, for a control inside a
// cell. `aria-disabled` keeps a button that says why it cannot run in the
// tab order, where `disabled` would drop it.
const rowSecondaryButtonClass =
  "inline-flex h-6 max-w-full items-center gap-1 rounded-md border border-line bg-transparent px-2 text-xs text-muted transition-colors hover:bg-panel-2 hover:text-ink aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted";
const compactSecondaryButtonClass =
  "h-7 cursor-pointer rounded-md border border-line px-2.5 text-[11px] text-muted hover:bg-line/50 hover:text-ink dohc-focus-visible focus-visible:-outline-offset-2 disabled:cursor-wait disabled:opacity-50";

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

/** Quiet count/status pill. Semantics change the TEXT color, never the fill. */
export function Pill({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[11px] text-muted",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Uppercase section label for panel groups. */
export function SectionLabel({
  as: Element = "span",
  className,
  children,
  ...rest
}: {
  as?: "span" | "p" | "div" | "header" | "h3";
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

/** Centered empty state: optional ghost mark, one muted line, quiet extras. */
export function EmptyState({
  icon,
  title,
  hint,
  children,
}: {
  /** Custom icon node; defaults to the ghosted drop-lobe mark. */
  icon?: ReactNode;
  title: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      {icon ?? <DohcMark size={30} className="text-line" />}
      <div className="flex flex-col gap-1">
        <span className="text-sm text-muted">{title}</span>
        {hint ? <span className="text-[11px] text-subtle">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}
