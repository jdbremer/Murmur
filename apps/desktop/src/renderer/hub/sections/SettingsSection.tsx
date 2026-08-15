import { useState } from 'react'

import type { HotkeyKey } from '@murmur/shared'

import {
  Badge,
  Banner,
  Button,
  Card,
  InlineError,
  LoadingState,
  Row,
  Section,
  Select,
  Toggle,
} from '../../components/Section'
import { useAudioDevices, micOptions } from '../../hooks/useAudioDevices'
import { useCaptureStatus } from '../../hooks/useCaptureStatus'
import { useDevMode } from '../../hooks/useDevMode'
import { useDictationState } from '../../hooks/useDictationState'
import { useSettings } from '../../hooks/useSettings'
import { isLinuxPlatform, isMacPlatform, isWindowsPlatform } from '../../lib/platform'

/**
 * Settings (PLAN §2.2.5).
 *
 * Everything here round-trips for real: each change is a `settings.set` patch
 * to the main-process store, which persists it, broadcasts the new state to
 * every window, and hot-applies it — no restart, no Apply button.
 */

const MAC_HOTKEYS: readonly { value: HotkeyKey; label: string }[] = [
  { value: 'fn', label: 'fn' },
  { value: 'rightCmd', label: 'Right ⌘' },
  { value: 'rightOpt', label: 'Right ⌥' },
  { value: 'custom', label: 'Custom key' },
]

/** Windows: no Space-swallowing chords until latch release is rock-solid. */
const WINDOWS_HOTKEYS: readonly { value: HotkeyKey; label: string }[] = [
  { value: 'rightCtrl', label: 'Right Ctrl (recommended)' },
  { value: 'capsLock', label: 'Caps Lock' },
  { value: 'custom', label: 'Custom key' },
]

/**
 * Linux/X11: the right-hand modifiers only.
 *
 * XRecord cannot swallow a key, so Caps Lock is absent for a concrete reason —
 * offering it would toggle caps on every dictation. The stored-key names are
 * shared across platforms, so `rightCmd`/`rightOpt` are relabelled here to the
 * keys X11 actually binds them to.
 */
const LINUX_HOTKEYS: readonly { value: HotkeyKey; label: string }[] = [
  { value: 'rightCtrl', label: 'Right Ctrl (recommended)' },
  { value: 'rightOpt', label: 'Right Alt' },
  { value: 'rightCmd', label: 'Right Super' },
  { value: 'custom', label: 'Custom key' },
]

const ACTIVATIONS = [
  { value: 'hold' as const, label: 'Hold to talk' },
  { value: 'toggle' as const, label: 'Press to start and stop' },
]

const BAR_VISIBILITY = [
  { value: 'showWhileDictating' as const, label: 'While dictating' },
  { value: 'always' as const, label: 'Always' },
  { value: 'hidden' as const, label: 'Hidden' },
]

const BAR_STYLE = [
  { value: 'pill' as const, label: 'Pill, bottom centre' },
  { value: 'corner' as const, label: 'Orb, in a corner' },
]

const BAR_CORNER = [
  { value: 'bottomLeft' as const, label: 'Bottom left' },
  { value: 'bottomRight' as const, label: 'Bottom right' },
]

const APPEARANCE = [
  { value: 'system' as const, label: 'System' },
  { value: 'light' as const, label: 'Light' },
  { value: 'dark' as const, label: 'Dark' },
]

const LANGUAGES = [
  { value: 'auto', label: 'Detect automatically' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'nl', label: 'Dutch' },
]

const AUDIO_RETENTION = [
  { value: 'off' as const, label: 'Delete after transcription' },
  { value: 'days' as const, label: 'Keep for 30 days' },
]

const HISTORY_RETENTION = [
  { value: 'off' as const, label: 'Do not keep history' },
  { value: '30' as const, label: '30 days' },
  { value: '90' as const, label: '90 days' },
  { value: '365' as const, label: 'A year' },
  { value: '3650' as const, label: 'Forever' },
]

export function SettingsSection(): React.JSX.Element {
  const { settings, update, error } = useSettings()
  const devices = useAudioDevices()
  const capture = useCaptureStatus()

  if (!settings) {
    return (
      <Section
        title="Settings"
        description="How dictation starts, which microphone it uses, and how long anything is kept."
      >
        <LoadingState />
      </Section>
    )
  }

  const historyValue =
    settings.historyRetention.mode === 'off' ? 'off' : String(settings.historyRetention.days)
  const isMac = isMacPlatform()
  const isWindows = isWindowsPlatform()
  const isLinux = isLinuxPlatform()
  const hotkeyOptions = isWindows ? WINDOWS_HOTKEYS : isLinux ? LINUX_HOTKEYS : MAC_HOTKEYS
  const hotkeyFallback: HotkeyKey = isWindows || isLinux ? 'rightCtrl' : 'fn'
  const hotkeyValue = hotkeyOptions.some((o) => o.value === settings.hotkey.key)
    ? settings.hotkey.key
    : hotkeyFallback

  return (
    <Section
      title="Settings"
      description="How dictation starts, which microphone it uses, and how long anything is kept."
    >
      <InlineError>{error}</InlineError>

      <h2 className="mb-2 text-[13px] font-semibold text-ink">Dictation key</h2>
      <Card className="mb-6">
        <Row
          label="Key"
          hint={
            isMac
              ? 'fn is the default — while Murmur is running it owns this key, so macOS globe actions (emoji, Apple Dictation) will not fire from it. The right-hand modifiers exist for external keyboards that have no fn key.'
              : isWindows
                ? 'Right Ctrl is the Windows default. Space chords are disabled until key-latch is rock-solid.'
                : isLinux
                  ? 'Right Ctrl is the Linux default. X11 only — on a Wayland session the key is stored but never fires, and Help says so. Caps Lock is not offered because X11 cannot swallow it.'
                  : 'The key listener needs macOS, Windows or Linux/X11; on this platform the key is stored but never fires.'
          }
          htmlFor="settings-hotkey"
        >
          <Select
            id="settings-hotkey"
            label="Dictation key"
            value={hotkeyValue}
            options={[...hotkeyOptions]}
            onChange={(key) => void update({ hotkey: { ...settings.hotkey, key } })}
          />
        </Row>
        <Row
          label="Activation"
          hint="Hold is push-to-talk. Toggle suits long dictations and accessibility needs."
          htmlFor="settings-activation"
        >
          <Select
            id="settings-activation"
            label="Activation"
            value={settings.hotkey.activation}
            options={ACTIVATIONS}
            onChange={(activation) => void update({ hotkey: { ...settings.hotkey, activation } })}
          />
        </Row>
        <Row
          label="Double-tap for hands-free"
          hint="Tap twice to latch dictation on; tap again or press Esc to stop."
        >
          <Toggle
            label="Double-tap for hands-free"
            checked={settings.hotkey.doubleTapHandsFree}
            onChange={(doubleTapHandsFree) =>
              void update({ hotkey: { ...settings.hotkey, doubleTapHandsFree } })
            }
          />
        </Row>
        <Row
          label="Edit selected text by voice"
          hint={
            isMac
              ? 'Hold your key with text selected and speak an instruction — the selection is rewritten in place. Needs a polishing model.'
              : // Reading the selection needs an accessibility call the Windows
                // and Linux backends do not implement yet, so the feature can
                // never fire there. A toggle that does nothing is worse than an
                // honest disabled one.
                'Reading the current selection is macOS-only for now, so this cannot run on this platform yet.'
          }
        >
          <Toggle
            label="Edit selected text by voice"
            checked={isMac && settings.commandModeEnabled}
            disabled={!isMac}
            onChange={(commandModeEnabled) => void update({ commandModeEnabled })}
          />
        </Row>
        <div className="pt-3">
          <TryIt hotkey={settings.hotkey.key} />
        </div>
      </Card>

      <h2 className="mb-2 text-[13px] font-semibold text-ink">Audio</h2>
      {capture?.status === 'error' ? (
        <div className="mb-3">
          <Banner tone="danger" title="The microphone is not working">
            {capture.message}
          </Banner>
        </div>
      ) : null}
      <Card className="mb-6">
        <Row
          label="Microphone"
          hint="Empty labels mean microphone access has not been granted yet."
          htmlFor="settings-mic"
        >
          <Select
            id="settings-mic"
            label="Microphone"
            value={settings.micDeviceId ?? ''}
            options={micOptions(devices)}
            onChange={(deviceId) => void update({ micDeviceId: deviceId === '' ? null : deviceId })}
          />
        </Row>
        <Row
          label="Language"
          hint="Detect automatically only works with models that do it natively, such as Whisper."
          htmlFor="settings-language"
        >
          <Select
            id="settings-language"
            label="Language"
            value={settings.language}
            options={LANGUAGES}
            onChange={(language) => void update({ language })}
          />
        </Row>
        <Row label="Dictation sounds" hint="A soft two-note cue when dictation starts and stops.">
          <Toggle
            label="Dictation sounds"
            checked={settings.soundCuesEnabled}
            onChange={(soundCuesEnabled) => void update({ soundCuesEnabled })}
          />
        </Row>
      </Card>

      <h2 className="mb-2 text-[13px] font-semibold text-ink">Appearance</h2>
      <Card className="mb-6">
        <Row
          label="Show the bar"
          hint="The floating indicator. Hidden does not disable dictation."
          htmlFor="settings-bar"
        >
          <Select
            id="settings-bar"
            label="Bar visibility"
            value={settings.barVisibility}
            options={BAR_VISIBILITY}
            onChange={(barVisibility) => void update({ barVisibility })}
          />
        </Row>
        <Row
          label="Shape"
          hint="The pill sits at the bottom of the screen. The orb peeks out from behind a corner and covers far less — but an error only shows its label while you hover it."
          htmlFor="settings-bar-style"
        >
          <Select
            id="settings-bar-style"
            label="Bar shape"
            value={settings.barStyle}
            options={BAR_STYLE}
            onChange={(barStyle) => void update({ barStyle })}
          />
        </Row>
        {settings.barStyle === 'corner' ? (
          <Row
            label="Corner"
            hint="Pick the side away from your Dock, or the one you look at least."
            htmlFor="settings-bar-corner"
          >
            <Select
              id="settings-bar-corner"
              label="Bar corner"
              value={settings.barCorner}
              options={BAR_CORNER}
              onChange={(barCorner) => void update({ barCorner })}
            />
          </Row>
        ) : null}
        <Row
          label="Start and stop flourish"
          hint="A ring blooms outward when dictation starts and settles inward when it stops. Off automatically if you have Reduce Motion on."
        >
          <Toggle
            label="Start and stop flourish"
            checked={settings.barFlourish}
            onChange={(barFlourish) => void update({ barFlourish })}
          />
        </Row>
        <Row label="Theme" htmlFor="settings-appearance">
          <Select
            id="settings-appearance"
            label="Theme"
            value={settings.appearance}
            options={APPEARANCE}
            onChange={(appearance) => void update({ appearance })}
          />
        </Row>
        <Row
          label="Launch at login"
          hint={
            isLinux
              ? 'Writes ~/.config/autostart/murmur.desktop.'
              : isMac || isWindows
                ? undefined
                : 'Not applied on this platform.'
          }
        >
          <Toggle
            label="Launch at login"
            checked={settings.launchAtLogin}
            onChange={(launchAtLogin) => void update({ launchAtLogin })}
          />
        </Row>
      </Card>

      <h2 className="mb-2 text-[13px] font-semibold text-ink">What is kept</h2>
      <Card>
        <Row
          label="Recorded audio"
          hint="Off by default: audio is held in memory and discarded the moment it has been transcribed."
          htmlFor="settings-audio-retention"
        >
          <Select
            id="settings-audio-retention"
            label="Audio retention"
            value={settings.audioRetention.mode}
            options={AUDIO_RETENTION}
            onChange={(mode) =>
              void update({
                audioRetention: mode === 'off' ? { mode: 'off' } : { mode: 'days', days: 30 },
              })
            }
          />
        </Row>
        <Row
          label="History"
          hint="Transcripts older than this are pruned at launch and when you change this setting."
          htmlFor="settings-history-retention"
        >
          <Select
            id="settings-history-retention"
            label="History retention"
            value={historyValue}
            options={HISTORY_RETENTION}
            onChange={(value) =>
              void update({
                historyRetention:
                  value === 'off' ? { mode: 'off' } : { mode: 'days', days: Number(value) },
              })
            }
          />
        </Row>
        <Row
          label="Track which apps you dictate into"
          hint="Powers the breakdown in Insights. Stored on this machine only, and unaffected by the retention window above — the totals are the point."
        >
          <Toggle
            label="Track which apps you dictate into"
            checked={settings.insightsEnabled}
            onChange={(insightsEnabled) => void update({ insightsEnabled })}
          />
        </Row>
        <Row
          label="Reset insights"
          hint="Zeroes every counter — words, streak, per-app tally, fixes. Your transcripts are not touched."
        >
          <ResetInsightsButton />
        </Row>
      </Card>
    </Section>
  )
}

/**
 * Reset, with a confirm.
 *
 * The counters are the only numbers in Murmur that cannot be recomputed —
 * history is pruned, so the words behind them are long gone. That makes this
 * genuinely irreversible in a way "delete this dictation" is not, and worth one
 * dialog.
 */
function ResetInsightsButton(): React.JSX.Element {
  const [done, setDone] = useState(false)

  return (
    <Button
      variant="danger"
      onClick={() => {
        if (!window.confirm('Reset every Insights counter? Your transcripts are kept.')) return
        void window.murmur.insights.reset().then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1_600)
        })
      }}
    >
      {done ? 'Reset' : 'Reset…'}
    </Button>
  )
}

/**
 * A live confirmation that the key actually works.
 *
 * Reading "hold fn to dictate" tells you nothing about whether the event tap is
 * running and the permission is granted. Watching the state change when you
 * press the key tells you everything, which is why this is here and not a
 * paragraph.
 */
function TryIt({ hotkey }: { hotkey: HotkeyKey }): React.JSX.Element {
  const event = useDictationState()
  const dev = useDevMode()
  const [simulating, setSimulating] = useState(false)

  const label =
    [...MAC_HOTKEYS, ...WINDOWS_HOTKEYS].find((option) => option.value === hotkey)?.label ??
    'your key'
  const message =
    event.state === 'listening'
      ? 'Listening — Murmur can hear you.'
      : event.state === 'processing'
        ? 'Transcribing…'
        : event.state === 'inserting'
          ? 'Inserting the text…'
          : event.state === 'inserted'
            ? 'Done — that went into the app you were last using.'
            : event.state === 'error'
              ? event.message
              : `Hold ${label} anywhere and say something. This line reacts.`

  const tone = event.state === 'error' ? 'warning' : event.state === 'idle' ? 'neutral' : 'accent'

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-canvas px-3 py-2">
      <Badge tone={tone}>Try it</Badge>
      <p aria-live="polite" className="flex-1 text-[12px] text-ink-muted">
        {message}
      </p>
      {dev ? (
        <Button
          disabled={simulating}
          onClick={() => {
            setSimulating(true)
            void window.murmur.debug
              .simulateHotkey({ action: 'down' })
              .then(
                () =>
                  new Promise<void>((resolve) => {
                    setTimeout(resolve, 1200)
                  }),
              )
              .then(() => window.murmur.debug.simulateHotkey({ action: 'up' }))
              .catch(() => undefined)
              .finally(() => setSimulating(false))
          }}
          title="Development builds only — runs the real pipeline without the event tap"
        >
          Simulate
        </Button>
      ) : null}
    </div>
  )
}
