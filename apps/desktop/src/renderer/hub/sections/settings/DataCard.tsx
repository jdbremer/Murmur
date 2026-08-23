import { useState } from 'react'

import {
  HISTORY_EXPORT_FORMATS,
  type BackupSummary,
  type HistoryExportFormat,
} from '@murmur/shared'

import { Button, Card, Row, Select, Toggle } from '../../../components/Section'
import { formatNumber } from '../../../format'
import { useToast } from '../../components/ToastHost'
import { errorMessage } from '../../../lib/errors'

/**
 * Your data (PLAN §10.5).
 *
 * Murmur's argument is that nothing you say leaves your machine. That argument
 * has a hole in it if your dictations cannot leave your machine *when you want
 * them to*, so this card is not a convenience — it is the other half of the
 * promise, and it belongs in Settings next to the retention controls rather
 * than buried behind a menu.
 *
 * The restore flow is deliberately two steps. Everything else here writes a new
 * file and cannot hurt anything; restoring is the one operation that touches
 * data already on the machine, so the file is read and summarised first and
 * nothing is written until the user has seen what is in it.
 */

const FORMAT_LABELS: Record<HistoryExportFormat, string> = {
  md: 'Markdown — grouped by day',
  csv: 'CSV — one row per dictation',
  json: 'JSON — everything, including timings',
  txt: 'Plain text — just the words',
}

const FORMAT_OPTIONS = HISTORY_EXPORT_FORMATS.map((format) => ({
  value: format,
  label: FORMAT_LABELS[format],
}))

export function DataCard(): React.JSX.Element {
  const toast = useToast()
  const [format, setFormat] = useState<HistoryExportFormat>('md')
  const [includeHistory, setIncludeHistory] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [pending, setPending] = useState<{ path: string; summary: BackupSummary } | null>(null)

  /** Every action here can fail on a full disk or a locked folder; none should throw into the void. */
  const run = async (key: string, action: () => Promise<void>): Promise<void> => {
    setBusy(key)
    try {
      await action()
    } catch (cause) {
      toast.show({
        message: 'That did not work',
        detail: errorMessage(cause),
        tone: 'danger',
      })
    } finally {
      setBusy(null)
    }
  }

  const exportHistory = (): Promise<void> =>
    run('history', async () => {
      const result = await window.murmur.data.exportHistory({ format, ids: [], search: '' })
      // A cancelled dialog is the ordinary outcome, not a failure to report.
      if (!result.path) return
      toast.show({
        message: `Exported ${formatNumber(result.count)} dictation${result.count === 1 ? '' : 's'}`,
        detail: result.path,
        tone: 'positive',
      })
    })

  const exportNotes = (): Promise<void> =>
    run('notes', async () => {
      const result = await window.murmur.data.exportNotes()
      if (!result.path) {
        // Distinguishing "you cancelled" from "there was nothing to write"
        // matters: the second one looks identical and is not the user's doing.
        const { total } = await window.murmur.notes.list({ search: '', limit: 1 })
        if (total === 0) toast.show({ message: 'There are no notes to export yet.' })
        return
      }
      toast.show({
        message: `Exported ${formatNumber(result.count)} note${result.count === 1 ? '' : 's'}`,
        detail: result.path,
        tone: 'positive',
      })
    })

  const backup = (): Promise<void> =>
    run('backup', async () => {
      const result = await window.murmur.data.backup({ includeHistory })
      if (!result.path) return
      toast.show({ message: 'Backup saved', detail: result.path, tone: 'positive' })
    })

  const chooseBackup = (): Promise<void> =>
    run('preview', async () => {
      const preview = await window.murmur.data.restorePreview()
      if (preview) setPending(preview)
    })

  const applyRestore = (): Promise<void> =>
    run('restore', async () => {
      if (!pending) return
      const result = await window.murmur.data.restore({ path: pending.path })
      setPending(null)
      const added = result.dictionary + result.snippets + result.notes + result.history
      toast.show({
        message:
          added === 0
            ? 'Everything in that backup was already here'
            : `Restored ${formatNumber(added)} items`,
        detail: result.settings ? 'Your settings were restored too.' : undefined,
        tone: 'positive',
      })
    })

  return (
    <Card className="mb-6">
      <Row
        label="Export your dictations"
        hint="Everything in your history, in a file you can open anywhere."
      >
        <div className="flex items-center gap-2">
          <Select
            label="Export format"
            value={format}
            options={FORMAT_OPTIONS}
            onChange={setFormat}
          />
          <Button onClick={() => void exportHistory()} disabled={busy !== null}>
            {busy === 'history' ? 'Exporting…' : 'Export…'}
          </Button>
        </div>
      </Row>

      <Row
        label="Export your notes"
        hint="One Markdown file per note, with its dates in front matter."
      >
        <Button onClick={() => void exportNotes()} disabled={busy !== null}>
          {busy === 'notes' ? 'Exporting…' : 'Choose a folder…'}
        </Button>
      </Row>

      <Row
        label="Include dictations in a backup"
        hint="Off backs up your setup only — dictionary, snippets, notes and settings."
      >
        <Toggle
          checked={includeHistory}
          onChange={setIncludeHistory}
          label="Include dictations in a backup"
        />
      </Row>

      <Row
        label="Back up everything"
        hint="One file holding your dictionary, snippets, notes, settings and — if you want — your dictations. Your Insights totals are not included."
      >
        <Button variant="primary" onClick={() => void backup()} disabled={busy !== null}>
          {busy === 'backup' ? 'Saving…' : 'Save a backup…'}
        </Button>
      </Row>

      <Row
        label="Restore from a backup"
        hint="Adds anything the backup has that this machine does not. Nothing already here is overwritten."
      >
        <Button onClick={() => void chooseBackup()} disabled={busy !== null}>
          {busy === 'preview' ? 'Reading…' : 'Choose a backup…'}
        </Button>
      </Row>

      {/* The confirmation step. Shown in place rather than as a dialog so the
          numbers stay readable while the user decides. */}
      {pending ? (
        <div className="mt-4 rounded-xl border border-accent/40 bg-surface-sunken p-4">
          <p className="text-[13px] font-medium text-ink">
            That backup was made{' '}
            {new Date(pending.summary.createdAt).toLocaleDateString(undefined, {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
            {pending.summary.appVersion ? ` by Murmur ${pending.summary.appVersion}` : ''}.
          </p>
          <ul className="mt-2 space-y-0.5 text-[12px] text-ink-muted">
            <SummaryLine count={pending.summary.history} noun="dictation" />
            <SummaryLine count={pending.summary.notes} noun="note" />
            <SummaryLine count={pending.summary.dictionary} noun="dictionary term" />
            <SummaryLine count={pending.summary.snippets} noun="snippet" />
            {pending.summary.settings ? <li>Your settings</li> : null}
          </ul>
          <div className="mt-3.5 flex gap-2">
            <Button variant="primary" onClick={() => void applyRestore()} disabled={busy !== null}>
              {busy === 'restore' ? 'Restoring…' : 'Restore these'}
            </Button>
            <Button onClick={() => setPending(null)} disabled={busy !== null}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  )
}

function SummaryLine({ count, noun }: { count: number; noun: string }): React.JSX.Element | null {
  if (count === 0) return null
  return (
    <li>
      {formatNumber(count)} {noun}
      {count === 1 ? '' : 's'}
    </li>
  )
}
