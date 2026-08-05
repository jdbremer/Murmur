'use strict'

/**
 * @murmur/native — the single entry point for Murmur's macOS glue (PLAN §4).
 *
 * The desktop app must import this file, never `build/Release/*.node` directly.
 * Resolution order:
 *
 *   1. not macOS                  → typed no-op stub (`available: false`)
 *   2. macOS, binding won't load  → typed no-op stub (`available: false`)
 *   3. macOS, binding loaded      → the binding's functions, with a no-op
 *                                   standing in for anything it does not yet
 *                                   export
 *
 * Case 3's partial fallback is deliberate: Stage 2 implements the native
 * functions one at a time, and each one starts working the moment the binding
 * exports it — no changes needed here.
 *
 * The interface is mirrored (and documented) as `MurmurNative` in
 * `@murmur/shared`; `index.d.ts` next to this file types it for consumers.
 * This file stays dependency-free on purpose — it has to run before, and
 * without, any bundler.
 *
 * The package is macOS-only for v1 (`"os": ["darwin"]`). The Windows and Linux
 * backends planned for M7/M8 (PLAN §4.1) slot in as extra `conditions` entries
 * in binding.gyp and a widened `os` field — the resolution logic below does not
 * change, only the platform check.
 */

const BINDING_PATHS = ['./build/Release/murmur_native.node', './build/Debug/murmur_native.node']

/** Every capability, inert. Safe to call; nothing happens. */
function createStub(reason) {
  return {
    available: false,
    startHotkeyListener() {},
    stopHotkeyListener() {},
    insertText() {
      return { ok: false, method: 'none', error: reason }
    },
    getFrontmostApp() {
      return null
    },
    isSecureInputActive() {
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

/** Prefer the binding's implementation, fall back to the stub's, per member. */
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
    insertText: adopt(binding, stub, 'insertText'),
    getFrontmostApp: adopt(binding, stub, 'getFrontmostApp'),
    isSecureInputActive: adopt(binding, stub, 'isSecureInputActive'),
    permissions: {
      check: adopt(bindingPermissions, stub.permissions, 'check'),
      request: adopt(bindingPermissions, stub.permissions, 'request'),
      openSettings: adopt(bindingPermissions, stub.permissions, 'openSettings'),
    },
    platformInfo: adopt(binding, stub, 'platformInfo'),
  }
}

function load() {
  if (process.platform !== 'darwin') {
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

  // A missing build is the common case (fresh checkout, `npm run native:build`
  // not run yet); a load failure can also mean a permission-denied dlopen.
  return createStub(
    'failed to load native binding: ' +
      (lastError && lastError.message ? lastError.message : 'unknown'),
  )
}

module.exports = load()
module.exports.createStub = createStub
