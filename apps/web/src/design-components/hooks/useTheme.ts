import { useState, useEffect, useCallback } from 'react'
import type { ThemePref } from '../types'

const STORAGE_KEY = 'shannon-theme'
const mql = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: light)') : null

function resolveTheme(pref: string | null): 'light' | 'dark' {
  if (pref === 'light' || pref === 'dark') return pref
  return mql?.matches ? 'light' : 'dark'
}

function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.setAttribute('data-theme', theme)
  window.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }))
}

function getStoredPref(): string | null {
  try { return localStorage.getItem(STORAGE_KEY) } catch { return null }
}

function setStoredPref(pref: string) {
  try { localStorage.setItem(STORAGE_KEY, pref) } catch {}
}

if (typeof window !== 'undefined') {
  const pref = getStoredPref()
  applyTheme(resolveTheme(pref))

  mql?.addEventListener('change', (e) => {
    if (!getStoredPref() || getStoredPref() === 'system') {
      applyTheme(e.matches ? 'light' : 'dark')
    }
  })

  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
      applyTheme(resolveTheme(e.newValue))
    }
  })
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(() => {
    const stored = getStoredPref()
    return (stored as ThemePref) || 'system'
  })

  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolveTheme(getStoredPref()))

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      setResolved(detail.theme)
    }
    window.addEventListener('themechange', handler)
    return () => window.removeEventListener('themechange', handler)
  }, [])

  const setTheme = useCallback((newPref: ThemePref) => {
    setPref(newPref)
    setStoredPref(newPref)
    applyTheme(resolveTheme(newPref))
  }, [])

  return { pref, resolved, setTheme }
}
