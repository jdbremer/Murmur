import { useState } from 'react'

import { Badge, Banner, Button, Card, Row, Section, Toggle } from '../../components/Section'
import { SkeletonRows } from '../../components/Skeleton'
import { useSettings } from '../../hooks/useSettings'
import { isMacPlatform } from '../../lib/platform'

/**
 * Vibe coding (PLAN §18.3).
 *
 * Its own section rather than a row in Settings, because it is the one feature
 * in Murmur that changes *what the app reads*, and burying that three screens
 * down a scrolling page would be the wrong way to present it. The card at the
 * top says so before either switch does anything.
 */

type Probe = {
  ide: 'vscode' | 'cursor' | 'windsurf' | null
  readable: boolean
  symbolCount: number
  detail: string
  frontmostApp: string | null
}

export function VibeCodingSection(): React.JSX.Element {
  const { settings, update, error } = useSettings()
  const [probe, setProbe] = useState<Probe | null>(null)
  const [checking, setChecking] = useState(false)

  if (!settings) {
    return (
      <Section title="Vibe coding" description="Dictation that knows the code you are looking at.">
        <SkeletonRows label="Loading vibe coding settings…" rows={4} />
      </Section>
    )
  }

  const vibe = settings.vibeCoding
  const isMac = isMacPlatform()

  const check = (): void => {
    setChecking(true)
    void window.murmur.vibeCoding
      .probe()
      .then(setProbe)
      .catch(() => setProbe(null))
      .finally(() => setChecking(false))
  }

  return (
    <Section
      title="Vibe coding"
      description="Dictate variable names, function names and filenames and have them come out spelled the way they are written."
    >
      {error ? (
        <Banner tone="danger" title="Could not save that setting">
          {error}
        </Banner>
      ) : null}

      {/* The honesty card. This feature is the exception to the promise the
          rest of the app makes, and the user should read that here rather than
          discover it. */}
      <Card className="mb-5">
        <h2 className="text-[13px] font-semibold text-ink">What this reads</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">
          With this on, Murmur reads the text of the editor you are dictating into — but only in{' '}
          <span className="text-ink">VS Code, Cursor and Windsurf</span>, and only while you are
          holding your dictation key. It pulls out the names in the file, uses them to recognise
          what you said, and throws them away seconds later. Nothing is written to disk, nothing is
          logged, and nothing leaves this machine. Password fields are refused outright.
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
          Everywhere else in Murmur, all the app learns about the program you are dictating into is
          its name. This is the exception, which is why it is off until you turn it on.
        </p>
      </Card>

      {!isMac ? (
        <Banner tone="warning" title="Not available on this platform yet">
          Reading the editor is macOS-only for now. The switches below are here so the setting
          travels with a synced config, but nothing will be read on this platform.
        </Banner>
      ) : null}

      <Card className="mb-5">
        <Row
          label="Variable recognition"
          hint="Feeds the names in the open file to speech recognition, so useCallback comes back as one word."
        >
          <Toggle
            label="Variable recognition"
            checked={vibe.variableRecognition}
            onChange={(variableRecognition) =>
              void update({
                vibeCoding: {
                  variableRecognition,
                  // Tagging depends on this read for the list of real
                  // filenames, so turning the read off turns tagging off too
                  // rather than leaving a switch on that silently does nothing.
                  fileTagging: variableRecognition && vibe.fileTagging,
                },
              })
            }
          />
        </Row>
        <Row
          label="File tagging in chat"
          hint={
            vibe.variableRecognition
              ? 'Say “index dot ts” and get index.ts — prefixed with @ in Cursor and Windsurf so their chat attaches the file.'
              : 'Needs variable recognition, which supplies the list of files that actually exist.'
          }
        >
          <Toggle
            label="File tagging in chat"
            disabled={!vibe.variableRecognition}
            checked={vibe.fileTagging}
            onChange={(fileTagging) => void update({ vibeCoding: { ...vibe, fileTagging } })}
          />
        </Row>
      </Card>

      <Card>
        <h2 className="text-[13px] font-semibold text-ink">Set up your editor</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">
          VS Code and its forks draw the editor on a canvas, so its text is invisible to Murmur
          until you turn on the editor&rsquo;s own accessibility mode. Murmur cannot do this for you
          — it is a setting inside your IDE.
        </p>

        <ol className="mt-3 space-y-2 text-[13px] text-ink-muted">
          <Step number={1}>Turn on Variable recognition above.</Step>
          <Step number={2}>
            In your IDE, open the command palette (<Key>⌘⇧P</Key> on macOS, <Key>Ctrl⇧P</Key>{' '}
            elsewhere) and run{' '}
            <span className="text-ink">Toggle Screen Reader Accessibility Mode</span>.
          </Step>
          <Step number={3}>
            Click into a file, come back here with the IDE still open, and press Check.
          </Step>
        </ol>

        <div className="mt-4 flex items-center gap-3">
          <Button onClick={check} disabled={checking || !vibe.variableRecognition}>
            {checking ? 'Checking…' : 'Check'}
          </Button>
          {probe ? (
            <Badge tone={probe.readable ? 'positive' : 'warning'}>
              {probe.readable ? 'Reading the editor' : 'Not readable yet'}
            </Badge>
          ) : null}
        </div>

        {probe ? (
          <p className="mt-2.5 text-[12px] leading-relaxed text-ink-muted">
            {probe.detail}
            {/* Names the app it actually looked at, so "not readable" can never
                be a mystery about which window was in front. */}
            {probe.frontmostApp ? (
              <span className="text-ink-faint"> (frontmost: {probe.frontmostApp})</span>
            ) : null}
          </p>
        ) : null}

        <p className="mt-3 text-[12px] leading-relaxed text-ink-faint">
          VS Code Insiders is not supported — use standard VS Code, Cursor or Windsurf.
        </p>
      </Card>
    </Section>
  )
}

function Step({
  number,
  children,
}: {
  number: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <li className="flex gap-2.5 leading-relaxed">
      <span className="mt-px grid size-[18px] shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">
        {number}
      </span>
      <span>{children}</span>
    </li>
  )
}

function Key({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded border border-line bg-canvas px-1 py-0.5 font-mono text-[11px] text-ink">
      {children}
    </kbd>
  )
}
