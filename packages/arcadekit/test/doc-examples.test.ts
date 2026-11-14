import { readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

/** A stand-in to call with `new`: each instance gets the fields `fields` makes. */
const newable = <T extends object>(fields: () => T) =>
  // oxlint-disable-next-line typescript/no-extraneous-class -- the kit calls these with `new`, which an arrow can't take.
  class {
    constructor() {
      Object.assign(this, fields());
    }
  };

/** A WebGL renderer as far as a stage calls one: it keeps the size it is given, and draws nothing. */
const standInRenderer = () => {
  let size = { width: 1, height: 1, ratio: 1 };
  return {
    domElement: { style: {}, remove: () => undefined },
    setPixelRatio: (ratio: number) => {
      size = { ...size, ratio };
    },
    setSize: (width: number, height: number) => {
      size = { ...size, width, height };
    },
    getDrawingBufferSize: <T extends { set: (x: number, y: number) => T }>(
      target: T
    ): T =>
      target.set(
        Math.floor(size.width * size.ratio),
        Math.floor(size.height * size.ratio)
      ),
    render: () => undefined,
    dispose: () => undefined,
    forceContextLoss: () => undefined,
  };
};

vi.mock(import("three"), async (importOriginal) => ({
  ...(await importOriginal()),
  WebGLRenderer: newable(standInRenderer) as never,
}));

// `arcadekit/net/worker` extends Cloudflare's `DurableObject`, which only Cloudflare's runtime
// has. Its examples make the Worker's handler and its room's class, and run no request into a
// room, so a base class that keeps what Cloudflare would hand it is enough.
// oxlint-disable-next-line vitest/prefer-import-in-mock -- `cloudflare:workers` has types only under tsconfig.worker.json, and this test is checked without them.
vi.mock("cloudflare:workers", () => ({
  DurableObject: newable(() => ({})) as never,
}));

// Runs the `ts` examples of the doc comments of every entry, and checks that each result an
// example shows is true: a line `expression; // => value` holds when the expression gives the
// value (.agents/skills/doc-comments/SKILL.md). `pnpm smoke` compiles the same examples against
// the packed package; this runs them against src/.
//
// An example imports what a game would: any entry, a sub-entry's examples its parent's too
// (`arcadekit/content` beside `arcadekit/content/browser`), `effect`, to run what an entry's Effects do, and
// `effect/persistence`, for the store a save is kept in (EFFECT_MODULES). An example runs as an
// async function's body, awaited, so one may `await Effect.runPromise(...)` where what it shows
// resumes on a fiber of its own, as a Stream's consumer does: `Effect.runSync` flushes only the
// fiber it runs.
//
// An entry that needs the DOM has examples written as a browser runs them. They run here on a
// stand-in of the few globals they use (BROWSER_ENTRIES), made again for each example. An entry
// joins the list with what it uses: the stand-in grows only as far as an example needs. An
// example of `arcadekit/render-three` may import `three` (PEER_MODULES), whose renderer needs
// WebGL, which Node hasn't: it runs on a stand-in renderer that draws nothing and keeps the
// size it is given. An example of `arcadekit/foldkit` may import `foldkit` and `foldkit/message`,
// for the app a viewport and an engine entry are part of. `arcadekit/net/worker` runs on
// Cloudflare, whose `cloudflare:workers` Node hasn't: its examples run on a stand-in of the
// `DurableObject` base class.

const packageDir = path.resolve(import.meta.dirname, "..");
const srcDir = path.join(packageDir, "src");

/** The entries, by import path, each with its public file under src/. */
const entries = Object.entries(
  (
    JSON.parse(
      readFileSync(path.join(packageDir, "package.json"), "utf-8")
    ) as {
      readonly exports: Readonly<Record<string, { readonly source: string }>>;
    }
  ).exports
).map(([key, { source }]) => ({
  entry: key.slice("./".length),
  publicFile: source.slice("./src/".length),
}));

// The entries whose examples run in a browser, by import path.
const BROWSER_ENTRIES: ReadonlySet<string> = new Set([
  "foldkit",
  "input",
  "render-three",
  "save/browser",
]);

// The modules of Effect an example may import, each by its import path.
const EFFECT_MODULES: readonly string[] = ["effect", "effect/persistence"];

// The peer libraries an example may import, each by its import path: `three`, which
// `arcadekit/render-three` draws with, and Foldkit's modules, which `arcadekit/foldkit` binds to.
const PEER_MODULES: readonly string[] = ["three", "foldkit", "foldkit/message"];

/** A key event, as a browser makes one: the fields `arcadekit/input` and `arcadekit/foldkit` read. */
class StandInKeyboardEvent extends Event {
  readonly code: string;
  readonly repeat: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  constructor(
    type: string,
    init?: {
      readonly code?: string;
      readonly repeat?: boolean;
      readonly ctrlKey?: boolean;
      readonly metaKey?: boolean;
      readonly altKey?: boolean;
    }
  ) {
    super(type);
    this.code = init?.code ?? "";
    this.repeat = init?.repeat ?? false;
    this.ctrlKey = init?.ctrlKey ?? false;
    this.metaKey = init?.metaKey ?? false;
    this.altKey = init?.altKey ?? false;
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

/** A `ResizeObserver` that never calls back: an element's size is what it was laid out at. */
const StandInResizeObserver = newable(() => ({
  observe: () => undefined,
  disconnect: () => undefined,
}));

/**
 * What a browser gives the examples of BROWSER_ENTRIES: a window to dispatch key events on, with
 * one device pixel to a CSS pixel, a document that makes elements to listen on, each laid out
 * 640 by 480, no gamepad, a localStorage that starts empty, and a ResizeObserver that never
 * calls back. Node's EventTarget and Event do the dispatching.
 */
const browserStandIn = (): Readonly<Record<string, unknown>> => {
  const document = {
    pointerLockElement: null,
    createElement: (tagName: string) =>
      Object.assign(new EventTarget(), {
        tagName: tagName.toUpperCase(),
        style: {},
        ownerDocument: document,
        clientWidth: 640,
        clientHeight: 480,
        append: () => undefined,
        setPointerCapture: () => undefined,
      }),
  };
  return {
    window: Object.assign(new EventTarget(), { devicePixelRatio: 1 }),
    document,
    navigator: { getGamepads: () => [] },
    KeyboardEvent: StandInKeyboardEvent,
    localStorage: storageStandIn(),
    ResizeObserver: StandInResizeObserver,
  };
};

/** The constructor of async functions, which an example's body is made with, so it may `await`. */
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...parameters: string[]
) => (...values: unknown[]) => Promise<void>;

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

/** The modules of an entry: every source file of its folder but internals and other entries'. */
const modulesOf = (publicFile: string): readonly string[] => {
  const dir = path.posix.dirname(publicFile);
  return readdirSync(path.join(srcDir, dir), { encoding: "utf-8" })
    .filter((file) => file.endsWith(".ts"))
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
        /^import (?<names>\{[\s\S]*?\}) from "(?<from>arcadekit\/[\w/-]+|effect(?:\/[\w-]+)?|foldkit(?:\/[\w-]+)?)";$/gmu,
        (_whole, names: string, from: string) =>
          `const ${names} = kit[${JSON.stringify(from)}];`
      )
      // An entry a game imports whole, such as `import * as Game from "arcadekit/game"`.
      .replaceAll(
        /^import \* as (?<name>\w+) from "(?<from>arcadekit\/[\w/-]+|effect(?:\/[\w-]+)?)";$/gmu,
        (_whole, name: string, from: string) =>
          `const ${name} = kit[${JSON.stringify(from)}];`
      )
      .replaceAll(
        /^import \* as (?<name>\w+) from "(?<from>three)";$/gmu,
        (_whole, name: string, from: string) =>
          `const ${name} = kit[${JSON.stringify(from)}];`
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
        [...EFFECT_MODULES, ...PEER_MODULES].map(
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
    await new AsyncFunction("kit", "check", runnable(code))(kit, check);
    expect(
      shown,
      "The example shows no result as `// =>`: show what a reader should see."
    ).toBeGreaterThan(0);
  });
});
