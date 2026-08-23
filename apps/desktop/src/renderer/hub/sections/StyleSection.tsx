import { useEffect, useRef, useState } from 'react'

import {
  formalityOptionsFor,
  type AppCategory,
  type EmojiPolicy,
  type FillerHandling,
  type Formality,
  type StyleProfile,
  type StyleProfileSet,
} from '@murmur/shared'

import { Card, ErrorCard, Row, Section, Select } from '../../components/Section'
import { useSettings } from '../../hooks/useSettings'
import { errorMessage } from '../../lib/errors'

/**
 * Style (PLAN §2.2.3) — the global polishing level plus per-category tone.
 *
 * Categories are derived from the frontmost app's bundle id at hotkey-down, so
 * these profiles are the answer to "sound professional in Slack but not in
 * Messages" without the user having to switch anything by hand. Each panel
 * writes through `style.set`, which patches exactly the named profile and
 * re-validates the whole set.
 */

const POLISHING_LEVELS = [
  { value: 'off' as const, label: 'Off — raw transcript' },
  { value: 'clean' as const, label: 'Clean — punctuation & fillers' },
  { value: 'rewrite' as const, label: 'Rewrite — tone & structure' },
]

/**
 * Labels only. *Which* of these a category offers comes from
 * `formalityOptionsFor` in shared, so the Style UI and the polish prompt can
 * never disagree about what is selectable — and Neutral is absent from both.
 */
const FORMALITY_LABELS: Record<Formality, string> = {
  veryCasual: 'Very casual',
  casual: 'Casual',
  neutral: 'Neutral (retired)',
  formal: 'Formal',
  excited: 'Excited',
}

function formalityOptions(category: AppCategory): { value: Formality; label: string }[] {
  return formalityOptionsFor(category).map((value) => ({ value, label: FORMALITY_LABELS[value] }))
}

const FILLERS: { value: FillerHandling; label: string }[] = [
  { value: 'keep', label: 'Keep them' },
  { value: 'trim', label: 'Trim the worst' },
  { value: 'remove', label: 'Remove them' },
]

const EMOJI: { value: EmojiPolicy; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: 'preserve', label: 'Only if I say one' },
  { value: 'allow', label: 'Allowed' },
]

const CATEGORY_HINT: Record<AppCategory, string> = {
  personal: 'Messages, WhatsApp, Discord — anything conversational.',
  work: 'Slack, Teams, Jira, your editor.',
  email: 'Mail, Gmail, Outlook, Superhuman.',
  other: 'Everything Murmur cannot confidently place.',
}

export function StyleSection(): React.JSX.Element {
  const { settings, update } = useSettings()
  const [profiles, setProfiles] = useState<StyleProfileSet | null>(null)
  const [error, setError] = useState<string | null>(null)

  const active = useRef(true)

  useEffect(() => {
    active.current = true
    void window.murmur.style
      .get()
      .then((value) => {
        if (active.current) setProfiles(value)
      })
      .catch((cause: unknown) => {
        if (!active.current) return
        setError(errorMessage(cause))
        setProfiles([])
      })
    return () => {
      active.current = false
    }
  }, [])

  const patch = async (
    category: AppCategory,
    change: Partial<Omit<StyleProfile, 'category'>>,
  ): Promise<void> => {
    try {
      const next = await window.murmur.style.set({ category, ...change })
      if (active.current) {
        setProfiles(next)
        setError(null)
      }
    } catch (cause) {
      if (active.current) setError(errorMessage(cause))
    }
  }

  const polishingOff = settings?.polishingLevel === 'off'

  return (
    <Section
      title="Style"
      description="How much Murmur is allowed to change what you said, and how it should sound in each kind of app."
    >
      {error ? <ErrorCard>{error}</ErrorCard> : null}

      <Card className="mb-5">
        <Row label="Polishing level" hint="Applies everywhere unless a category overrides it.">
          {settings ? (
            <Select
              value={settings.polishingLevel}
              options={POLISHING_LEVELS}
              onChange={(value) => void update({ polishingLevel: value })}
            />
          ) : null}
        </Row>
      </Card>

      {polishingOff ? (
        <Card tone="dashed" className="mb-5">
          <p className="text-[13px] leading-relaxed text-ink-muted">
            Polishing is off, so these profiles are not used — the raw transcript is inserted as
            spoken. They are still editable, and take effect as soon as you turn polishing back on.
          </p>
        </Card>
      ) : null}

      {(profiles ?? []).map((profile) => (
        <Card key={profile.category} className="mb-4">
          <div className="mb-1">
            <h2 className="text-[15px] font-semibold text-ink">{capitalise(profile.category)}</h2>
            <p className="mt-0.5 text-[12px] text-ink-muted">{CATEGORY_HINT[profile.category]}</p>
          </div>

          <Row label="Formality">
            <Select
              value={profile.formality}
              options={formalityOptions(profile.category)}
              onChange={(formality) => void patch(profile.category, { formality })}
            />
          </Row>
          <Row label="Filler words" hint="“um”, “uh”, “like”, and false starts.">
            <Select
              value={profile.fillerHandling}
              options={FILLERS}
              onChange={(fillerHandling) => void patch(profile.category, { fillerHandling })}
            />
          </Row>
          <Row label="Emoji">
            <Select
              value={profile.emoji}
              options={EMOJI}
              onChange={(emoji) => void patch(profile.category, { emoji })}
            />
          </Row>

          <div className="pt-3">
            <label className="mb-1.5 block text-[13px] font-medium text-ink">
              Custom instructions
            </label>
            <CustomInstructions
              value={profile.customInstructions}
              onCommit={(customInstructions) =>
                void patch(profile.category, { customInstructions })
              }
            />
          </div>
        </Card>
      ))}
    </Section>
  )
}

/**
 * Free text appended to the system prompt for one category.
 *
 * Kept as local state and committed on blur rather than on every keystroke:
 * each commit is a disk write plus a prompt rebuild, and firing one per
 * character would be both wasteful and visibly laggy.
 */
function CustomInstructions({
  value,
  onCommit,
}: {
  value: string
  onCommit: (value: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const committed = useRef(value)

  // Adopt external changes (another window edited the same profile) without
  // stomping on what is being typed here.
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value
      setDraft(value)
    }
  }, [value])

  return (
    <textarea
      value={draft}
      maxLength={2000}
      rows={2}
      aria-label="Custom instructions"
      placeholder="e.g. Prefer British spelling. Never start a message with “Hi there”."
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft === committed.current) return
        committed.current = draft
        onCommit(draft)
      }}
      className="w-full resize-y rounded-lg border border-line bg-surface px-2.5 py-2 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-faint focus:border-accent"
    />
  )
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
