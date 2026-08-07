import { describe, expect, it } from 'vitest'

import { MEETING } from '../src/main/config'
import {
  MeetingDetector,
  meetingShaped,
  type AudioProcessSnapshot,
} from '../src/main/meeting/detector'

/**
 * Detection decides how often the app interrupts someone, so the false-positive
 * rules are the point of these tests. Every snapshot below is taken from real
 * `kAudioHardwarePropertyProcessObjectList` output on macOS 26.
 */

function proc(
  bundleId: string | null,
  runningInput: boolean,
  runningOutput: boolean,
  pid = 1,
): AudioProcessSnapshot {
  return { pid, bundleId, runningInput, runningOutput }
}

describe('meetingShaped', () => {
  it('accepts a listed app holding microphone and speakers together', () => {
    expect(meetingShaped([proc('us.zoom.xos', true, true)])).toHaveLength(1)
  })

  it('matches helper processes, which is what CoreAudio actually reports', () => {
    // There is no `com.microsoft.teams` audio process — only helpers.
    expect(meetingShaped([proc('com.microsoft.teams2.modulehost', true, true)])).toHaveLength(1)
    expect(meetingShaped([proc('com.tinyspeck.slackmacgap.helper', true, true)])).toHaveLength(1)
  })

  it('ignores output-only playback', () => {
    expect(meetingShaped([proc('com.google.chrome', false, true)])).toHaveLength(0)
  })

  it('ignores input-only recording, such as a voice memo', () => {
    expect(meetingShaped([proc('com.apple.VoiceMemos', true, false)])).toHaveLength(0)
  })

  it('ignores system services that hold both — CoreSpeech really does', () => {
    // Observed live: com.apple.CoreSpeech runs with input and output set.
    // Without the allowlist this alone would fire constantly.
    expect(meetingShaped([proc('com.apple.CoreSpeech', true, true)])).toHaveLength(0)
  })

  it('never detects Murmur itself, whose audio runs in a renderer helper', () => {
    // Excluding "our own pid" would not have caught this: the process holding
    // the microphone is `com.murmur.app.helper`, not the main process.
    expect(meetingShaped([proc('com.murmur.app.helper', true, true)])).toHaveLength(0)
  })

  it('ignores a process with no bundle id at all', () => {
    expect(meetingShaped([proc(null, true, true)])).toHaveLength(0)
  })
})

describe('MeetingDetector', () => {
  const zoom = [proc('us.zoom.xos', true, true, 42)]
  const noTitle = (): string | null => null

  it('waits out the dwell before announcing anything', () => {
    const detector = new MeetingDetector()
    expect(detector.evaluate({ processes: zoom, titleFor: noTitle, now: 0 }).kind).toBe('watching')
    expect(
      detector.evaluate({ processes: zoom, titleFor: noTitle, now: MEETING.detectDwellMs - 1 })
        .kind,
    ).toBe('watching')
    expect(
      detector.evaluate({ processes: zoom, titleFor: noTitle, now: MEETING.detectDwellMs + 1 })
        .kind,
    ).toBe('meeting')
  })

  it('announces only once per meeting', () => {
    const detector = new MeetingDetector()
    detector.evaluate({ processes: zoom, titleFor: noTitle, now: 0 })
    detector.evaluate({ processes: zoom, titleFor: noTitle, now: MEETING.detectDwellMs + 1 })
    expect(
      detector.evaluate({ processes: zoom, titleFor: noTitle, now: MEETING.detectDwellMs + 2 })
        .kind,
    ).toBe('watching')
  })

  it('restarts the dwell when the call ends and another begins', () => {
    const detector = new MeetingDetector()
    detector.evaluate({ processes: zoom, titleFor: noTitle, now: 0 })
    detector.evaluate({ processes: [], titleFor: noTitle, now: 1_000 })
    expect(detector.evaluate({ processes: zoom, titleFor: noTitle, now: 2_000 }).kind).toBe(
      'watching',
    )
  })

  it('does not treat a browser as a meeting on bundle id alone', () => {
    // Chrome holding audio could be any tab. Without a meeting-ish title this
    // must never fire, or every video call *and* every podcast triggers it.
    const detector = new MeetingDetector()
    const chrome = [proc('com.google.chrome', true, true, 7)]
    detector.evaluate({ processes: chrome, titleFor: noTitle, now: 0 })
    expect(
      detector.evaluate({ processes: chrome, titleFor: noTitle, now: MEETING.detectDwellMs + 1 })
        .kind,
    ).toBe('watching')
  })

  it('detects a browser call once the window title says so, and names it', () => {
    const detector = new MeetingDetector()
    const chrome = [proc('com.google.chrome', true, true, 7)]
    const title = (): string => 'Weekly Sync - Google Meet - Google Chrome'

    detector.evaluate({ processes: chrome, titleFor: title, now: 0 })
    const verdict = detector.evaluate({
      processes: chrome,
      titleFor: title,
      now: MEETING.detectDwellMs + 1,
    })

    expect(verdict.kind).toBe('meeting')
    if (verdict.kind === 'meeting') {
      // The browser's own chrome is stripped — nobody wants a file called
      // "Weekly Sync - Google Meet - Google Chrome.md".
      expect(verdict.name).toBe('Weekly Sync')
    }
  })

  it('stays quiet about an app the user declined, for a while', () => {
    const detector = new MeetingDetector()
    detector.decline('us.zoom.xos', 0)
    detector.evaluate({ processes: zoom, titleFor: noTitle, now: 100 })
    expect(
      detector.evaluate({ processes: zoom, titleFor: noTitle, now: MEETING.detectDwellMs + 200 })
        .kind,
    ).toBe('none')
  })

  it('offers again once the cooldown expires', () => {
    const detector = new MeetingDetector()
    detector.decline('us.zoom.xos', 0)
    const after = MEETING.detectCooldownMs + 1
    detector.evaluate({ processes: zoom, titleFor: noTitle, now: after })
    expect(
      detector.evaluate({
        processes: zoom,
        titleFor: noTitle,
        now: after + MEETING.detectDwellMs + 1,
      }).kind,
    ).toBe('meeting')
  })
})
