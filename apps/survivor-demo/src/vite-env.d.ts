/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Comma-separated STUN URLs for co-op; empty for none (see src/coop/config.ts). */
  readonly VITE_STUN_URLS?: string;
}
