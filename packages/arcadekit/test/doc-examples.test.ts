import { readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

// Runs the `ts` examples of the doc comments of every entry in Effect's module shape, and checks
// that each result an example shows is true: a line `expression; // => value` holds when the
// expression gives the value (docs/code-style.md, "The doc comment"). `pnpm smoke` compiles the
// same examples against the packed package; this runs them against src/.
//
// The entries are those off NOT_YET_EFFECT_STYLE, which this reads from the style test's text,
// as `pnpm smoke` does: the list is the style test's. An example imports what a game would: any of
// those entries, a sub-entry's examples its parent's too (`arcadekit/content` beside
// `arcadekit/content/browser`), `effect`, to run what an entry's Effects do, and
// `effect/persistence`, for the store a save is kept in (EFFECT_MODULES).
//
// An entry that needs the DOM has examples written as a browser runs them. They run here on a
// stand-in of the few globals they use (BROWSER_ENTRIES), made again for each example. An entry
// joins the list with what it uses: the stand-in grows only as far as an example needs.

const packageDir = path.resolve(import.meta.dirname, "..");
const srcDir = path.join(packageDir, "src");

const notYet = new Set(
  [
    ...(
      /^const NOT_YET_EFFECT_STYLE: readonly string\[\] = \[(?<names>[^\]]*)\];$/mu.exec(
        readFileSync(path.join(packageDir, "test", "style.test.ts"), "utf-8")
      )?.groups?.names ?? ""
    ).matchAll(/"(?<name>[^"]+)"/gu),
  ].map((match) => match.groups?.name ?? "")
);

/** The entries in Effect's shape, by import path, each with its public file under src/. */
const entries = Object.entries(
  (
    JSON.parse(
      readFileSync(path.join(packageDir, "package.json"), "utf-8")
    ) as {
      readonly exports: Readonly<Record<string, { readonly source: string }>>;
    }
  ).exports
)
  .map(([key, { source }]) => ({
    entry: key.slice("./".length),
    publicFile: source.slice("./src/".length),
  }))
  .filter(({ entry }) => !notYet.has(entry.split("/", 1)[0] ?? ""));

// The entries whose examples run in a browser, by import path.
const BROWSER_ENTRIES: ReadonlySet<string> = new Set(["input", "save/browser"]);

// The modules of Effect an example may import, each by its import path.
const EFFECT_MODULES: readonly string[] = ["effect", "effect/persistence"];

/** A key event, as a browser makes one: the fields `arcadekit/input` reads. */
class StandInKeyboardEvent extends Event {
  readonly code: string;
  readonly repeat: boolean;
  constructor(
    type: string,
    init?: { readonly code?: string; readonly repeat?: boolean }
  ) {
    super(type);
    this.code = init?.code ?? "";
    this.repeat = init?.repeat ?? false;
  }
}

/** A browser's `localStorage`, as far as Effect's store over it calls one: kept in memory. */
const storageStandIn = () => {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
    clear: () => {
      items.clear();
    },
  };
};

/**
 * What a browser gives the examples of BROWSER_ENTRIES: a window to dispatch key events on, a
 * document that makes elements to listen on, no gamepad, and a localStorage that starts empty.
 * Node's EventTarget and Event do the dispatching.
 */
const browserStandIn = (): Readonly<Record<string, unknown>> => {
  const document = {
    pointerLockElement: null,
    createElement: (tagName: string) =>
      Object.assign(new EventTarget(), {
        tagName: tagName.toUpperCase(),
        style: {},
        ownerDocument: document,
        setPointerCapture: () => undefined,
      }),
  };
  return {
    window: new EventTarget(),
    document,
    navigator: { getGamepads: () => [] },
    KeyboardEvent: StandInKeyboardEvent,
    localStorage: storageStandIn(),
  };
};

/** One example of a doc comment: where it is, its title and its code. */
interface Example {
  readonly name: string;
  readonly code: string;
}

/** The examples of a module's doc comments, each named by its file and its title. */
const examplesOf = (file: string): readonly Example[] =>
  (
    readFileSync(path.join(srcDir, file), "utf-8").match(
      /\/\*\*[\s\S]*?\*\//gu
    ) ?? []
  )
    .map((comment) => comment.replaceAll(/^\s*\/?\*+\/? ?/gmu, ""))
    .flatMap((text) =>
      [
        ...text.matchAll(
          /^\*\*Example\*\* \((?<title>[^)]+)\)\n+```ts\n(?<code>[\s\S]*?)^```/gmu
        ),
      ].map((match) => ({
        name: `${file}: ${match.groups?.title ?? ""}`,
        code: match.groups?.code ?? "",
      }))
    );

/** The modules of an entry: every source file of its folder but tests, internals and other entries'. */
const modulesOf = (publicFile: string): readonly string[] => {
  const dir = path.posix.dirname(publicFile);
  return readdirSync(path.join(srcDir, dir), { encoding: "utf-8" })
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => path.posix.join(dir, file));
};

/**
 * The example as a function body: its imports of the kit read from `kit`, each result shown as
 * `// =>` checked with `check`, and its types stripped.
 */
const runnable = (code: string): string =>
  stripTypeScriptTypes(
    code
      .replaceAll(/^import type [\s\S]*?;$/gmu, "")
      .replaceAll(
        /^import (?<names>\{[\s\S]*?\}) from "(?<from>arcadekit\/[\w/-]+|effect(?:\/[\w-]+)?)";$/gmu,
        (_whole, names: string, from: string) =>
          `const ${names} = kit[${JSON.stringify(from)}];`
      )
      .replaceAll(
        /^(?<indent>\s*)(?<expression>.+?);\s*\/\/ => (?<value>.+)$/gmu,
        (_whole, indent: string, expression: string, value: string) =>
          `${indent}check((${expression}), (${value}), ${JSON.stringify(expression)});`
      )
  );

describe.each(entries)("arcadekit/$entry", ({ entry, publicFile }) => {
  const examples = modulesOf(publicFile).flatMap(examplesOf);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has examples to run", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  it.each(examples)("$name", async ({ code }) => {
    expect(
      code.split("\n").filter((line) => /^\s*[)\]}].*\/\/ =>/u.test(line)),
      "A result shown as `// =>` ends an expression that spans lines. Name what spans lines first, then show its result on one line."
    ).toStrictEqual([]);
    const kit: Readonly<Record<string, unknown>> = Object.fromEntries([
      ...(await Promise.all(
        EFFECT_MODULES.map(
          async (module) => [module, await import(module)] as const
        )
      )),
      ...(await Promise.all(
        entries.map(
          async ({ entry: imported, publicFile: file }) =>
            [
              `arcadekit/${imported}`,
              await import(path.join(srcDir, file)),
            ] as const
        )
      )),
    ]);
    if (BROWSER_ENTRIES.has(entry)) {
      for (const [name, value] of Object.entries(browserStandIn())) {
        vi.stubGlobal(name, value);
      }
    }
    let shown = 0;
    const check = (got: unknown, want: unknown, expression: string) => {
      shown += 1;
      expect(got, `${expression} // => ${String(want)}`).toStrictEqual(want);
    };
    // oxlint-disable-next-line eslint/no-new-func -- the example is the kit's own doc comment, run as its reader would.
    new Function("kit", "check", runnable(code))(kit, check);
    expect(
      shown,
      "The example shows no result as `// =>`: show what a reader should see."
    ).toBeGreaterThan(0);
  });
});
