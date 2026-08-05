import { useEffect, useState } from 'react'

import type { ModelsList } from '@murmur/shared'

import { Card, ComingSoon, Row, Section } from '../../components/Section'

/**
 * Models (PLAN §8).
 *
 * The catalog shown here has already passed the origin policy in the main
 * process — anything out of policy was rejected at load, not filtered here.
 * The policy is stated in the UI so it is auditable at a glance.
 */
export function ModelsSection(): React.JSX.Element {
  const [models, setModels] = useState<ModelsList | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void window.murmur.models
      .list()
      .then((value) => {
        if (active) setModels(value)
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      active = false
    }
  }, [])

  const policy = models?.catalog.originPolicy.join(', ') ?? '—'

  return (
    <Section
      title="Models"
      description="Choose the speech-to-text and polishing models Murmur runs locally. Both stay on this machine."
    >
      <Card className="mb-5">
        <Row label="Origin policy" hint="Enforced when the catalog loads, not merely displayed.">
          <span className="rounded-full border border-line px-2.5 py-1 text-[12px] font-medium text-ink-muted">
            {policy}
          </span>
        </Row>
        <Row label="Catalog entries">
          <span className="text-[13px] tabular-nums text-ink">
            {models?.catalog.models.length ?? '—'}
          </span>
        </Row>
        <Row label="Installed" hint="Disk used by downloaded weights.">
          <span className="text-[13px] tabular-nums text-ink">
            {models?.installed.length ?? '—'}
          </span>
        </Row>
      </Card>

      {error ? (
        <Card className="border-warning/40">
          <p className="text-[13px] text-warning">{error}</p>
        </Card>
      ) : (
        <ComingSoon>
          The catalog ships empty in this build. Entries, per-model cards with origin and licence
          badges, resumable checksum-verified downloads and custom-model import all arrive with the
          model manager.
        </ComingSoon>
      )}
    </Section>
  )
}
