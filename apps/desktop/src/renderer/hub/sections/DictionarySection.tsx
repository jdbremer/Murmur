import { useEffect, useRef, useState } from 'react'

import type { DictionaryEntry } from '@murmur/shared'

import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorCard,
  Section,
  TextInput,
  Toggle,
} from '../../components/Section'

/**
 * Dictionary (PLAN §2.2.2) — vocabulary boosts and replacement rules.
 *
 * The two columns do genuinely different things, which the UI has to make
 * obvious or the feature is confusing:
 *
 *  - **Term only** steers *recognition*. It seeds Whisper's initial prompt and
 *    the polish prompt, so "Anthropic" stops coming back as "anthropic" or
 *    "and tropic". It never rewrites text on its own.
 *  - **Term → replacement** additionally runs as a literal post-STT
 *    substitution, before polishing, so the polish prompt sees the corrected
 *    spelling (PLAN §6.4).
 */
export function DictionarySection(): React.JSX.Element {
  const [entries, setEntries] = useState<DictionaryEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [term, setTerm] = useState('')
  const [replacement, setReplacement] = useState('')

  const active = useRef(true)

  useEffect(() => {
    active.current = true
    void window.murmur.dictionary
      .list()
      .then((value) => {
        if (active.current) setEntries(value)
      })
      .catch((cause: unknown) => {
        if (!active.current) return
        setError(cause instanceof Error ? cause.message : String(cause))
        setEntries([])
      })
    return () => {
      active.current = false
    }
  }, [])

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action()
      const next = await window.murmur.dictionary.list()
      if (active.current) {
        setEntries(next)
        setError(null)
      }
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const create = async (): Promise<void> => {
    const trimmedTerm = term.trim()
    if (!trimmedTerm) return
    const trimmedReplacement = replacement.trim()
    await run(() =>
      window.murmur.dictionary.create({
        term: trimmedTerm,
        // An empty replacement means "boost only" — the schema wants null, not
        // an empty string, and the difference is the whole feature.
        replacement: trimmedReplacement ? trimmedReplacement : null,
        enabled: true,
      }),
    )
    setTerm('')
    setReplacement('')
  }

  return (
    <Section
      title="Dictionary"
      description="Proper nouns, jargon and acronyms Murmur should get right — plus optional “replace X with Y” rules."
    >
      {error ? <ErrorCard>{error}</ErrorCard> : null}

      <Card className="mb-5">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label className="mb-1 block text-[12px] font-medium text-ink-muted" htmlFor="term">
              Term
            </label>
            <TextInput
              value={term}
              onChange={setTerm}
              ariaLabel="Term"
              placeholder="Anthropic"
              onKeyDown={(event) => {
                if (event.key === 'Enter') void create()
              }}
            />
          </div>
          <div className="flex-1">
            <label className="mb-1 block text-[12px] font-medium text-ink-muted">
              Replace with <span className="text-ink-faint">(optional)</span>
            </label>
            <TextInput
              value={replacement}
              onChange={setReplacement}
              ariaLabel="Replacement"
              placeholder="leave empty to only boost recognition"
              onKeyDown={(event) => {
                if (event.key === 'Enter') void create()
              }}
            />
          </div>
          <Button onClick={() => void create()} variant="primary" disabled={!term.trim()}>
            Add
          </Button>
        </div>
      </Card>

      {entries === null ? (
        <EmptyState>Loading…</EmptyState>
      ) : entries.length === 0 ? (
        <EmptyState>
          Your dictionary is empty. Terms here feed both stages: the speech model’s prompt for
          recognition, and the polish prompt for spelling and casing.
        </EmptyState>
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <li key={entry.id}>
              <Card>
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="select-text text-[13px] text-ink">
                      <span className="font-medium">{entry.term}</span>
                      {entry.replacement ? (
                        <>
                          <span className="mx-1.5 text-ink-faint">→</span>
                          <span>{entry.replacement}</span>
                        </>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-[12px] text-ink-faint">
                      {entry.replacement ? 'Boosts recognition and replaces' : 'Boosts recognition'}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-3">
                    {!entry.enabled ? <Badge tone="neutral">Off</Badge> : null}
                    <Toggle
                      label={`Enable ${entry.term}`}
                      checked={entry.enabled}
                      onChange={(enabled) =>
                        void run(() =>
                          window.murmur.dictionary.update({ id: entry.id, patch: { enabled } }),
                        )
                      }
                    />
                    <Button
                      variant="danger"
                      onClick={() =>
                        void run(() => window.murmur.dictionary.remove({ id: entry.id }))
                      }
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
