import type { KreOsApi } from './index'

declare global {
  interface Window {
    kreos: KreOsApi
  }
}

export {}
