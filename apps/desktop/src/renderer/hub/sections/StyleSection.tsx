import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  AppCategory,
  EmojiPolicy,
  FillerHandling,
  Formality,
  PolishingLevel,
  StyleProfile,
  StyleProfileSet,
} from '@murmur/shared'

import { Card, InlineError, Row, Section, Segmented, TextArea } from '../../components/Section'
import { useSettings } from '../../hooks/useSettings'
import { categoryLabel } from '../../lib/format'

/**
 * Style (PLAN §2.2.3).
 *
 * One global decision — how much Murmur may change what you said — and then a
 * card per app category, because the tone you want in Slack is not the tone you
 * want in an email. The category comes from the frontmost app's bundle id at
 * dictation time; nothing here reads your screen.
 */

const POLISHING_LEVELS: readonly { value: PolishingLevel; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'Insert the transcript exactly as recognised.' },
  {
    value: 'clean',
    label: 'Clean',
    hint: 'Punctuation, capitalisation, filler words and self-corrections.',
  },
  {
    value: 'rewrite',
    label: 'Rewrite',
    hint: 'Everything Clean does, plus tone and structure — lists, tightened sentences.',
  },
]

const FORMALITY: readonly { value: Formality; label: string }[] = [
  { value: 'casual', label: 'Casual' },
  { value: 'neutral', label: 'Neutral' },
  { value: 'formal', label: 'Formal' },
]

const FILLERS: readonly { value: FillerHandling; label: string; hint: string }[] = [
  { value: 'keep', label: 'Keep', hint: 'Leave “um” and “you know” where they are.' },
  { value: 'trim', label: 'Trim', hint: 'Remove the worst of them, keep the rhythm.' },
  { value: 'remove', label: 'Remove', hint: 'Take them all out.' },
]

const EMOJI: readonly { value: EmojiPolicy; label: string; hint: string }[] = [
  { value: 'never', label: 'Never', hint: 'Strip emoji even if you said “smiley face”.' },
  { value: 'preserve', label: 'If asked', hint: 'Only when you dictate one.' },
  { value: 'allow', label: 'Allow', hint: 'The model may add one where it fits.' },
]

const CATEGORY_HINTS: Record<AppCategory, string> = {
  personal: 'Messages, notes, anything not work — Messages, Notes, Discord.',
  work: 'Chat and documents at work — Slack, Teams, Linear, editors.',
  email: 'Mail clients, where a greeting and a sign-off matter.',
  other: 'Everything Murmur cannot place, including the terminal.',
}

/** Custom instructions save on a pause, not on every keystroke. */
const INSTRUCTION_DEBOUNCE_MS = 500

export function StyleSection(): React.JSX.Element {
  const { settings, update, error: settingsError } = useSettings()
  const [profiles, setProfiles] = useState<StyleProfileSet | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.murmur.style
      .get()
      .then(setProfiles)
      .catch((cause: unknown) => {
        setProfiles([])
        setError(messageOf(cause))
      })
  }, [])

  const patch = useCallback(
    (category: AppCategory, change: Partial<Omit<StyleProfile, 'category'>>) => {
      void window.murmur.style
        .set({ category, ...change })
        .then((next) => {
          setProfiles(next)
          setError(null)
        })
        .catch((cause: unknown) => setError(messageOf(cause)))
    },
    [],
  )

  const level = settings?.polishingLevel ?? 'clean'

  return (
    <Section
      title="Style"
      description="How much Murmur may change what you said, and how it should sound in each kind of app."
    >
      <InlineError>{settingsError ?? error}</InlineError>

      <Card className="mb-5">
        <Row
          label="Polishing level"
          hint="Applies everywhere. Off is the only setting where the text you see is exactly what the speech model heard."
        >
          {settings ? (
            <Segmented
              label="Polishing level"
              value={level}
              options={POLISHING_LEVELS}
              onChange={(value) => void update({ polishingLevel: value })}
            />
          ) : null}
        </Row>
        <div className="pt-3">
          <ul className="space-y-1.5">
            {POLISHING_LEVELS.map((option) => (
              <li key={option.value} className="flex gap-2 text-[12px] leading-relaxed">
                <span
                  className={`w-14 shrink-0 font-medium ${option.value === level ? 'text-accent' : 'text-ink-faint'}`}
                >
                  {option.label}
                </span>
                <span className="text-ink-muted">{option.hint}</span>
              </li>
            ))}
          </ul>
        </div>
      </Card>

      {profiles === null ? (
        <p className="py-6 text-center text-[13px] text-ink-muted">Loading…</p>
      ) : (
        <div className="space-y-4">
          {profiles.map((profile) => (
            <ProfileCard
              key={profile.category}
              profile={profile}
              disabled={level === 'off'}
              onChange={(change) => patch(profile.category, change)}
            />
          ))}
        </div>
      )}
    </Section>
  )
}

function ProfileCard({
  profile,
  disabled,
  onChange,
}: {
  profile: StyleProfile
  disabled: boolean
  onChange: (change: Partial<Omit<StyleProfile, 'category'>>) => void
}): React.JSX.Element {
  const instructionsId = `style-${profile.category}-instructions`

  return (
    <Card>
      <header className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="text-[15px] font-semibold text-ink">{categoryLabel(profile.category)}</h2>
        <p className="text-[12px] text-ink-muted">{CATEGORY_HINTS[profile.category]}</p>
      </header>

      {disabled ? (
        <p className="mb-3 text-[12px] text-warning">
          Polishing is off, so these are stored but not used.
        </p>
      ) : null}

      <Row label="Formality">
        <Segmented
          label={`${categoryLabel(profile.category)} formality`}
          value={profile.formality}
          options={FORMALITY}
          onChange={(formality) => onChange({ formality })}
        />
      </Row>
      <Row label="Filler words" hint="“um”, “uh”, “like”, and false starts.">
        <Segmented
          label={`${categoryLabel(profile.category)} filler words`}
          value={profile.fillerHandling}
          options={FILLERS}
          onChange={(fillerHandling) => onChange({ fillerHandling })}
        />
      </Row>
      <Row label="Emoji">
        <Segmented
          label={`${categoryLabel(profile.category)} emoji`}
          value={profile.emoji}
          options={EMOJI}
          onChange={(emoji) => onChange({ emoji })}
        />
      </Row>

      <div className="pt-4">
        <label htmlFor={instructionsId} className="mb-1.5 block text-[12px] font-medium text-ink">
          Custom instructions
        </label>
        <DebouncedTextArea
          id={instructionsId}
          label={`${categoryLabel(profile.category)} custom instructions`}
          value={profile.customInstructions}
          placeholder="e.g. Use British spelling. Never start a message with “Hi there”."
          onCommit={(customInstructions) => onChange({ customInstructions })}
        />
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">
          Added to the polishing prompt for this category. It cannot make Murmur answer questions or
          add content — the editor rules always win.
        </p>
      </div>
    </Card>
  )
}

/**
 * A textarea that saves on a pause.
 *
 * Every keystroke round-tripping to SQLite would be silly; losing what someone
 * typed because they navigated away would be worse, so the pending value is
 * flushed on unmount too.
 */
function DebouncedTextArea({
  id,
  label,
  value,
  placeholder,
  onCommit,
}: {
  id: string
  label: string
  value: string
  placeholder: string
  onCommit: (value: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const committed = useRef(value)
  const pending = useRef<string | null>(null)
  const commit = useRef(onCommit)
  useEffect(() => {
    commit.current = onCommit
  }, [onCommit])

  // Adopt an external change (another window edited the same profile).
  useEffect(() => {
    if (value === committed.current) return
    committed.current = value
    pending.current = null
    setDraft(value)
  }, [value])

  useEffect(() => {
    if (draft === committed.current) return
    pending.current = draft
    const timer = setTimeout(() => {
      committed.current = draft
      pending.current = null
      commit.current(draft)
    }, INSTRUCTION_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft])

  useEffect(
    () => () => {
      if (pending.current !== null) commit.current(pending.current)
    },
    [],
  )

  return (
    <TextArea id={id} label={label} value={draft} placeholder={placeholder} onChange={setDraft} />
  )
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
