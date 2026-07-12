import { useEffect, useState } from 'react'

type Mode = 'light' | 'system' | 'dark'

/**
 * Three state theme switcher: light, system, dark.
 * Compatible with vocs's storage: `vocs.theme` = 'light' | 'dark';
 * absent key = follow the OS (vocs's initializeTheme already does this
 * on load when no value is stored).
 */

function readMode(): Mode {
  if (typeof window === 'undefined') return 'system'
  const stored = localStorage.getItem('vocs.theme')
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

function systemIsDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function applyDark(dark: boolean) {
  document.documentElement.classList.toggle('dark', dark)
}

const icons: Record<Mode, React.ReactNode> = {
  light: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  ),
  system: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  ),
  dark: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  ),
}

const labels: Record<Mode, string> = {
  light: 'Light theme',
  system: 'Match system theme',
  dark: 'Dark theme',
}

export function ThemeSwitch() {
  const [mounted, setMounted] = useState(false)
  const [mode, setModeState] = useState<Mode>('system')

  useEffect(() => {
    setMounted(true)
    setModeState(readMode())
  }, [])

  // Follow OS changes while in system mode.
  useEffect(() => {
    if (!mounted || mode !== 'system') return
    applyDark(systemIsDark())
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => applyDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [mounted, mode])

  // Stay in sync if another control (e.g. the sidebar toggle) changes the theme.
  useEffect(() => {
    if (!mounted) return
    const sync = () => setModeState(readMode())
    window.addEventListener('storage', sync)
    const obs = new MutationObserver(sync)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => {
      window.removeEventListener('storage', sync)
      obs.disconnect()
    }
  }, [mounted])

  const setMode = (next: Mode) => {
    if (next === 'system') {
      localStorage.removeItem('vocs.theme')
      applyDark(systemIsDark())
    } else {
      localStorage.setItem('vocs.theme', next)
      applyDark(next === 'dark')
    }
    setModeState(next)
  }

  if (!mounted) return null

  return (
    <div className="altana-theme-switch" role="group" aria-label="Theme">
      {(['light', 'system', 'dark'] as const).map((m) => (
        <button
          key={m}
          type="button"
          title={labels[m]}
          aria-label={labels[m]}
          data-active={mode === m}
          onClick={() => setMode(m)}
        >
          {icons[m]}
        </button>
      ))}
    </div>
  )
}
