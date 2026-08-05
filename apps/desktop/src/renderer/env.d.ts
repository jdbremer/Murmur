/// <reference types="vite/client" />

import type { MurmurApi } from '@murmur/shared'

declare global {
  interface Window {
    /** Exposed by the preload script. See `src/preload/index.ts`. */
    murmur: MurmurApi
  }
}

export {}
