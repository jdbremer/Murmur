/**
 * A stand-in for the `electron` module in unit tests.
 *
 * `vitest.config.ts` aliases `electron` here, so a module that imports
 * `clipboard`, `app` or `utilityProcess` at the top level can still be loaded
 * outside Electron. Only the members Murmur's main process actually touches are
 * present — anything else should show up as an obvious `undefined` rather than
 * a plausible fake.
 *
 * The clipboard is a working in-memory implementation, so the injector's
 * save → write → restore sequence can be asserted for real rather than mocked.
 */

interface ClipboardState {
  text: string
  html: string
}

const state: ClipboardState = { text: '', html: '' }

export const clipboard = {
  readText: (): string => state.text,
  readHTML: (): string => state.html,
  writeText: (value: string): void => {
    state.text = value
    state.html = ''
  },
  write: (data: { text?: string; html?: string }): void => {
    state.text = data.text ?? ''
    state.html = data.html ?? ''
  },
  clear: (): void => {
    state.text = ''
    state.html = ''
  },
}

/** Reset the fake clipboard between tests. */
export function resetClipboard(): void {
  state.text = ''
  state.html = ''
}

export const app = {
  getVersion: (): string => '0.0.0-test',
  getName: (): string => 'Murmur',
  getPath: (): string => '/tmp/murmur-test',
  getAppPath: (): string => '/tmp/murmur-test/app',
  isPackaged: false,
  on: (): void => undefined,
  quit: (): void => undefined,
  exit: (): void => undefined,
  requestSingleInstanceLock: (): boolean => true,
  setName: (): void => undefined,
  setLoginItemSettings: (): void => undefined,
  whenReady: async (): Promise<void> => undefined,
}

export const ipcMain = {
  handle: (): void => undefined,
  removeHandler: (): void => undefined,
  on: (): void => undefined,
  removeAllListeners: (): void => undefined,
}

export const utilityProcess = {
  fork: (): never => {
    throw new Error('utilityProcess.fork is not available in unit tests')
  },
}
