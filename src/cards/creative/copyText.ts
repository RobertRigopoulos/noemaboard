import { toast } from '../../ui/toast'

/**
 * Copies text to the clipboard and confirms with a toast. Falls back to a hidden textarea +
 * execCommand where the async Clipboard API is unavailable (insecure origins, older WebViews).
 */
export async function copyText(text: string, label = text): Promise<boolean> {
  let ok = false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      ok = true
    }
  } catch {
    ok = false
  }
  if (!ok) ok = legacyCopy(text)
  if (ok) toast(`Copied ${label}`, 'success', 2000)
  else toast('Could not copy to the clipboard', 'error')
  return ok
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  ta.style.pointerEvents = 'none'
  document.body.appendChild(ta)
  const active = document.activeElement as HTMLElement | null
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  active?.focus?.({ preventScroll: true })
  return ok
}
