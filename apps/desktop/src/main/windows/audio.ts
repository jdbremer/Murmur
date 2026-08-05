import { BrowserWindow } from 'electron'

import { loadRenderer, PRELOAD_PATH } from './renderer'

/**
 * The hidden audio-capture renderer (PLAN §3.1, §5).
 *
 * A renderer rather than native code so `getUserMedia` gives us the device
 * picker, level metering and AirPods/device-switch handling for free. Stage 1
 * only creates the window and loads the page — it does not open a mic stream.
 *
 * It is a real window (offscreen would suspend the AudioWorklet), just never
 * shown and never in the taskbar.
 */
export function createAudioWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 320,
    height: 200,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Capture must keep running while every visible window is in the
      // background — that is the normal case during dictation.
      backgroundThrottling: false,
    },
  })

  void loadRenderer(window, 'audio')
  return window
}
