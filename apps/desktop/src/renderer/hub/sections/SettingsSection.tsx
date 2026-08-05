import { Card, Row, Section, Select, Toggle } from '../../components/Section'
import { useSettings } from '../../hooks/useSettings'

/**
 * Settings (PLAN §2.2.5).
 *
 * Everything here round-trips for real: each change is a `settings.set` patch
 * to the main-process store, which persists to `settings.json` and broadcasts
 * the new state back to every window.
 */

const HOTKEYS = [
  { value: 'fn' as const, label: 'Hold fn' },
  { value: 'rightCmd' as const, label: 'Hold right ⌘' },
  { value: 'rightOpt' as const, label: 'Hold right ⌥' },
  { value: 'custom' as const, label: 'Custom key' },
]

const ACTIVATIONS = [
  { value: 'hold' as const, label: 'Hold to talk' },
  { value: 'toggle' as const, label: 'Press to start / stop' },
]

const BAR_VISIBILITY = [
  { value: 'showWhileDictating' as const, label: 'While dictating' },
  { value: 'always' as const, label: 'Always' },
  { value: 'hidden' as const, label: 'Hidden' },
]

const APPEARANCE = [
  { value: 'system' as const, label: 'System' },
  { value: 'light' as const, label: 'Light' },
  { value: 'dark' as const, label: 'Dark' },
]

const AUDIO_RETENTION = [
  { value: 'off' as const, label: 'Delete after transcription' },
  { value: 'days' as const, label: 'Keep for 30 days' },
]

export function SettingsSection(): React.JSX.Element {
  const { settings, update, error } = useSettings()

  if (!settings) {
    return <Section title="Settings" description="Loading…" />
  }

  return (
    <Section title="Settings" description="Hotkey, microphone, retention and appearance.">
      {error ? (
        <Card className="mb-5 border-warning/40">
          <p className="text-[13px] text-warning">{error}</p>
        </Card>
      ) : null}

      <Card className="mb-5">
        <Row label="Dictation key" hint="Electron cannot see fn; the native event tap can.">
          <Select
            value={settings.hotkey.key}
            options={HOTKEYS}
            onChange={(key) => void update({ hotkey: { ...settings.hotkey, key } })}
          />
        </Row>
        <Row label="Activation">
          <Select
            value={settings.hotkey.activation}
            options={ACTIVATIONS}
            onChange={(activation) => void update({ hotkey: { ...settings.hotkey, activation } })}
          />
        </Row>
        <Row label="Double-tap for hands-free">
          <Toggle
            label="Double-tap for hands-free"
            checked={settings.hotkey.doubleTapHandsFree}
            onChange={(doubleTapHandsFree) =>
              void update({ hotkey: { ...settings.hotkey, doubleTapHandsFree } })
            }
          />
        </Row>
      </Card>

      <Card className="mb-5">
        <Row label="Show the bar" hint="The floating pill at the bottom of the screen.">
          <Select
            value={settings.barVisibility}
            options={BAR_VISIBILITY}
            onChange={(barVisibility) => void update({ barVisibility })}
          />
        </Row>
        <Row label="Appearance">
          <Select
            value={settings.appearance}
            options={APPEARANCE}
            onChange={(appearance) => void update({ appearance })}
          />
        </Row>
        <Row label="Launch at login">
          <Toggle
            label="Launch at login"
            checked={settings.launchAtLogin}
            onChange={(launchAtLogin) => void update({ launchAtLogin })}
          />
        </Row>
      </Card>

      <Card>
        <Row label="Recorded audio" hint="Audio is held in memory only unless you opt in.">
          <Select
            value={settings.audioRetention.mode}
            options={AUDIO_RETENTION}
            onChange={(mode) =>
              void update({
                audioRetention: mode === 'off' ? { mode: 'off' } : { mode: 'days', days: 30 },
              })
            }
          />
        </Row>
        <Row label="History" hint="How long transcripts stay on this machine.">
          <span className="text-[13px] text-ink">
            {settings.historyRetention.mode === 'off'
              ? 'Not kept'
              : `${settings.historyRetention.days} days`}
          </span>
        </Row>
      </Card>
    </Section>
  )
}
