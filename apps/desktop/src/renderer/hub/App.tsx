import { useState } from 'react'

import { DictationToast } from './components/Toast'
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
 */
export function App(): React.JSX.Element {
  const [section, setSection] = useState<SectionId>('home')

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
