import { useCallback, useEffect, useState } from 'react'

import type { DictionaryEntry } from '@murmur/shared'

import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  InlineError,
  Section,
  TextInput,
  Toggle,
} from '../../components/Section'
import { plural } from '../../lib/format'

/**
 * Dictionary (PLAN §2.2.2).
 *
 * Two kinds of entry, and the difference is worth stating plainly in the UI
 * because it decides what Murmur is allowed to do to your words:
 *
 *  - a **term** biases recognition (Whisper's initial prompt) and seeds the
 *    polish prompt, but never rewrites anything on its own;
 *  - a term **with a replacement** additionally substitutes, after
 *    transcription and before polishing.
 */
export function DictionarySection(): React.JSX.Element {
  const [entries, setEntries] = useState<DictionaryEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const reload = useCallback(() => {
    void window.murmur.dictionary
      .list()
      .then((value) => {
        setEntries(value)
        setError(null)
      })
      .catch((cause: unknown) => {
        setEntries([])
        setError(messageOf(cause))
      })
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const create = useCallback((term: string, replacement: string | null) => {
    void window.murmur.dictionary
      .create({ term, replacement, enabled: true })
      .then((entry) => {
        setEntries((current) => [...(current ?? []), entry])
        setAdding(false)
        setError(null)
      })
      .catch((cause: unknown) => setError(messageOf(cause)))
  }, [])

  const update = useCallback(
    (id: string, patch: { term?: string; replacement?: string | null; enabled?: boolean }) => {
      void window.murmur.dictionary
        .update({ id, patch })
        .then((entry) => {
          setEntries((current) =>
            (current ?? []).map((candidate) => (candidate.id === id ? entry : candidate)),
          )
          setError(null)
        })
        .catch((cause: unknown) => {
          setError(messageOf(cause))
          reload()
        })
    },
    [reload],
  )

  const remove = useCallback(
    (id: string) => {
      setEntries((current) => (current ?? []).filter((entry) => entry.id !== id))
      void window.murmur.dictionary.remove({ id }).catch((cause: unknown) => {
        setError(messageOf(cause))
        reload()
      })
    },
    [reload],
  )

  return (
    <Section
      title="Dictionary"
      description="Names, jargon and acronyms Murmur should get right — plus optional “replace X with Y” rules."
      actions={
        <Button tone="primary" onClick={() => setAdding(true)} disabled={adding}>
          Add a term
        </Button>
      }
    >
      <Card className="mb-5">
        <p className="text-[13px] leading-relaxed text-ink-muted">
          Every enabled term is fed to both halves of the pipeline: it biases what the
          speech-to-text model expects to hear, and it tells the polishing model how the word is
          spelled and capitalised. Add a replacement when you also want a substitution — “eta” →
          “ETA” — which runs on the raw transcript before polishing.
        </p>
      </Card>

      <InlineError>{error}</InlineError>

      {adding ? (
        <div className="mb-2">
          <EntryEditor
            initialTerm=""
            initialReplacement=""
            submitLabel="Add"
            onCancel={() => setAdding(false)}
            onSubmit={create}
          />
        </div>
      ) : null}

      {entries === null ? (
        <p className="py-6 text-center text-[13px] text-ink-muted">Loading…</p>
      ) : entries.length === 0 && !adding ? (
        <EmptyState
          title="Your dictionary is empty"
          actions={
            <Button tone="primary" onClick={() => setAdding(true)}>
              Add your first term
            </Button>
          }
        >
          Good first entries are the words dictation always gets wrong: colleagues’ names, product
          names, and the acronyms your team says out loud.
        </EmptyState>
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <li key={entry.id}>
              <EntryRow
                entry={entry}
                onToggle={(enabled) => update(entry.id, { enabled })}
                onSave={(term, replacement) => update(entry.id, { term, replacement })}
                onDelete={() => remove(entry.id)}
              />
            </li>
          ))}
        </ul>
      )}

      {entries && entries.length > 0 ? (
        <p className="mt-3 text-[12px] text-ink-faint">
          {plural(entries.filter((entry) => entry.enabled).length, 'term')} in use
        </p>
      ) : null}
    </Section>
  )
}

function EntryRow({
  entry,
  onToggle,
  onSave,
  onDelete,
}: {
  entry: DictionaryEntry
  onToggle: (enabled: boolean) => void
  onSave: (term: string, replacement: string | null) => void
  onDelete: () => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <EntryEditor
        initialTerm={entry.term}
        initialReplacement={entry.replacement ?? ''}
        submitLabel="Save"
        onCancel={() => setEditing(false)}
        onSubmit={(term, replacement) => {
          onSave(term, replacement)
          setEditing(false)
        }}
      />
    )
  }

  return (
    <Card className="flex items-center gap-3 py-3">
      <Toggle
        checked={entry.enabled}
        onChange={onToggle}
        label={`Use “${entry.term}” when transcribing`}
      />
      <div className="min-w-0 flex-1">
        <p
          className={`select-text truncate text-[13px] ${entry.enabled ? 'text-ink' : 'text-ink-faint line-through'}`}
        >
          {entry.term}
          {entry.replacement ? (
            <span className="text-ink-muted"> → {entry.replacement}</span>
          ) : null}
        </p>
      </div>
      <Badge tone={entry.replacement ? 'accent' : 'neutral'}>
        {entry.replacement ? 'Replaces' : 'Recognition only'}
      </Badge>
      <IconButton label={`Edit ${entry.term}`} onClick={() => setEditing(true)}>
        <path d="M5 19h3l9-9-3-3-9 9zM14.5 5.5l3 3" />
      </IconButton>
      <IconButton label={`Delete ${entry.term}`} tone="danger" onClick={onDelete}>
        <path d="M5 7h14M10 7V5h4v2M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
      </IconButton>
    </Card>
  )
}

function EntryEditor({
  initialTerm,
  initialReplacement,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initialTerm: string
  initialReplacement: string
  submitLabel: string
  onSubmit: (term: string, replacement: string | null) => void
  onCancel: () => void
}): React.JSX.Element {
  const [term, setTerm] = useState(initialTerm)
  const [replacement, setReplacement] = useState(initialReplacement)
  const valid = term.trim().length > 0

  const submit = (): void => {
    if (!valid) return
    onSubmit(term.trim(), replacement.trim().length > 0 ? replacement.trim() : null)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') submit()
    if (event.key === 'Escape') onCancel()
  }

  return (
    <Card>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[180px] flex-1">
          <label className="mb-1 block text-[12px] font-medium text-ink" htmlFor="dictionary-term">
            Term
          </label>
          <TextInput
            id="dictionary-term"
            label="Term"
            value={term}
            onChange={setTerm}
            onKeyDown={onKeyDown}
            placeholder="Murmur"
          />
        </div>
        <div className="min-w-[180px] flex-1">
          <label
            className="mb-1 block text-[12px] font-medium text-ink"
            htmlFor="dictionary-replacement"
          >
            Replace with <span className="font-normal text-ink-faint">(optional)</span>
          </label>
          <TextInput
            id="dictionary-replacement"
            label="Replacement"
            value={replacement}
            onChange={setReplacement}
            onKeyDown={onKeyDown}
            placeholder="leave empty to only improve recognition"
          />
        </div>
        <div className="flex gap-2">
          <Button tone="primary" onClick={submit} disabled={!valid}>
            {submitLabel}
          </Button>
          <Button tone="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  )
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
