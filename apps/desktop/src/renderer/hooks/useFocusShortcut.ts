import { useEffect, type RefObject } from 'react'

/**
 * ⌘F — or a bare `/` — puts the cursor in this section's search box.
 *
 * Both, because two different habits arrive at the same field: ⌘F is what a Mac
 * user presses to find something in *any* window, and `/` is what anyone who
 * has used a text editor or a code host in the last decade presses. Supporting
 * only one of them means half the people who try get nothing.
 *
 * The guard matters more than the shortcut. Without it, typing a literal slash
 * into any input on the page would yank focus to the search box mid-word —
 * a bug that is invisible in testing and infuriating in use.
 */
export function useFocusShortcut(ref: RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable === true

      const findKey = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f'
      const slash = event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey

      if (!findKey && !(slash && !typing)) return
      const input = ref.current
      if (!input) return

      event.preventDefault()
      input.focus()
      input.select()
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ref])
}
