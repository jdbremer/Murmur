import { useEffect, useState } from 'react'

import { useSettings } from '../hooks/useSettings'
import { DictationToast } from './components/Toast'
import { Onboarding } from './onboarding/Onboarding'
import { Sidebar, type SectionId } from './Sidebar'
import { HomeSection } from './sections/HomeSection'
import { DictionarySection } from './sections/DictionarySection'
import { StyleSection } from './sections/StyleSection'
import { ModelsSection } from './sections/ModelsSection'
import { SettingsSection } from './sections/SettingsSection'
import { HelpSection } from './sections/HelpSection'

/**
 * The Hub shell (PLAN §2.2): left sidebar, content pane on the right.
 *
 * Navigation is plain React state — six sections, no deep links, no history to
 * preserve. A router would be all cost and no benefit here.
 *
 * Two things happen at this level because they are whole-window concerns: the
 * appearance setting is applied to `<html data-theme>`, and a fresh install is
 * handed to onboarding instead of the sections (PLAN §2.4).
 */
export function App(): React.JSX.Element {
  const [section, setSection] = useState<SectionId>('home')
  const { settings } = useSettings()

  useAppearance(settings?.appearance ?? 'system')

  // Nothing renders until settings load: the alternative is showing the Hub for
  // a frame and then replacing it with onboarding, which looks like a bug.
  if (!settings) return <div className="h-full bg-canvas" />

  if (!settings.onboardingCompleted) {
    return (
      <div className="h-full overflow-y-auto bg-canvas text-ink">
        <Onboarding settings={settings} onFinish={() => setSection('home')} />
      </div>
    )
  }

  return (
    <div className="relative flex h-full bg-canvas text-ink">
      <Sidebar active={section} onSelect={setSection} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-10 py-9">{renderSection(section)}</div>
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
    case 'home':
      return <HomeSection />
    case 'dictionary':
      return <DictionarySection />
    case 'style':
      return <StyleSection />
    case 'models':
      return <ModelsSection />
    case 'settings':
      return <SettingsSection />
    case 'help':
      return <HelpSection />
  }
}
