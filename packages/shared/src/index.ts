/**
 * `@murmur/shared` — the contracts every Murmur process agrees on.
 *
 * Consumed as TypeScript source (see `exports` in package.json) and bundled
 * into whichever process imports it, so there is no build step to keep in sync.
 * Pure types + zod schemas only: no Electron, no Node built-ins, no DOM.
 */

// Domain -------------------------------------------------------------------
export * from './domain/settings'
export * from './domain/dictation'
export * from './domain/dictionary'
export * from './domain/style'
export * from './domain/permissions'
export * from './domain/engine'
export * from './domain/hardware'
export * from './domain/updates'

// Model catalog (PLAN §8) --------------------------------------------------
export * from './catalog/schema'
export * from './catalog/validate'

// IPC ----------------------------------------------------------------------
export * from './ipc/contract'
export * from './ipc/typed'
export * from './ipc/api'

// Native module contract (PLAN §4) -----------------------------------------
export * from './native/interface'
