import { useEffect, useState } from 'react'

import type { DictionaryEntry } from '@murmur/shared'

import { Card, ComingSoon, Section } from '../../components/Section'

/** Dictionary (PLAN §2.2.2) — vocabulary boosts and replacement rules. */
export function DictionarySection(): React.JSX.Element {
  const [entries, setEntries] = useState<DictionaryEntry[]>([])

  useEffect(() => {
    let active = true
    void window.murmur.dictionary
      .list()
      .then((value) => {
        if (active) setEntries(value)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  return (
    <Section
      title="Dictionary"
      description="Proper nouns, jargon and acronyms Murmur should get right — plus optional “replace X with Y” rules."
    >
      {entries.length > 0 ? (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <Card key={entry.id}>
              <p className="select-text text-[13px] text-ink">
                {entry.term}
                {entry.replacement ? ` → ${entry.replacement}` : ''}
              </p>
            </Card>
          ))}
        </ul>
      ) : (
        <ComingSoon>
          Your dictionary is empty. Terms here feed both stages: Whisper’s initial prompt for
          recognition, and the polish prompt for spelling and casing. Editing arrives with the store
          in the next stage.
        </ComingSoon>
      )}
    </Section>
  )
}
