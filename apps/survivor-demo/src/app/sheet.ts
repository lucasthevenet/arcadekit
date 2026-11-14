/**
 * Where the app's sprite sheet is: one sheet in `public/sprites`, which `pnpm sprites` writes.
 * `resources` hands its load to the genre's `SurvivorsSheet`, `LoadContent` loads it, the engine
 * and the co-op client draw from it, and the app's end frees it.
 *
 * Plain on purpose: it is data.
 */

/** The address of the sheet's JSON, beside its PNG, under the app's base URL. */
export const url = `${import.meta.env.BASE_URL}sprites/survivors.json`;
