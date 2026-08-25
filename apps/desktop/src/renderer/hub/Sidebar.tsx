import type { SectionId } from './navigation'

interface SectionMeta {
  id: SectionId
  label: string
  /** Single SVG path, 24×24 viewBox, stroked. */
  icon: string
}

interface SectionGroup {
  /** Omitted for the first group: the app name above it is its heading. */
  label?: string
  /** Pushed to the bottom of the sidebar. */
  pinned?: boolean
  items: readonly SectionMeta[]
}

/**
 * The sidebar, in four groups rather than one list of thirteen.
 *
 * Thirteen flat items is a list you read; four groups of three or four is
 * navigation you scan. The grouping is by what you came to do — look at
 * something, shape how Murmur writes, capture something longer, or configure
 * the app — and the last group is pinned to the bottom because Models,
 * Settings and Help are where you go when something is wrong, not where you go
 * to work. That is also the shape a Mac user already has in System Settings.
 */
const GROUPS: readonly SectionGroup[] = [
  {
    items: [
      {
        id: 'dashboard',
        label: 'Dashboard',
        // Panels of unequal size: the universal "overview" glyph, and the one
        // shape in the sidebar that is not a picture of a thing.
        icon: 'M4 5h6v6H4zM14 5h6v4h-6zM14 13h6v6h-6zM4 15h6v4H4z',
      },
      {
        id: 'history',
        // Was "Home", which is where the transcript feed has always lived and
        // the last place anyone looked for it. A clock face says what it holds.
        label: 'History',
        icon: 'M12 21a9 9 0 1 0-8.9-10.4M12 7v5l3.5 2M3 4v4h4',
      },
      {
        id: 'ask',
        label: 'Ask',
        // A speech bubble with a question inside it, sharing the question-mark
        // stroke with Help — the two are the only places in the app you ask
        // something rather than do something.
        icon: 'M12 20a8 7 0 1 0-6.9-3.9L4 20l4.1-.8A8 7 0 0 0 12 20zM10.3 9.6a1.8 1.8 0 1 1 2.4 1.7c-.4.2-.7.6-.7 1.1v.2M12 15.2h.01',
      },
      {
        id: 'insights',
        label: 'Insights',
        // A rising bar chart.
        icon: 'M5 20V12M12 20V5M19 20v-5',
      },
    ],
  },
  {
    label: 'Your words',
    items: [
      {
        id: 'notes',
        label: 'Scratchpad',
        // A page with a folded corner and two lines of writing.
        icon: 'M6 4h8l4 4v12H6zM14 4v4h4M9 13h6M9 16.5h4',
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
        id: 'vibeCoding',
        label: 'Vibe coding',
        // Angle brackets with a slash: the universal "this is code".
        icon: 'm8 8-4 4 4 4M16 8l4 4-4 4M13.5 5.5l-3 13',
      },
    ],
  },
  {
    label: 'Longer form',
    items: [
      {
        id: 'meetings',
        label: 'Meetings',
        // A waveform inside a rounded frame: recording, not a microphone — the
        // mic glyph already means dictation everywhere else in the app.
        icon: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8 10v4M12 8v8M16 11v2',
      },
      {
        id: 'transcribe',
        label: 'Transcribe',
        // A page with sound in it: the file the user drops, waveform inside.
        icon: 'M6 4h8l4 4v12H6zM14 4v4h4M9 14v2.5M12 12.5v5.5M15 14v2.5',
      },
    ],
  },
  {
    pinned: true,
    items: [
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
    ],
  },
]

/** Every section, flattened — the command palette and tests both want this. */
export const ALL_SECTIONS: readonly SectionMeta[] = GROUPS.flatMap((group) => group.items)

export function Sidebar({
  active,
  collapsed,
  onSelect,
  onToggle,
}: {
  active: SectionId
  /** Icon-only rail. Persisted in settings, so it survives a relaunch. */
  collapsed: boolean
  onSelect: (id: SectionId) => void
  onToggle: () => void
}): React.JSX.Element {
  return (
    <nav
      aria-label="Sections"
      // Width animates; everything inside either fits both widths or fades.
      // `motion-reduce` pins the duration, so the fold is instant under Reduce
      // Motion instead of a slide.
      className={[
        'flex shrink-0 flex-col overflow-hidden bg-canvas transition-[width] duration-200 ease-out motion-reduce:transition-none',
        collapsed ? 'w-[64px]' : 'w-56',
      ].join(' ')}
    >
      {/* Space for the inset traffic lights on macOS; also the window drag area. */}
      <div className="h-11 shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />

      <div
        className={`flex min-h-0 flex-1 flex-col overflow-y-auto pb-3 ${collapsed ? 'px-2.5' : 'px-3'}`}
      >
        <p
          className={`flex items-center gap-2 pb-3 text-[13px] font-semibold tracking-tight text-ink ${collapsed ? 'justify-center px-0' : 'px-3'}`}
        >
          {/* The wordmark's glyph is the pill's own waveform, at rest. */}
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="size-[16px] shrink-0 text-accent"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
          >
            <path d="M4 10.5v3M8 8v8M12 5v14M16 8v8M20 10.5v3" />
          </svg>
          {collapsed ? null : 'Murmur'}
        </p>

        {GROUPS.map((group, index) => (
          <div key={group.label ?? index} className={group.pinned ? 'mt-auto pt-4' : 'mb-4'}>
            {group.label && !collapsed ? (
              <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                {group.label}
              </p>
            ) : null}
            {/* Collapsed, a group is only its items — a hairline between groups
                keeps the rhythm the labels were carrying. */}
            {group.label && collapsed ? (
              <div aria-hidden="true" className="mx-2 mb-2 h-px bg-line" />
            ) : null}
            <ul className="space-y-0.5">
              {group.items.map((section) => (
                <li key={section.id}>
                  <SidebarItem
                    section={section}
                    active={section.id === active}
                    collapsed={collapsed}
                    onSelect={onSelect}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}

      </div>

      {/* The fold, in its own footer *outside* the scroll area. Inside it, the
          button sits below the pinned group and needs a scroll nobody knows to
          make before it is even visible — a control that has to be found is a
          control that does not exist. */}
      <div className={`shrink-0 border-t border-line pb-2 pt-1.5 ${collapsed ? 'px-2.5' : 'px-3'}`}>
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
          aria-expanded={!collapsed}
          title={`${collapsed ? 'Expand' : 'Collapse'} the sidebar (⌘\\)`}
          className={[
            'flex w-full items-center gap-3 rounded-lg py-2 text-[12px] text-ink-faint transition-colors duration-150 hover:bg-ink/[0.04] hover:text-ink',
            collapsed ? 'justify-center px-0' : 'px-3',
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
            {/* A panel with its divider, and a chevron pointing the way out. */}
            <path d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM9 5v14" />
            <path d={collapsed ? 'm13.5 9.5 3 2.5-3 2.5' : 'm16.5 9.5-3 2.5 3 2.5'} />
          </svg>
          {collapsed ? null : 'Collapse'}
        </button>
      </div>
    </nav>
  )
}

function SidebarItem({
  section,
  active,
  collapsed,
  onSelect,
}: {
  section: SectionMeta
  active: boolean
  collapsed: boolean
  onSelect: (id: SectionId) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onSelect(section.id)}
      aria-current={active ? 'page' : undefined}
      // The label collapses into a tooltip rather than disappearing.
      title={collapsed ? section.label : undefined}
      aria-label={collapsed ? section.label : undefined}
      className={[
        'flex w-full items-center gap-3 rounded-lg py-2 text-[13px] transition-colors duration-150',
        collapsed ? 'justify-center px-0' : 'px-3',
        // Neutral rather than brand-tinted, like the reference: the active pill
        // is a slightly sunken patch of the canvas, not an accent chip.
        active
          ? 'bg-ink/[0.07] font-medium text-ink'
          : 'text-ink-muted hover:bg-ink/[0.04] hover:text-ink active:bg-ink/[0.08]',
      ].join(' ')}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className={`size-[17px] shrink-0 ${active ? '' : 'opacity-80'}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={section.icon} />
      </svg>
      {collapsed ? null : section.label}
    </button>
  )
}
