import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'dohc-theme'

// Hook backing the theme toggle.
// - 'system' (default): respects prefers-color-scheme via CSS media query.
//   No data-theme attribute on <html>; localStorage is empty.
// - 'light' / 'dark': forces. data-theme is set; localStorage stores it.
//
// First-paint correctness is handled by an inline script in __root.tsx,
// which sets the data-theme attribute before React hydrates.
export function useTheme(): {
  theme: Theme
  setTheme: (t: Theme) => void
  cycle: () => void
} {
  const [theme, setThemeState] = useState<Theme>('system')

  useEffect(() => {
    if (typeof document === 'undefined') return
    const attr = document.documentElement.getAttribute('data-theme')
    if (attr === 'light' || attr === 'dark') {
      setThemeState(attr)
    } else {
      setThemeState('system')
    }
  }, [])

  function setTheme(t: Theme) {
    setThemeState(t)
    if (typeof document === 'undefined') return
    if (t === 'system') {
      try { localStorage.removeItem(STORAGE_KEY) } catch {}
      document.documentElement.removeAttribute('data-theme')
    } else {
      try { localStorage.setItem(STORAGE_KEY, t) } catch {}
      document.documentElement.setAttribute('data-theme', t)
    }
  }

  function cycle() {
    setTheme(theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light')
  }

  return { theme, setTheme, cycle }
}
