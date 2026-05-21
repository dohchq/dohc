/* vibeam ASCII logo — Fitted Beam variant.
 *
 *    █▌  ▐█      left stems violet ("vi"), right stems pink ("beam").
 *     █▌▐█       Same split as the wordmark, so logo + wordmark read
 *      ▜▛        as one identity in two formats.
 *
 *  The bottom converges to a tight 2-cell aperture — the "fitted"
 *  cut where the beam passes through. See
 *  docs/brand/vibeam-logo-options.md and public/favicon.svg. */

type Size = 'sm' | 'md' | 'lg'

const SIZE_STYLE: Record<Size, { fontSize: string; lineHeight: string }> = {
  sm: { fontSize: '12px', lineHeight: '12px' },
  md: { fontSize: '18px', lineHeight: '18px' },
  lg: { fontSize: '32px', lineHeight: '32px' },
}

export function VibeamLogo({
  size = 'md',
  className = '',
}: {
  size?: Size
  className?: string
}) {
  const violet = { color: 'var(--color-accent-2)' }
  const pink = { color: 'var(--color-accent)' }
  return (
    <pre
      aria-label="vibeam"
      role="img"
      className={`font-mono whitespace-pre select-none m-0 ${className}`}
      style={SIZE_STYLE[size]}
    >
      <span style={violet}>{'█▌'}</span>
      {'  '}
      <span style={pink}>{'▐█'}</span>
      {'\n '}
      <span style={violet}>{'█▌'}</span>
      <span style={pink}>{'▐█'}</span>
      {'\n  '}
      <span style={violet}>{'▜'}</span>
      <span style={pink}>{'▛'}</span>
    </pre>
  )
}

/* SVG version of the same Fitted Beam mark — for UI chrome where the
 * 3-row ASCII block-art is too chunky (header chips, buttons, hover
 * affordances). 12×12 viewBox identical to public/favicon.svg, so the
 * tab icon and the in-app mark are literally the same shape. */
export function VibeamMark({
  size = 16,
  className = '',
}: {
  size?: number
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      aria-label="vibeam"
      role="img"
      className={className}
    >
      {/* V fills the full 12×12 viewBox so the rendered shape matches
       *  the ASCII <VibeamLogo /> proportions (which renders ~square
       *  in monospace where char cells are taller than wide). Heights
       *  are doubled from the natural 6-row design to stretch the V
       *  vertically into a square container. */}
      {/* Top stems */}
      <rect x="0" y="0" width="3" height="4" fill="var(--color-accent-2)" />
      <rect x="9" y="0" width="3" height="4" fill="var(--color-accent)" />
      {/* Mid stems */}
      <rect x="2" y="4" width="3" height="4" fill="var(--color-accent-2)" />
      <rect x="7" y="4" width="3" height="4" fill="var(--color-accent)" />
      {/* Wide bottom row */}
      <rect x="4" y="8" width="2" height="2" fill="var(--color-accent-2)" />
      <rect x="6" y="8" width="2" height="2" fill="var(--color-accent)" />
      {/* Aperture point */}
      <rect x="5" y="10" width="1" height="2" fill="var(--color-accent-2)" />
      <rect x="6" y="10" width="1" height="2" fill="var(--color-accent)" />
    </svg>
  )
}

/* CLI-style brand block — logo on the left, two-line info on the right.
 * Matches the Claude Code header pattern. The info text uses the
 * `lines` prop so callers can tailor it (path, version, status). */
export function VibeamBrandBlock({
  lines,
  className = '',
}: {
  /** 2–3 short lines shown to the right of the logo. */
  lines: ReadonlyArray<string>
  className?: string
}) {
  return (
    <div className={`flex items-center gap-4 ${className}`}>
      <VibeamLogo size="md" />
      <div className="flex flex-col gap-0.5 font-mono text-[11.5px] leading-[18px]">
        {lines.map((line, i) => (
          <span
            key={i}
            className={i === 0 ? 'text-ink-strong font-medium' : 'text-ink-dim'}
          >
            {line}
          </span>
        ))}
      </div>
    </div>
  )
}
