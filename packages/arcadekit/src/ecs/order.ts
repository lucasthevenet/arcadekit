/**
 * The orders a world is saved and hashed in, which must be the same on every
 * machine: strings compared a code unit at a time, never by locale.
 *
 * No Effect dependency.
 */

/** Orders two strings a code unit at a time. */
export const compareText = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  }

  return a > b ? 1 : 0;
};

/** Orders by name, a code unit at a time. */
export const byName = (
  a: { readonly name: string },
  b: { readonly name: string }
): number => compareText(a.name, b.name);
