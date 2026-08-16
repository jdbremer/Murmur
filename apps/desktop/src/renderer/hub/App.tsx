import { useEffect, useState } from 'react'

import { useSettings } from '../hooks/useSettings'
import { DictationToast } from './components/Toast'
import { Onboarding } from './onboarding/Onboarding'
import { Sidebar, type SectionId } from './Sidebar'
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
  const [section, setSection] = useState<SectionId>('history')
  const { settings } = useSettings()

  useAppearance(settings?.appearance ?? 'system')

  // Nothing renders until settings load: the alternative is showing the Hub for
  // a frame and then replacing it with onboarding, which looks like a bug.
  if (!settings) return <div className="h-full bg-canvas" />

  if (!settings.onboardingCompleted) {
    // `overflow-hidden`, not `overflow-y-auto`: Onboarding is its own shell and
    // scrolls its middle pane. A scrolling parent around a full-height child
    // gave the outer box nothing to scroll and clipped the inner content.
    return (
      <div className="h-full overflow-hidden bg-canvas text-ink">
        <Onboarding settings={settings} onFinish={() => setSection('history')} />
      </div>
    )
  }

  return (
    <div className="relative flex h-full bg-canvas text-ink">
      <Sidebar active={section} onSelect={setSection} />
      {/* The content pane is a raised card floating on the canvas — the
          reference product's defining layout move. The sidebar shares the
          canvas with no dividing line; the card's edge IS the division. */}
      <main className="min-w-0 flex-1 p-2 pl-0">
        <div className="h-full overflow-y-auto rounded-2xl border border-line bg-surface shadow-sm">
          {/* Keyed on the section so switching drifts the new content in. */}
          <div key={section} className="hub-section mx-auto max-w-4xl px-10 py-9">
            {renderSection(section)}
          </div>
        </div>
      </main>
      <DictationToast />
    </div>
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

function renderSection(section: SectionId): React.JSX.Element {
  switch (section) {
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
