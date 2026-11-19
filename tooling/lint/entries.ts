// What each entry of each published package may import: the promise an entry makes is about
// what a program that imports it has to have installed.
//
//   arcadekit/ecs                imports no package at all
//   arcadekit/Browser            imports Effect, and may import @effect/platform-browser
//   every other entry of it      imports Effect and nothing else
//
//   every entry of @arcadekit/three imports arcadekit, Effect and Three.js, and nothing else
//
// The Oxlint rule `arcadekit/entry-imports` (plugin.ts) holds it in the sources, file by file:
// each file keeps to the rule of the entry it is behind, and imports only files whose rule is no
// looser than its own, so an entry reaches nothing its rule refuses. That holds the build too,
// since the build writes each source file to a file of its own (`unbundle` in tsdown.config.ts),
// whose imports are that source's.

const isEffect = (name: string): boolean =>
  name === "effect" || name.startsWith("effect/");
const isArcadekit = (name: string): boolean =>
  name === "arcadekit" || name.startsWith("arcadekit/");
const isThree = (name: string): boolean =>
  name === "three" || name.startsWith("three/");
const isPlatformBrowser = (name: string): boolean =>
  name === "@effect/platform-browser" ||
  name.startsWith("@effect/platform-browser/");

/** The rule of one entry, or of entries that share it. */
export interface EntryRule {
  /** Whether it may import a package, by the specifier it is imported by. */
  readonly may: (specifier: string) => boolean;
  /** Whether its files may name what only a page has, which Node does not. */
  readonly page: boolean;
  /** The rule, said for a message. */
  readonly says: string;
}

const ecs: EntryRule = {
  may: () => false,
  page: false,
  says: "arcadekit/ecs is the storage core alone, plain TypeScript: it imports no package, and no file outside src/ecs",
};
const browser: EntryRule = {
  may: (name) => isEffect(name) || isPlatformBrowser(name),
  page: true,
  says: "arcadekit/Browser imports Effect, and may import @effect/platform-browser",
};
const rest: EntryRule = {
  may: isEffect,
  page: false,
  says: "every entry of arcadekit but arcadekit/Browser imports Effect and nothing else, and does not reach src/Browser.ts: what only a page can use goes there",
};
const three: EntryRule = {
  may: (name) => isArcadekit(name) || isEffect(name) || isThree(name),
  // Three.js draws in a page.
  page: true,
  says: "@arcadekit/three imports arcadekit, Effect and Three.js, its peers, and nothing else",
};

/** The rules whose files a file of each rule may import: those no looser than its own. */
const within = new Map<EntryRule, readonly EntryRule[]>([
  [ecs, [ecs]],
  [rest, [rest, ecs]],
  [browser, [browser, rest, ecs]],
  [three, [three]],
]);

/** Whether a file kept to `from` may import one kept to `to`. */
export const mayReach = (from: EntryRule, to: EntryRule): boolean =>
  within.get(from)?.includes(to) ?? false;

export interface PackageRules {
  /** Its folder under packages/. */
  readonly dir: string;
  /** The rule of a source file, by its path in the package, such as "src/ecs/world.ts". */
  readonly ofFile: (file: string) => EntryRule;
}

export const packages: readonly PackageRules[] = [
  {
    dir: "arcadekit",
    ofFile: (file) => {
      if (/^src\/ecs(?:\/|$)/u.test(file)) {
        return ecs;
      }
      return /^src\/Browser(?:\.ts)?$/u.test(file) ? browser : rest;
    },
  },
  { dir: "three", ofFile: () => three },
];
