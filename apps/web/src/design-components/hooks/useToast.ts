import { useCallback, useRef } from 'react'

export function useToast() {
  const toastRef = useRef<HTMLDivElement | null>(null)

  const showToast = useCallback((msg: string) => {
    if (!toastRef.current) {
      const el = document.createElement('div')
      el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md);padding:10px 18px;font-size:13px;z-index:500;box-shadow:var(--shadow-2);display:none'
      document.body.appendChild(el)
      toastRef.current = el
    }
    const toast = toastRef.current
    toast.textContent = msg
    toast.style.display = 'block'
    clearTimeout((toast as any)._t)
    ;(toast as any)._t = setTimeout(() => { toast.style.display = 'none' }, 2500)
  }, [])

  return { showToast }
}
