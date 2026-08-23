import { useEffect, useRef, useState } from 'react'

import { useSettings } from '../hooks/useSettings'
import { ToastProvider } from './components/ToastHost'
import { UpdateNotice } from './components/UpdateNotice'
import { Onboarding } from './onboarding/Onboarding'
import { CommandPalette } from './command/CommandPalette'
import { NavigationProvider, type SectionId } from './navigation'
import { ALL_SECTIONS, Sidebar } from './Sidebar'
import { DashboardSection } from './sections/DashboardSection'
import { HistorySection } from './sections/HistorySection'
import { InsightsSection } from './sections/InsightsSection'
import { NotesSection } from './sections/NotesSection'
import { DictionarySection } from './sections/DictionarySection'
import { SnippetsSection } from './sections/SnippetsSection'
import { StyleSection } from './sections/StyleSection'
import { MeetingsSection } from './sections/MeetingsSection'
import { TranscribeSection } from './sections/TranscribeSection'
import { ModelsSection } from './sections/ModelsSection'
import { VibeCodingSection } from './sections/VibeCodingSection'
import { SettingsSection } from './sections/SettingsSection'
import { HelpSection } from './sections/HelpSection'

/**
 * The Hub shell (PLAN §2.2): left sidebar, content pane on the right.
 *
 * Navigation is plain React state — twelve sections, no deep links, no history
 * to preserve. A router would be all cost and no benefit here.
 *
 * Two things happen at this level because they are whole-window concerns: the
 * appearance setting is applied to `<html data-theme>`, and a fresh install is
 * handed to onboarding instead of the sections (PLAN §2.4).
 */
export function App(): React.JSX.Element {
  const [section, setSection] = useState<SectionId>('dashboard')
  const { settings } = useSettings()

  useAppearance(settings?.appearance ?? 'system')

  /**
   * Changing section is a navigation, and a navigation has to be announced and
   * has to move the keyboard somewhere sensible — otherwise a screen reader
   * says nothing at all when the whole page changes, and Tab carries on from
   * wherever it was in the sidebar as though nothing had happened.
   *
   * Focus lands on the content container rather than on its heading: focusing
   * the heading makes some readers announce only the heading and drop the
   * region, and the container gets both. The first render is skipped — nobody
   * navigated to it.
   */
  const contentRef = useRef<HTMLDivElement | null>(null)
  const navigated = useRef(false)
  useEffect(() => {
    if (!navigated.current) {
      navigated.current = true
      return
    }
    contentRef.current?.focus({ preventScroll: true })
  }, [section])

  // Nothing renders until settings load: the alternative is showing the Hub for
  // a frame and then replacing it with onboarding, which looks like a bug.
  if (!settings) return <div className="h-full bg-canvas" />

  if (!settings.onboardingCompleted) {
    // `overflow-hidden`, not `overflow-y-auto`: Onboarding is its own shell and
    // scrolls its middle pane. A scrolling parent around a full-height child
    // gave the outer box nothing to scroll and clipped the inner content.
    return (
      <div className="h-full overflow-hidden bg-canvas text-ink">
        <Onboarding settings={settings} onFinish={() => setSection('dashboard')} />
      </div>
    )
  }

  return (
    <NavigationProvider value={setSection}>
      <ToastProvider>
        <div className="relative flex h-full bg-canvas text-ink">
          <Sidebar active={section} onSelect={setSection} />
          {/* The content pane is a raised card floating on the canvas — the
              reference product's defining layout move. The sidebar shares the
              canvas with no dividing line; the card's edge IS the division. */}
          <main className="min-w-0 flex-1 p-2 pl-0">
            <div className="elev-1 h-full overflow-y-auto rounded-2xl border border-line bg-surface">
              {/* Keyed on the section so switching drifts the new content in.
                  `@container` makes every section's breakpoints measure *this*
                  box rather than the window: the pane is ~230px narrower than
                  the viewport, so a viewport-based `lg:` fires while the pane
                  is still too narrow for the two columns it turns on. */}
              <div
                key={section}
                ref={contentRef}
                tabIndex={-1}
                aria-labelledby="section-title"
                className={`hub-section @container mx-auto px-10 py-9 outline-none ${measureFor(section)}`}
              >
                {renderSection(section)}
              </div>
            </div>
          </main>
          {/* Top-right, opposite corner from the toast stack so a failure and a
              pending update never stack on top of each other. */}
          <UpdateNotice />
          {/* Last, so its overlay sits above everything including the toasts. */}
          <CommandPalette />
          {/* Politely, so it waits for a pause rather than cutting across
              whatever the reader was in the middle of saying. */}
          <p aria-live="polite" className="sr-only">
            {sectionLabel(section)}
          </p>
        </div>
      </ToastProvider>
    </NavigationProvider>
  )
}

/**
 * Appearance (PLAN §2.2.5).
 *
 * `system` removes the attribute so the OS preference decides through the
 * `prefers-color-scheme` block in theme.css; light and dark stamp it, and the
 * explicit rule wins in both directions. No `dark:` variants anywhere — a theme
 * is a set of variables, not a second set of classes.
 */
function useAppearance(appearance: 'system' | 'light' | 'dark'): void {
  useEffect(() => {
    const root = document.documentElement
    if (appearance === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', appearance)
  }, [appearance])
}

/**
 * How wide the content is allowed to get.
 *
 * Two answers, because there are two kinds of section. Prose is capped at a
 * readable measure — a paragraph 1,400 pixels wide is unreadable no matter how
 * much room the window has. Grids are not prose: a dashboard or a model
 * catalog capped at the same width leaves half a large display empty and
 * stacks cards that would happily sit side by side.
 */
const WIDE_SECTIONS = new Set<SectionId>([
  'dashboard',
  'models',
  'insights',
  'meetings',
  'transcribe',
])

function sectionLabel(section: SectionId): string {
  return ALL_SECTIONS.find((entry) => entry.id === section)?.label ?? section
}

function measureFor(section: SectionId): string {
  return WIDE_SECTIONS.has(section) ? 'max-w-6xl' : 'max-w-4xl'
}

function renderSection(section: SectionId): React.JSX.Element {
  switch (section) {
    case 'dashboard':
      return <DashboardSection />
    case 'history':
      return <HistorySection />
    case 'insights':
      return <InsightsSection />
    case 'notes':
      return <NotesSection />
    case 'dictionary':
      return <DictionarySection />
    case 'snippets':
      return <SnippetsSection />
    case 'style':
      return <StyleSection />
    case 'meetings':
      return <MeetingsSection />
    case 'transcribe':
      return <TranscribeSection />
    case 'models':
      return <ModelsSection />
    case 'vibeCoding':
      return <VibeCodingSection />
    case 'settings':
      return <SettingsSection />
    case 'help':
      return <HelpSection />
  }
}
