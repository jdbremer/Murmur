import { useEffect, useState } from 'react'

import type { AudioDevice } from '@murmur/shared'

/**
 * The microphones the capture renderer can see.
 *
 * Enumerated there, not here: `MediaDeviceInfo.label` is only exposed to a
 * context that has held microphone permission, so a list built in the Hub would
 * be a column of anonymous ids. Main caches the last list and pushes changes on
 * `audio.devicesChanged` when a device is plugged in or AirPods connect.
 */
export function useAudioDevices(): AudioDevice[] {
  const [devices, setDevices] = useState<AudioDevice[]>([])

  useEffect(() => {
    let active = true
    void window.murmur.audio
      .listDevices()
      .then((value) => {
        if (active) setDevices(value.devices)
      })
      .catch(() => undefined)

    const unsubscribe = window.murmur.audio.onDevicesChanged((value) => {
      if (active) setDevices(value.devices)
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return devices
}

/** Options for a `<Select>`, with the system default first. */
export function micOptions(devices: AudioDevice[]): { value: string; label: string }[] {
  return [
    { value: '', label: 'System default' },
    ...devices.map((device, index) => ({
      value: device.deviceId,
      label: device.label || `Microphone ${index + 1}`,
    })),
  ]
}
