import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import type { TranscriptionExportFormat } from '@murmur/shared'
import { formatTimecode, transcriptionText } from '@murmur/shared'

import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  ProgressBar,
  Section,
} from '../../components/Section'
import { formatBytes } from '../../format'
import { useEngines } from '../../hooks/useEngines'
import { transcribeClient, type TranscribeItem } from '../transcribe/client'
import { FILE_INPUT_ACCEPT } from '../transcribe/decoder'

/**
 * Transcribe (PLAN §18.4) — drop an audio or video file, get its transcript.
 *
 * The section is a thin face over `transcribe/client.ts`, which owns the
 * decode/push pipeline precisely so that leaving this section does not kill a
 * half-finished audiobook. Everything here is presentation: the drop zone, the
 * queue, and what to do with a finished transcript.
 */
export function TranscribeSection(): React.JSX.Element {
  const items = useSyncExternalStore(transcribeClient.subscribe, transcribeClient.snapshot)
  const engines = useEngines()
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const sttUnavailable = engines !== null && engines.stt.state === 'unavailable'

  const accept = useCallback((files: FileList | null): void => {
    if (!files || files.length === 0) return
    transcribeClient.addFiles([...files])
  }, [])

  return (
    <Section
      title="Transcribe"
      description="Drop in a recording — a voice memo, a podcast, a video — and get its transcript. The audio never leaves this machine."
      actions={<Button onClick={() => inputRef.current?.click()}>Choose files…</Button>}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={FILE_INPUT_ACCEPT}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          accept(event.target.files)
          // Same file, chosen twice, must fire twice.
          event.target.value = ''
        }}
      />

      {sttUnavailable ? (
        <div className="mb-4">
          <Banner tone="warning" title="A speech model is needed first">
            {engines.stt.detail || 'Download and select a speech-to-text model under Models.'}
          </Banner>
        </div>
      ) : null}

      <DropZone
        dragging={dragging}
        disabled={sttUnavailable}
        onDragging={setDragging}
        onDrop={accept}
        onBrowse={() => inputRef.current?.click()}
      />

      {items.length === 0 ? (
        <EmptyState icon="transcribe" title="Nothing transcribed yet">
          Drop a file above — MP3, MP4/M4A, WAV, FLAC, OGG/Opus, WebM, MOV and AIFF all work. It is
          decoded and transcribed on this machine; nothing is uploaded.
        </EmptyState>
      ) : (
        <div className="mt-4 flex flex-col gap-2">
          {[...items].reverse().map((item) => (
            <ItemRow key={item.key} item={item} />
          ))}
        </div>
      )}
    </Section>
  )
}

function DropZone({
  dragging,
  disabled,
  onDragging,
  onDrop,
  onBrowse,
}: {
  dragging: boolean
  disabled: boolean
  onDragging: (next: boolean) => void
  onDrop: (files: FileList | null) => void
  onBrowse: () => void
}): React.JSX.Element {
  // Drag-enter/leave fire for every child crossed; counting is the classic fix.
  const depth = useRef(0)

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label="Drop audio or video files to transcribe"
      onClick={() => {
        if (!disabled) onBrowse()
      }}
      onKeyDown={(event) => {
        if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          onBrowse()
        }
      }}
      onDragEnter={(event) => {
        event.preventDefault()
        depth.current += 1
        if (!disabled) onDragging(true)
      }}
      onDragOver={(event) => {
        // Required, or the browser navigates to the dropped file.
        event.preventDefault()
      }}
      onDragLeave={(event) => {
        event.preventDefault()
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) onDragging(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        depth.current = 0
        onDragging(false)
        if (!disabled) onDrop(event.dataTransfer.files)
      }}
      className={[
        'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors duration-150',
        disabled
          ? 'cursor-not-allowed border-line opacity-50'
          : dragging
            ? 'border-accent bg-accent/8'
            : 'border-line hover:border-ink-muted/40 hover:bg-ink/[0.02]',
      ].join(' ')}
    >
      {/* A file with sound in it. */}
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className={`size-8 ${dragging ? 'text-accent' : 'text-ink-muted'}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 4h8l4 4v12H6zM14 4v4h4M9 14v2.5M12 12.5v5.5M15 14v2.5" />
      </svg>
      <p className="text-[13px] font-medium text-ink">
        {dragging ? 'Drop to transcribe' : 'Drop audio or video files here'}
      </p>
      <p className="text-[12px] text-ink-muted">
        or click to browse. Transcribed on this Mac, never uploaded.
      </p>
    </div>
  )
}

function ItemRow({ item }: { item: TranscribeItem }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const showTranscript = item.status === 'done' && expanded

  // Segments stream in live; only a job adopted after a Hub reload arrives
  // without them, and only when its transcript is actually opened.
  useEffect(() => {
    if (showTranscript) void transcribeClient.ensureSegments(item.key)
  }, [showTranscript, item.key])

  const active =
    item.status === 'reading' || item.status === 'transcribing' || item.status === 'waiting'
  const total = item.job?.totalMs ?? 0
  const fraction =
    item.status === 'transcribing' && total > 0 ? (item.job?.completedMs ?? 0) / total : null
  const lastSegment = item.segments[item.segments.length - 1]

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-ink">{item.fileName}</p>
          <p className="mt-0.5 text-[12px] text-ink-muted">{subtitle(item)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge item={item} />
          {active ? (
            <Button variant="danger" onClick={() => transcribeClient.cancel(item.key)}>
              Cancel
            </Button>
          ) : (
            <Button onClick={() => transcribeClient.remove(item.key)}>Remove</Button>
          )}
        </div>
      </div>

      {item.status === 'reading' ? (
        <div className="mt-3">
          <ProgressBar value={null} />
        </div>
      ) : null}

      {item.status === 'transcribing' ? (
        <div className="mt-3 flex flex-col gap-2">
          <ProgressBar value={fraction} />
          {lastSegment ? (
            <p className="truncate text-[12px] text-ink-muted" aria-live="polite">
              …{lastSegment.text}
            </p>
          ) : null}
        </div>
      ) : null}

      {item.status === 'failed' && item.error ? (
        <p className="mt-2 text-[12px] text-danger">{item.error}</p>
      ) : null}

      {item.status === 'done' ? (
        <DoneActions
          item={item}
          expanded={expanded}
          onToggle={() => setExpanded((value) => !value)}
        />
      ) : null}

      {showTranscript ? <Transcript item={item} /> : null}
    </Card>
  )
}

function DoneActions({
  item,
  expanded,
  onToggle,
}: {
  item: TranscribeItem
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [savedNote, setSavedNote] = useState(false)

  const copy = async (): Promise<void> => {
    await transcribeClient.ensureSegments(item.key)
    const text = transcriptionText(
      transcribeClient.snapshot().find((i) => i.key === item.key)?.segments ?? [],
    )
    await window.murmur.app.copyText({ text })
    setCopied(true)
    setTimeout(() => setCopied(false), 1_500)
  }

  const exportAs = async (format: TranscriptionExportFormat): Promise<void> => {
    if (!item.job) return
    const { path } = await window.murmur.transcribe.export({ jobId: item.job.id, format })
    transcribeClient.noteExport(item.key, path)
  }

  const saveToNotes = async (): Promise<void> => {
    await transcribeClient.ensureSegments(item.key)
    const text = transcriptionText(
      transcribeClient.snapshot().find((i) => i.key === item.key)?.segments ?? [],
    )
    await window.murmur.notes.create({
      title: `Transcript of ${item.fileName}`.slice(0, 200),
      body: text,
    })
    setSavedNote(true)
    setTimeout(() => setSavedNote(false), 1_500)
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onToggle}>{expanded ? 'Hide transcript' : 'Show transcript'}</Button>
        <Button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</Button>
        <Button onClick={() => void exportAs('txt')} title="Plain text, one paragraph per pause">
          Save .txt
        </Button>
        <Button onClick={() => void exportAs('srt')} title="SubRip subtitles with timestamps">
          Save .srt
        </Button>
        <Button onClick={() => void exportAs('md')} title="Markdown with a timestamp per paragraph">
          Save .md
        </Button>
        <Button
          onClick={() => void saveToNotes()}
          title="Keeps the transcript as a searchable note"
        >
          {savedNote ? 'Saved' : 'Save to Scratchpad'}
        </Button>
      </div>
      {item.exportedTo ? (
        <p className="text-[12px] text-positive">Saved to {item.exportedTo}</p>
      ) : null}
    </div>
  )
}

function Transcript({ item }: { item: TranscribeItem }): React.JSX.Element {
  if (item.segments.length === 0) {
    return <p className="mt-3 text-[12px] text-ink-muted">No speech was found in this file.</p>
  }
  return (
    <div className="mt-3 max-h-80 overflow-y-auto rounded-lg border border-line bg-canvas p-3">
      {item.segments.map((segment) => (
        <p key={segment.startMs} className="mb-2 text-[13px] leading-relaxed text-ink last:mb-0">
          <span className="mr-2 select-none text-[11px] tabular-nums text-ink-muted">
            {formatTimecode(segment.startMs)}
          </span>
          {segment.text}
        </p>
      ))}
    </div>
  )
}

function StatusBadge({ item }: { item: TranscribeItem }): React.JSX.Element | null {
  switch (item.status) {
    case 'waiting':
      return <Badge tone="neutral">Waiting</Badge>
    case 'reading':
      return <Badge tone="accent">Reading audio</Badge>
    case 'transcribing':
      return <Badge tone="accent">Transcribing</Badge>
    case 'done':
      return <Badge tone="positive">Done</Badge>
    case 'failed':
      return <Badge tone="danger">Failed</Badge>
    case 'cancelled':
      return <Badge tone="neutral">Cancelled</Badge>
  }
}

function subtitle(item: TranscribeItem): string {
  const parts: string[] = []
  if (item.fileBytes !== null) parts.push(formatBytes(item.fileBytes))
  if (item.job) {
    parts.push(formatTimecode(item.job.totalMs))
    if (item.status === 'transcribing') {
      const total = item.job.totalMs
      if (total > 0) {
        parts.push(`${Math.min(100, Math.round((item.job.completedMs / total) * 100))}%`)
      }
    }
    if (item.status === 'done' || item.status === 'transcribing') {
      const count = item.job.segmentCount
      parts.push(`${count} segment${count === 1 ? '' : 's'}`)
    }
  }
  return parts.join(' · ')
}
