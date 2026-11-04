/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The signalling worker's base URL for co-op (see src/coop/config.ts). */
  readonly VITE_SIGNALLING_URL?: string;
  /** Comma-separated STUN URLs for co-op; empty for none. */
  readonly VITE_STUN_URLS?: string;
}
