'use strict'

/**
 * @murmur/native — entry point for Murmur OS glue (PLAN §4, §4.1).
 *
 * Resolution order:
 *
 *   1. unsupported platform       → typed no-op stub (`available: false`)
 *   2. supported, binding won't load → typed no-op stub (`available: false`)
 *   3. supported, binding loaded  → binding functions with per-member fallback
 *
 * Windows lives in `src/win/`; macOS in `src/murmur_native.mm`. Linux stays stub.
 */

const BINDING_PATHS = ['./build/Release/murmur_native.node', './build/Debug/murmur_native.node']

const SUPPORTED = new Set(['darwin', 'win32'])

/** Every capability, inert. Safe to call; nothing happens. */
function createStub(reason) {
  return {
    available: false,
    startHotkeyListener() {},
    stopHotkeyListener() {},
    sendPasteShortcut() {
      return { ok: false, error: reason }
    },
    insertTextViaAccessibility() {
      return { ok: false, error: reason }
    },
    getFrontmostApp() {
      return null
    },
    isSecureInputActive() {
      return false
    },
    isForegroundElevated() {
      return false
    },
    permissions: {
      check() {
        return {
          microphone: 'unavailable',
          accessibility: 'unavailable',
          inputMonitoring: 'unavailable',
        }
      },
      async request() {
        return 'unavailable'
      },
      openSettings() {},
    },
    platformInfo() {
      return 'stub (' + reason + ')'
    },
  }
}

function adopt(binding, stub, name) {
  return typeof binding[name] === 'function' ? binding[name].bind(binding) : stub[name]
}

function fromBinding(binding) {
  const stub = createStub('not implemented in this build of @murmur/native')
  const bindingPermissions = binding.permissions ?? {}

  return {
    available: typeof binding.isAvailable === 'function' ? Boolean(binding.isAvailable()) : true,
    startHotkeyListener: adopt(binding, stub, 'startHotkeyListener'),
    stopHotkeyListener: adopt(binding, stub, 'stopHotkeyListener'),
    sendPasteShortcut: adopt(binding, stub, 'sendPasteShortcut'),
    insertTextViaAccessibility: adopt(binding, stub, 'insertTextViaAccessibility'),
    getFrontmostApp: adopt(binding, stub, 'getFrontmostApp'),
    isSecureInputActive: adopt(binding, stub, 'isSecureInputActive'),
    isForegroundElevated: adopt(binding, stub, 'isForegroundElevated'),
    permissions: {
      check: adopt(bindingPermissions, stub.permissions, 'check'),
      request: adopt(bindingPermissions, stub.permissions, 'request'),
      openSettings: adopt(bindingPermissions, stub.permissions, 'openSettings'),
    },
    platformInfo: adopt(binding, stub, 'platformInfo'),
  }
}

function load() {
  if (!SUPPORTED.has(process.platform)) {
    return createStub('unsupported platform "' + process.platform + '"')
  }

  let lastError = null
  for (const path of BINDING_PATHS) {
    try {
      return fromBinding(require(path))
    } catch (error) {
      lastError = error
    }
  }

  return createStub(
    'failed to load native binding: ' +
      (lastError && lastError.message ? lastError.message : 'unknown'),
  )
}

module.exports = load()
module.exports.createStub = createStub
