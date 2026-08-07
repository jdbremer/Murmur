export type SectionId =
  'home' | 'dictionary' | 'snippets' | 'style' | 'meetings' | 'models' | 'settings' | 'help'

interface SectionMeta {
  id: SectionId
  label: string
  /** Single SVG path, 24×24 viewBox, stroked. */
  icon: string
}

const SECTIONS: readonly SectionMeta[] = [
  {
    id: 'home',
    label: 'Home',
    icon: 'M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4v-5H9v5H5a1 1 0 0 1-1-1z',
  },
  {
    id: 'dictionary',
    label: 'Dictionary',
    icon: 'M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2zm2 0v12h11',
  },
  {
    id: 'snippets',
    label: 'Snippets',
    // A lightning bolt: an expansion, something short becoming something long.
    icon: 'M13 3 5 14h6l-1 7 8-11h-6z',
  },
  {
    id: 'style',
    label: 'Style',
    icon: 'M12 4c4.4 0 8 3.1 8 7 0 3.3-2.7 5-5 5h-1.5a1.5 1.5 0 0 0 0 3H14c0 .6-.9 1-2 1-4.4 0-8-3.6-8-8s3.6-8 8-8z',
  },
  {
    id: 'meetings',
    label: 'Meetings',
    // A waveform inside a rounded frame: recording, not a microphone — the mic
    // glyph already means dictation everywhere else in the app.
    icon: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8 10v4M12 8v8M16 11v2',
  },
  {
    id: 'models',
    label: 'Models',
    icon: 'M12 3 4 7.5v9L12 21l8-4.5v-9zM4 7.5 12 12l8-4.5M12 12v9',
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 13.6H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9.4a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  },
  {
    id: 'help',
    label: 'Help',
    icon: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .9-1 1.6v.3M12 17h.01',
  },
]

export function Sidebar({
  active,
  onSelect,
}: {
  active: SectionId
  onSelect: (id: SectionId) => void
}): React.JSX.Element {
  return (
    <nav className="flex w-56 shrink-0 flex-col border-r border-line bg-surface">
      {/* Space for the inset traffic lights on macOS; also the window drag area. */}
      <div className="h-11 shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />

      <div className="px-3 pb-2">
        <p className="flex items-center gap-2 px-3 pb-3 text-[13px] font-semibold tracking-tight text-ink">
          {/* The wordmark's glyph is the pill's own waveform, at rest. */}
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="size-[16px] text-accent"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
          >
            <path d="M4 10.5v3M8 8v8M12 5v14M16 8v8M20 10.5v3" />
          </svg>
          Murmur
        </p>
        <ul className="space-y-0.5">
          {SECTIONS.map((section) => {
            const isActive = section.id === active
            return (
              <li key={section.id}>
                <button
                  type="button"
                  onClick={() => onSelect(section.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={[
                    'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors duration-150',
                    isActive
                      ? 'bg-accent-soft font-medium text-accent'
                      : 'text-ink-muted hover:bg-canvas hover:text-ink active:bg-accent-soft/60',
                  ].join(' ')}
                >
                  <svg
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                    className={`size-[17px] shrink-0 ${isActive ? '' : 'opacity-80'}`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d={section.icon} />
                  </svg>
                  {section.label}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </nav>
  )
}
