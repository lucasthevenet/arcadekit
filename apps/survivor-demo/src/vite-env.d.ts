/**
 * What the app reads of Vite's env beside Vite's own: the variables it takes from `.env.local` or
 * the shell, which Vite hands the app as `import.meta.env`.
 */
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Comma-separated STUN URLs for co-op; empty for none (see `src/app/rooms.ts`). */
  readonly VITE_STUN_URLS?: string;
}
