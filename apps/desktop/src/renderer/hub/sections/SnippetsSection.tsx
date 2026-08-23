import { useEffect, useRef, useState } from 'react'

import type { Snippet } from '@murmur/shared'

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
import { SkeletonList } from '../../components/Skeleton'
import { useToast } from '../components/ToastHost'
import { errorMessage } from '../../lib/errors'

/**
 * Snippets (PLAN §2.2.2) — say a short phrase, insert a stored block of text.
 *
 * Deliberately next to the Dictionary, and deliberately not part of it. The
 * Dictionary is about being *heard* correctly; a snippet is about typing less.
 * The give-away in the UI is the expansion field: it is a textarea, because
 * what people store here is an address, a calendar link, or a paragraph of
 * boilerplate — none of which fit the Dictionary's single-word replacement.
 */
export function SnippetsSection(): React.JSX.Element {
  const [snippets, setSnippets] = useState<Snippet[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [trigger, setTrigger] = useState('')
  const [expansion, setExpansion] = useState('')
  const toast = useToast()

  const active = useRef(true)

  useEffect(() => {
    active.current = true
    void window.murmur.snippets
      .list()
      .then((value) => {
        if (active.current) setSnippets(value)
      })
      .catch((cause: unknown) => {
        if (!active.current) return
        setError(errorMessage(cause))
        setSnippets([])
      })
    return () => {
      active.current = false
    }
  }, [])

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action()
      const next = await window.murmur.snippets.list()
      if (active.current) {
        setSnippets(next)
        setError(null)
      }
    } catch (cause) {
      if (active.current) setError(errorMessage(cause))
    }
  }

  const create = async (): Promise<void> => {
    const trimmedTrigger = trigger.trim()
    // The expansion keeps its internal shape — a multi-line address is the
    // point — but leading and trailing whitespace would land in the message.
    const trimmedExpansion = expansion.trim()
    if (!trimmedTrigger || !trimmedExpansion) return
    await run(() =>
      window.murmur.snippets.create({
        trigger: trimmedTrigger,
        expansion: trimmedExpansion,
        enabled: true,
      }),
    )
    setTrigger('')
    setExpansion('')
  }

  return (
    <Section
      title="Snippets"
      description="Say a short phrase and Murmur types the whole thing — a calendar link, an address, a standard reply."
    >
      {error ? <ErrorCard>{error}</ErrorCard> : null}

      <Card className="mb-5">
        <div className="mb-2">
          <label className="mb-1 block text-[12px] font-medium text-ink-muted" htmlFor="trigger">
            When I say
          </label>
          <TextInput
            value={trigger}
            onChange={setTrigger}
            ariaLabel="Trigger phrase"
            placeholder="my calendar link"
            onKeyDown={(event) => {
              if (event.key === 'Enter') void create()
            }}
          />
        </div>
        <div className="mb-3">
          <label className="mb-1 block text-[12px] font-medium text-ink-muted" htmlFor="expansion">
            Type this
          </label>
          <textarea
            id="expansion"
            aria-label="Expansion"
            value={expansion}
            onChange={(event) => setExpansion(event.target.value)}
            rows={3}
            placeholder="https://cal.example/you"
            className="w-full resize-y rounded-md border border-edge bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
          />
        </div>
        <div className="flex justify-end">
          <Button
            onClick={() => void create()}
            variant="primary"
            disabled={!trigger.trim() || !expansion.trim()}
          >
            Add
          </Button>
        </div>
      </Card>

      {snippets === null ? (
        <SkeletonList label="Loading your snippets…" rows={4} seed={3} />
      ) : snippets.length === 0 ? (
        <EmptyState
          icon="snippets"
          title="No snippets yet"
          action={
            <Button
              onClick={() => {
                setTrigger('my email')
                setExpansion('')
              }}
            >
              Try an example
            </Button>
          }
        >
          Say a short phrase, get a stored block of text. Snippets expand after polishing, so what
          you store here comes out exactly as written — links and addresses are never reworded.
        </EmptyState>
      ) : (
        <ul className="space-y-2">
          {snippets.map((snippet) => (
            <li key={snippet.id}>
              <Card>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="select-text text-[13px] font-medium text-ink">
                      “{snippet.trigger}”
                    </p>
                    <p className="mt-0.5 select-text whitespace-pre-wrap break-words text-[12px] text-ink-muted">
                      {snippet.expansion}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-3">
                    {!snippet.enabled ? <Badge tone="neutral">Off</Badge> : null}
                    <Toggle
                      label={`Enable ${snippet.trigger}`}
                      checked={snippet.enabled}
                      onChange={(enabled) =>
                        void run(() =>
                          window.murmur.snippets.update({ id: snippet.id, patch: { enabled } }),
                        )
                      }
                    />
                    <Button
                      variant="danger"
                      onClick={() =>
                        void run(() => window.murmur.snippets.remove({ id: snippet.id })).then(() =>
                          toast.show({
                            message: `Removed “${snippet.trigger}”`,
                            actionLabel: 'Undo',
                            onAction: () => {
                              void run(() =>
                                window.murmur.snippets.create({
                                  trigger: snippet.trigger,
                                  expansion: snippet.expansion,
                                  enabled: snippet.enabled,
                                }),
                              )
                            },
                          }),
                        )
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
