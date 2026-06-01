/* dohc drop-lobe brand mark and lockups.
 *
 * The mark is a single stroked lobe contour with a central datum dot.
 * Both stroke and dot use `currentColor`, so the mark inherits ink and
 * adapts to light/dark mode from the surrounding text color. No
 * gradient, no shadow, no automotive badge. See dohc-brand-bible.html
 * section 02 (logo system).
 *
 * This file is the brand source of truth. The app re-exports it from
 * apps/app/src/components/DohcLogo.tsx. */

import React, { type CSSProperties, type ReactNode } from 'react'

/** Master viewBox aspect ratio (96 x 104). */
const MARK_RATIO = 104 / 96

/** The drop-lobe path, shared so favicon/icon generators can reuse it. */
export const DOHC_LOBE_PATH =
  'M48 10c14 0 25 9 25 23 0 5-2 9-4 13 10 5 17 15 17 27 0 16-12 27-29 27-12 0-22-5-31-12L12 78C8 68 7 56 10 44 15 23 29 10 48 10Z'

/** The datum dot, shared with favicon/icon generators. */
export const DOHC_DOT = { cx: 38, cy: 58, r: 9 } as const

/**
 * The bare drop-lobe mark. Inherits `color` for both stroke and dot.
 */
export function DohcMark({
  size = 32,
  className = '',
  title = 'dohc',
}: {
  size?: number
  className?: string
  title?: string
}) {
  return (
    <svg
      width={size}
      height={Math.round(size * MARK_RATIO)}
      viewBox="0 0 96 104"
      role="img"
      aria-label={title}
      className={className}
    >
      <path
        d={DOHC_LOBE_PATH}
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="8"
      />
      <circle cx={DOHC_DOT.cx} cy={DOHC_DOT.cy} r={DOHC_DOT.r} fill="currentColor" />
    </svg>
  )
}

/**
 * Lowercase wordmark. Sans by default; never uppercased in the lockup.
 */
export function DohcWordmark({
  fontSize = 28,
  className = '',
  style,
}: {
  fontSize?: number
  className?: string
  style?: CSSProperties
}) {
  return (
    <span
      className={`select-none ${className}`}
      style={{
        fontFamily: 'var(--font-sans)',
        fontWeight: 780,
        fontSize,
        lineHeight: 1,
        letterSpacing: 0,
        ...style,
      }}
    >
      dohc
    </span>
  )
}

/**
 * Mark + wordmark. `orientation="horizontal"` for app chrome,
 * `"stacked"` for brand moments (sign-in, empty states, onboarding).
 */
export function DohcLockup({
  orientation = 'horizontal',
  size = 32,
  className = '',
}: {
  orientation?: 'horizontal' | 'stacked'
  size?: number
  className?: string
}) {
  if (orientation === 'stacked') {
    return (
      <span
        className={`inline-flex flex-col items-center gap-3 ${className}`}
        aria-label="dohc"
      >
        <DohcMark size={size} title="" />
        <DohcWordmark fontSize={Math.round(size * 1.4)} />
      </span>
    )
  }
  return (
    <span
      className={`inline-flex items-center gap-2 ${className}`}
      aria-label="dohc"
    >
      <DohcMark size={size} title="" />
      <DohcWordmark fontSize={Math.round(size * 0.82)} />
    </span>
  )
}

type Size = 'sm' | 'md' | 'lg'
const LOCKUP_SIZE: Record<Size, number> = { sm: 18, md: 28, lg: 48 }

/**
 * Convenience brand lockup used for brand moments. Stacked mark over
 * wordmark, sized by token. Preserves the `size` API the app used
 * before the rebrand.
 */
export function DohcLogo({
  size = 'md',
  className = '',
}: {
  size?: Size
  className?: string
}) {
  return (
    <DohcLockup orientation="stacked" size={LOCKUP_SIZE[size]} className={className} />
  )
}

/**
 * Mark on the left, two or three short info lines on the right. Used in
 * the empty document state. Info lines use mono, calm and metadata-like.
 */
export function DohcBrandBlock({
  lines,
  className = '',
  children,
}: {
  /** 2-3 short lines shown to the right of the mark. */
  lines: ReadonlyArray<ReactNode>
  className?: string
  children?: ReactNode
}) {
  return (
    <div className={`flex items-center gap-4 ${className}`}>
      <DohcMark size={40} title="" />
      <div className="flex flex-col gap-0.5 font-mono text-[11.5px] leading-[18px]">
        {lines.map((line, i) => (
          <span key={i} className={i === 0 ? 'text-ink-strong font-medium' : 'text-ink-dim'}>
            {line}
          </span>
        ))}
        {children}
      </div>
    </div>
  )
}
