// oxlint-disable eslint/no-await-in-loop -- one page plays the seeds one after another, so each run has the engine to itself.
import { chromium, firefox, webkit } from "playwright";
import type { Browser, BrowserType } from "playwright";
import { build } from "vite";
import { beforeAll, describe, expect, it } from "vitest";

import { sourceCondition } from "../../../scripts/source-condition";
import { LONG_RUN_RECORDED, LONG_RUN_SEEDS, longRun } from "../src/long-run";
import type { LongRunResult, LongRunSeed } from "../src/long-run";
import type { run } from "./page";

// Cross-browser determinism (#25, ADR-0011): the long run that determinism.test.ts pins
// in Node, played in Chromium (V8), Firefox (SpiderMonkey) and WebKit (JavaScriptCore). Each
// browser must give the recorded final hash and trace for every seed, so Node is the fourth
// engine. On a mismatch it names the first step whose state differs from Node's.
//
// Vite bundles page.ts (survivors' simulation, GameLoop and long-run.ts) into one script, and
// Playwright serves it from a made-up origin with `route`: nothing touches the network.
//
// Run it with `pnpm test:browsers`. A browser Playwright can't launch is skipped with a message,
// unless CI is set: then it fails, so CI can't pass without all three. Install them with
// `pnpm exec playwright install --with-deps chromium firefox webkit`.

const BROWSERS: Readonly<Record<string, BrowserType>> = {
  chromium,
  firefox,
  webkit,
};

const ORIGIN = "http://arcadekit.test";
const PAGE = `<!doctype html><meta charset="utf-8"><title>arcadekit long run</title><script src="/page.js"></script>`;

/** page.ts and everything it imports, as one classic script defining `arcadekitLongRun`. */
const bundle = async (): Promise<string> => {
  const result = await build({
    root: import.meta.dirname,
    configFile: false,
    logLevel: "warn",
    plugins: [sourceCondition()],
    build: {
      write: false,
      minify: false,
      target: "es2022",
      lib: {
        entry: "page.ts",
        formats: ["iife"],
        name: "arcadekitLongRun",
        fileName: "page",
      },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(
    (output) => ("output" in output ? output.output : [])
  );
  const chunks = outputs.filter((output) => output.type === "chunk");
  if (chunks.length !== 1) {
    throw new Error(`expected one bundled chunk, got ${chunks.length}`);
  }
  return chunks[0]!.code;
};

const hex = (value: number) => `0x${value.toString(16).padStart(8, "0")}`;

/** The first index where the two traces differ, or -1. */
const firstDivergence = (
  a: ArrayLike<number>,
  b: ArrayLike<number>
): number => {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) {
      return i;
    }
  }
  return a.length === b.length ? -1 : length;
};

/** What's wrong with one engine's run of one seed, or null if it matches. */
const compare = (
  engine: string,
  seed: LongRunSeed,
  got: Pick<LongRunResult, "final" | "trace"> & {
    readonly traces: ArrayLike<number>;
  },
  reference: LongRunResult | null
): string | null => {
  const [final, trace] = LONG_RUN_RECORDED[seed];
  const diverged =
    reference === null ? -1 : firstDivergence(got.traces, reference.traces);
  if (got.final === final && got.trace === trace && diverged === -1) {
    return null;
  }
  let where = "";
  if (reference !== null) {
    where =
      diverged === -1
        ? "; every step matches Node's trace"
        : `; first diverging step ${diverged} of ${got.traces.length} (Node ${hex(reference.traces[diverged] ?? 0)}, ${engine} ${hex(got.traces[diverged] ?? 0)})`;
  }
  return `${engine}, seed ${seed}: final ${hex(got.final)} trace ${hex(got.trace)}, recorded ${hex(final)} ${hex(trace)}${where}`;
};

/** A browser, or why it can't be launched. */
const launch = async (type: BrowserType): Promise<Browser | string> => {
  try {
    return await type.launch();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.split("\n").find((line) => line.trim() !== "") ?? message;
  }
};

describe("survivors long-run determinism across browsers", () => {
  let script = "";
  const node = new Map<LongRunSeed, LongRunResult>();

  beforeAll(async () => {
    script = await bundle();
    for (const seed of LONG_RUN_SEEDS) {
      node.set(seed, longRun(seed));
    }
  });

  it("Node gives the recorded hashes", () => {
    const mismatches = LONG_RUN_SEEDS.map((seed) =>
      compare("node", seed, node.get(seed)!, null)
    ).filter((mismatch) => mismatch !== null);
    expect(mismatches).toStrictEqual([]);
  });

  it.for(Object.keys(BROWSERS))(
    "%s gives the recorded hashes at every step",
    async (name, { skip }) => {
      const browser = await launch(BROWSERS[name]!);
      if (typeof browser === "string") {
        const message = `${name} can't be launched (${browser}). Install it with \`pnpm exec playwright install --with-deps ${name}\`.`;
        if (process.env.CI) {
          throw new Error(`${message} CI must run all three browsers.`);
        }
        console.warn(`Skipping ${name}: ${message}`);
        skip(message);
        return;
      }
      try {
        const context = await browser.newContext();
        await context.route("**/*", (route) => {
          const url = route.request().url();
          if (url === `${ORIGIN}/`) {
            return route.fulfill({ contentType: "text/html", body: PAGE });
          }
          if (url === `${ORIGIN}/page.js`) {
            return route.fulfill({
              contentType: "text/javascript",
              body: script,
            });
          }
          return route.abort();
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${ORIGIN}/`);
        const engine = `${name} ${browser.version()}`;
        const mismatches: string[] = [];
        for (const seed of LONG_RUN_SEEDS) {
          const result = await page.evaluate(
            (s) =>
              (
                globalThis as unknown as {
                  readonly arcadekitLongRun: { readonly run: typeof run };
                }
              ).arcadekitLongRun.run(s),
            seed
          );
          console.info(
            `${engine}: seed ${seed}, ${result.traces.length} steps in ${(result.ms / 1000).toFixed(1)} s, ${result.kills} kills, level ${result.level}`
          );
          const mismatch = compare(engine, seed, result, node.get(seed)!);
          if (mismatch !== null) {
            mismatches.push(mismatch);
          }
        }
        expect(errors).toStrictEqual([]);
        expect(mismatches).toStrictEqual([]);
      } finally {
        await browser.close();
      }
    }
  );
});
