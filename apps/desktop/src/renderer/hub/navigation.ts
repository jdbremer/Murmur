import { createContext, useContext } from 'react'

/**
 * Which section of the Hub is showing, and how anything gets to another one.
 *
 * The id lives here rather than in `Sidebar.tsx` because the sidebar is now
 * only one of the things that navigates: an empty state offers a way out of
 * itself, a toast can point at what it is talking about, and the Dashboard is
 * almost entirely made of links to elsewhere. All of those would otherwise
 * import a component module for a type, or take a prop threaded down through
 * three levels of layout that does not care about it.
 */
export type SectionId =
  | 'dashboard'
  | 'history'
  | 'insights'
  | 'notes'
  | 'dictionary'
  | 'snippets'
  | 'style'
  | 'meetings'
  | 'transcribe'
  | 'models'
  | 'vibeCoding'
  | 'settings'
  | 'help'

const NavigationContext = createContext<((section: SectionId) => void) | null>(null)

export const NavigationProvider = NavigationContext.Provider

/**
 * Jump to a section.
 *
 * Falls back to a no-op outside a provider — the Notes window renders a couple
 * of the same components with no Hub around them, and a missing navigator is
 * not worth taking that window down over.
 */
export function useNavigate(): (section: SectionId) => void {
  return useContext(NavigationContext) ?? (() => undefined)
}
