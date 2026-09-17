/// <reference types="vite/client" />
/// <reference types="electron-vite/node" />

import type { EspowApi } from './workspace'

declare global {
  interface Window {
    espow: EspowApi
  }
}

export {}
