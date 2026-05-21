/* dohc brand constants — name, positioning, palette, and font stacks.
 * Framework-agnostic so any surface (app, docs, scripts) can import. */

export const BRAND_NAME = 'dohc'

/** Short positioning statement for meta descriptions and intros. */
export const BRAND_DESCRIPTION =
  'The quiet AI and docs workspace where work becomes clear, traceable, and ready.'

export const FONT_STACKS = {
  serif: "'Iowan Old Style', 'Charter', Georgia, serif",
  sans: "'Aptos', 'Segoe UI', ui-sans-serif, system-ui, sans-serif",
  mono: "'IBM Plex Mono', 'SFMono-Regular', Menlo, Consolas, monospace",
} as const

export const LIGHT_TOKENS = {
  bg: '#f7f6f1',
  panel: '#fffefa',
  panel2: '#ece9e1',
  ink: '#151515',
  muted: '#66635d',
  subtle: '#8b867b',
  accent: '#2d342e',
} as const

export const DARK_TOKENS = {
  bg: '#101211',
  panel: '#191c1a',
  panel2: '#252923',
  ink: '#f4f1ea',
  muted: '#aaa69c',
  subtle: '#78746d',
  accent: '#d7d0c0',
} as const

export const SEMANTIC_COLORS = {
  success: '#4f7666',
  warning: '#a77a35',
  danger: '#b64b37',
  info: '#3868a6',
} as const

/** theme-color meta values for light and dark browser chrome. */
export const THEME_COLOR = { light: LIGHT_TOKENS.bg, dark: DARK_TOKENS.bg } as const
