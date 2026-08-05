import { useEffect, useState } from 'react'

import type { AppInfo, HotkeyKey } from '@murmur/shared'

import { Card, Row, Section, Select, Toggle } from '../../components/Section'
import { useSettings } from '../../hooks/useSettings'

/**
 * Settings (PLAN §2.2.5).
 *
 * Everything here round-trips for real: each change is a `settings.set` patch
 * to the main-process store, which persists to `settings.json` and broadcasts
 * the new state back to every window.
 *
 * Hotkey presets branch on platform (WINDOWS-HANDOFF Phase B / gate G3): Windows
 * never shows fn / ⌘ / ⌥ labels.
 */

const MAC_HOTKEYS: { value: HotkeyKey; label: string }[] = [
  { value: 'fn', label: 'Hold fn' },
  { value: 'rightCmd', label: 'Hold right ⌘' },
  { value: 'rightOpt', label: 'Hold right ⌥' },
  { value: 'custom', label: 'Custom key' },
]

const WINDOWS_HOTKEYS: { value: HotkeyKey; label: string }[] = [
  { value: 'rightCtrl', label: 'Hold Right Ctrl (recommended)' },
  // Ctrl+Space / Alt+Space temporarily removed: LL-hook Space swallow can stick
  // the key across the whole OS. Re-add when latch release is proven solid.
  { value: 'capsLock', label: 'Hold Caps Lock' },
  { value: 'custom', label: 'Custom key' },
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
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void window.murmur.app
      .info()
      .then(setInfo)
      .catch(() => {
        // Older preload without app.info — assume non-mac so we never show ⌘/⌥
        // on a Windows box that cannot resolve platform.
        setInfo({
          version: 'unknown',
          platform: 'win32',
          arch: 'unknown',
          isDev: false,
          showDevTools: false,
          native: 'unknown',
        })
      })
  }, [])

  // Wait for app.info so we never flash macOS fn/⌘/⌥ chrome on Windows (G3).
  if (!settings || !info) {
    return <Section title="Settings" description="Loading…" />
  }

  const isWindows = info.platform === 'win32'
  const hotkeyOptions = isWindows ? WINDOWS_HOTKEYS : MAC_HOTKEYS
  const hotkeyHint = isWindows
    ? 'Global hold-to-talk. Prefer Right Ctrl — it never swallows Space. Chords work but release fully if a key sticks.'
    : 'Electron cannot see fn; the native event tap can.'
  // If a Mac-only key is still stored on Windows (pre-migration), keep the
  // select valid by coercing the displayed value to a Windows preset.
  const hotkeyValue = hotkeyOptions.some((o) => o.value === settings.hotkey.key)
    ? settings.hotkey.key
    : isWindows
      ? 'rightCtrl'
      : settings.hotkey.key

  return (
    <Section title="Settings" description="Hotkey, microphone, retention and appearance.">
      {error ? (
        <Card className="mb-5 border-warning/40">
          <p className="text-[13px] text-warning">{error}</p>
        </Card>
      ) : null}

      <Card className="mb-5">
        <Row label="Dictation key" hint={hotkeyHint}>
          <Select
            value={hotkeyValue}
            options={hotkeyOptions}
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
