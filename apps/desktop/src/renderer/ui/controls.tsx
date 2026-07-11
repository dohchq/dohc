import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { DohcMark } from "@dohc/brand";

// The dohc control primitives — the canonical implementations of the recipes
// in docs/brand/ui-language.md. Surfaces compose THESE instead of re-typing
// class strings so the language cannot drift file by file. Styling changes
// happen here (or in the spec) — never inline at a call site.

type NativeButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// Class constants exist for call sites that must BRANCH between recipes on a
// single element (e.g. a Start/Stop toggle, where swapping components would
// remount the button and drop keyboard focus). Everything else composes the
// components below.
export const primaryButtonClass =
  "rounded-lg bg-accent px-3 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50";
export const secondaryButtonClass =
  "rounded-lg border border-line bg-transparent px-3 py-1.5 text-xs text-muted transition-colors hover:bg-panel-2 hover:text-ink disabled:opacity-50";
export const iconButtonClass =
  "grid size-6 place-items-center rounded-md text-subtle transition-colors hover:bg-line/50 hover:text-ink disabled:pointer-events-none disabled:opacity-40";

/** Filled brand-accent CTA — at most one per surface. */
export function PrimaryButton({ className, type, ...rest }: NativeButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={cx(primaryButtonClass, className)}
      {...rest}
    />
  );
}

/** Quiet bordered action — the default button. */
export function SecondaryButton({ className, type, ...rest }: NativeButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={cx(secondaryButtonClass, className)}
      {...rest}
    />
  );
}

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

/** Keyboard hint chip — always the mono voice. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-bg px-1 font-mono text-[10px] text-subtle">
      {children}
    </kbd>
  );
}

/** Uppercase section label for panel groups. */
export function SectionLabel({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "text-[10px] font-semibold uppercase tracking-wide text-subtle",
        className,
      )}
    >
      {children}
    </span>
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
