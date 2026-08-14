/// <reference types="vite/client" />

import type { OrigReadDesktopApi } from '../../shared/contracts'

declare global {
  interface Window {
    origread: OrigReadDesktopApi
  }
}

export {}

