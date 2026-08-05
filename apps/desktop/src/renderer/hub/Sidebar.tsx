export type SectionId = 'home' | 'dictionary' | 'style' | 'models' | 'settings' | 'help'

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
    id: 'style',
    label: 'Style',
    icon: 'M12 4c4.4 0 8 3.1 8 7 0 3.3-2.7 5-5 5h-1.5a1.5 1.5 0 0 0 0 3H14c0 .6-.9 1-2 1-4.4 0-8-3.6-8-8s3.6-8 8-8z',
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
        <p className="px-3 pb-3 text-[13px] font-semibold tracking-tight text-ink">Murmur</p>
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
                    'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors',
                    isActive
                      ? 'bg-accent-soft font-medium text-accent'
                      : 'text-ink-muted hover:bg-canvas hover:text-ink',
                  ].join(' ')}
                >
                  <svg
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                    className="size-[17px] shrink-0"
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
