import { useEffect, useState } from 'react'

import type { StyleProfileSet } from '@murmur/shared'

import { Card, ComingSoon, Row, Section, Select } from '../../components/Section'
import { useSettings } from '../../hooks/useSettings'

const POLISHING_LEVELS = [
  { value: 'off' as const, label: 'Off — raw transcript' },
  { value: 'clean' as const, label: 'Clean — punctuation & fillers' },
  { value: 'rewrite' as const, label: 'Rewrite — tone & structure' },
]

/** Style (PLAN §2.2.3) — the global polishing level plus per-category tone. */
export function StyleSection(): React.JSX.Element {
  const { settings, update } = useSettings()
  const [profiles, setProfiles] = useState<StyleProfileSet>([])

  useEffect(() => {
    let active = true
    void window.murmur.style
      .get()
      .then((value) => {
        if (active) setProfiles(value)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  return (
    <Section
      title="Style"
      description="How much Murmur is allowed to change what you said, and how it should sound in each kind of app."
    >
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

      <Card className="mb-5">
        {profiles.map((profile) => (
          <Row
            key={profile.category}
            label={capitalise(profile.category)}
            hint={`${profile.formality} · fillers: ${profile.fillerHandling} · emoji: ${profile.emoji}`}
          >
            <span className="text-[12px] text-ink-faint">read-only</span>
          </Row>
        ))}
      </Card>

      <ComingSoon>
        Editing tone per app category — and the bundle-id → category mapping that drives it — lands
        with the polishing pipeline.
      </ComingSoon>
    </Section>
  )
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
