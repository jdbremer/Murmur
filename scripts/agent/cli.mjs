#!/usr/bin/env node
/**
 * Thin CLI over the agent control server.
 *
 *   node scripts/agent/cli.mjs health
 *   node scripts/agent/cli.mjs start
 *   node scripts/agent/cli.mjs shot hub
 *   node scripts/agent/cli.mjs click-text Help
 *   node scripts/agent/cli.mjs utterance
 *   node scripts/agent/cli.mjs snapshot
 *   node scripts/agent/cli.mjs stop
 */

const BASE = process.env.MURMUR_AGENT_URL || 'http://127.0.0.1:17321'

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = { raw: text }
  }
  if (!res.ok) {
    console.error(JSON.stringify(data, null, 2))
    process.exitCode = 1
    return data
  }
  console.log(JSON.stringify(data, null, 2))
  return data
}

const [cmd, ...rest] = process.argv.slice(2)

switch (cmd) {
  case 'health':
    await req('GET', '/health')
    break
  case 'start':
    await req('POST', '/start')
    break
  case 'stop':
    await req('POST', '/stop')
    break
  case 'shot':
  case 'screenshot':
    await req('POST', '/screenshot', { name: rest[0] || 'shot' })
    break
  case 'click':
    await req('POST', '/click', { selector: rest.join(' ') })
    break
  case 'click-text':
    await req('POST', '/click-text', { text: rest.join(' ') })
    break
  case 'hotkey':
    await req('POST', '/hotkey', { action: rest[0] || 'down' })
    break
  case 'inject-pcm':
    await req('POST', '/inject-pcm', {
      durationMs: Number(rest[0] || 800),
      amplitude: Number(rest[1] || 0.4),
    })
    break
  case 'utterance':
    await req('POST', '/utterance', {})
    break
  case 'snapshot':
    await req('GET', '/snapshot')
    break
  case 'murmur':
    await req('POST', '/murmur', {
      method: rest[0],
      args: rest[1] ? JSON.parse(rest[1]) : [],
    })
    break
  case 'desktop-shot':
  case 'take_screenshot':
    await req('POST', '/take_screenshot', { name: rest[0] || 'desktop' })
    break
  case 'click-xy':
    await req('POST', '/click_xy', {
      x: Number(rest[0]),
      y: Number(rest[1]),
      button: rest[2] || 'left',
      focus: rest[3],
    })
    break
  case 'type':
    await req('POST', '/type_text', { text: rest.join(' '), focus: 'Murmur' })
    break
  case 'keys':
    await req('POST', '/press_keys', { chord: rest.join('+') || rest[0], focus: 'Murmur' })
    break
  case 'focus':
    await req('POST', '/desktop/focus', { title: rest.join(' ') || 'Murmur' })
    break
  case 'play-mic':
  case 'play_audio_to_mic':
    await req('POST', '/play_audio_to_mic', {
      durationMs: Number(rest[0] || 800),
      amplitude: Number(rest[1] || 0.4),
    })
    break
  case 'insert':
  case 'insert-text':
    await req('POST', '/murmur', {
      method: 'debug.insertText',
      args: [{ text: rest.join(' ') || 'hello' }],
    })
    break
  default:
    console.log(`Usage: node scripts/agent/cli.mjs <command>
  In-app (Playwright/CDP):
    health | start | stop | shot [name] | click <sel> | click-text <text>
    hotkey <down|up|doubleTap> | inject-pcm [ms] [amp] | utterance | snapshot
    murmur <method> [jsonArgsArray] | play-mic [ms] [amp] | insert [phrase]
  OS-level (nut.js / Win32):
    take_screenshot [name] | click-xy <x> <y> [button] [focusTitle]
    type <text> | keys Ctrl+Shift+P | focus [title]
Server: ${BASE}`)
    process.exitCode = cmd ? 1 : 0
}
