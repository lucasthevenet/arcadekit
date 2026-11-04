// oxlint-disable eslint/no-await-in-loop -- the test plays a script in time order, one step after another.
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { startLocalSignalling } from "@gamekit/signalling/local";
import type { LocalSignalling } from "@gamekit/signalling/local";
import { createServer } from "vite";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Co-op end to end (#25): the local signalling server, the demo on Vite's dev server, and two
// Chromium pages, each its own player. The host hosts, the guest joins with the code the host's
// page shows, each picks a hero, the host starts, and both play a few seconds pressing different
// keys and taking every upgrade offered. Both pages must then report the same state hash at the
// same steps, and no error.
//
// A single-player run is checked too, to show it still runs on the single-player engine.
//
// Run it with `pnpm test:e2e`. It isn't part of `pnpm test`: it needs Chromium, starts two
// servers and takes about 15 s. It skips itself when Playwright or Chromium is missing.

/** The part of Playwright this test uses. Playwright isn't a dependency: it's found at run time. */
interface Locator {
  readonly count: () => Promise<number>;
  readonly first: () => { readonly click: () => Promise<void> };
}
interface Page {
  readonly goto: (url: string) => Promise<unknown>;
  readonly click: (selector: string) => Promise<void>;
  readonly fill: (selector: string, value: string) => Promise<void>;
  readonly textContent: (selector: string) => Promise<string | null>;
  readonly waitForSelector: (
    selector: string,
    options?: { readonly timeout?: number }
  ) => Promise<unknown>;
  readonly waitForFunction: (
    body: string,
    arg?: unknown,
    options?: { readonly timeout?: number }
  ) => Promise<unknown>;
  readonly evaluate: <T>(body: string) => Promise<T>;
  readonly locator: (selector: string) => Locator;
  readonly keyboard: {
    readonly down: (key: string) => Promise<void>;
    readonly up: (key: string) => Promise<void>;
  };
  readonly on: (event: "pageerror", listener: (error: Error) => void) => void;
}
interface Browser {
  readonly newContext: (options?: {
    readonly viewport?: { readonly width: number; readonly height: number };
  }) => Promise<{ readonly newPage: () => Promise<Page> }>;
  readonly close: () => Promise<void>;
}
interface Playwright {
  readonly chromium: {
    readonly launch: (options?: {
      readonly args?: string[];
    }) => Promise<Browser>;
  };
}

/** Playwright, if it can be loaded here. */
const playwright = ((): Playwright | undefined => {
  try {
    return createRequire(import.meta.url)("playwright") as Playwright;
  } catch {
    return undefined;
  }
})();

interface Debug {
  readonly stepIndex: number;
  readonly error: string | null;
  readonly hashes: Readonly<Record<string, number>>;
}

const debug = (page: Page) =>
  page.evaluate<Debug>("globalThis.gamekitCoop.debug()");

const demoRoot = fileURLToPath(new URL("..", import.meta.url));

let browser: Browser | undefined;
let signalling: LocalSignalling | undefined;
let vite: ViteDevServer | undefined;
let skipReason: string | undefined;

describe("co-op in two browsers", () => {
  beforeAll(async () => {
    if (playwright === undefined) {
      skipReason = "Playwright isn't installed";
      return;
    }
    try {
      browser = await playwright.chromium.launch();
    } catch (error) {
      skipReason = `Chromium didn't launch: ${String(error)}`;
      return;
    }
    signalling = await startLocalSignalling({ port: 0 });
    // Vite exposes VITE_* variables from the environment to the app (src/coop/config.ts).
    process.env.VITE_SIGNALLING_URL = signalling.url;
    // No STUN: both pages are on this machine, and the sandbox may have no route out.
    process.env.VITE_STUN_URLS = "";
    vite = await createServer({
      root: demoRoot,
      configFile: `${demoRoot}vite.config.ts`,
      logLevel: "warn",
      server: { host: "127.0.0.1", port: 5199, strictPort: false },
    });
    await vite.listen();
  });

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
    await signalling?.close();
  });

  it("still plays single-player on the single-player engine", async ({
    skip,
  }) => {
    if (
      skipReason !== undefined ||
      browser === undefined ||
      vite === undefined
    ) {
      skip(skipReason);
      return;
    }
    const context = await browser.newContext({
      viewport: { width: 480, height: 360 },
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(vite.resolvedUrls!.local[0]!);
    await page.click("button:has-text('Start run')");
    await page.waitForSelector("text=Esc to pause", { timeout: 15_000 });
    await page.keyboard.down("Escape");
    await page.keyboard.up("Escape");
    await page.waitForSelector("text=Resume");
    expect([
      errors,
      await page.evaluate("globalThis.gamekitCoop.debug().stepIndex"),
    ]).toStrictEqual([[], 0]);
  });

  it("hosts, joins and plays the same run on both pages", async ({ skip }) => {
    if (
      skipReason !== undefined ||
      browser === undefined ||
      vite === undefined
    ) {
      skip(skipReason);
      return;
    }
    const url = vite.resolvedUrls!.local[0]!;
    const errors: string[] = [];
    const open = async () => {
      // A small window: Chromium draws WebGL in software here, and a big one starves the timers.
      const context = await browser!.newContext({
        viewport: { width: 480, height: 360 },
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.click("text=Co-op");
      return page;
    };
    const host = await open();
    const guest = await open();

    await host.click("text=Host a run");
    await host.waitForSelector(".join-code", { timeout: 15_000 });
    const code = (await host.textContent(".join-code"))!.trim();
    await guest.fill("input[name=join-code]", code.toLowerCase());
    await guest.click("button:has-text('Join')");
    await guest.waitForSelector("text=Waiting for the host to start", {
      timeout: 20_000,
    });
    // The guest plays the second hero; the host keeps the first.
    await guest.click(".heroes .hero:nth-child(2)");
    await host.waitForFunction(
      "document.querySelectorAll('.players li').length === 2 && !document.body.textContent.includes('choosing…')",
      undefined,
      { timeout: 10_000 }
    );
    await host.click("button:has-text('Start run')");
    await Promise.all(
      [host, guest].map((page) =>
        page.waitForFunction(
          "globalThis.gamekitCoop.debug().stepIndex > 60",
          undefined,
          { timeout: 15_000 }
        )
      )
    );

    // Different inputs on each page, for a few seconds, taking every upgrade offered.
    const legs: [string, string][] = [
      ["ArrowRight", "ArrowLeft"],
      ["ArrowUp", "ArrowDown"],
      ["ArrowLeft", "ArrowUp"],
    ];
    for (const [hostKey, guestKey] of legs) {
      await host.keyboard.down(hostKey);
      await guest.keyboard.down(guestKey);
      for (let i = 0; i < 4; i++) {
        await sleep(400);
        for (const page of [host, guest]) {
          if ((await page.locator(".choice").count()) > 0) {
            await page.locator(".choice").first().click();
          }
        }
      }
      await host.keyboard.up(hostKey);
      await guest.keyboard.up(guestKey);
    }

    // Both report hashes for the same steps, and they agree.
    await host.waitForFunction(
      "globalThis.gamekitCoop.debug().stepIndex > 300",
      undefined,
      { timeout: 10_000 }
    );
    const [a, b] = await Promise.all([debug(host), debug(guest)]);
    const common = Object.keys(a.hashes).filter((step) => step in b.hashes);
    const failed = await Promise.all(
      [host, guest].map((page) => page.locator(".coop-error").count())
    );
    expect([
      a.error,
      b.error,
      failed,
      errors,
      common.length >= 3,
      common.map((step) => a.hashes[step]),
    ]).toStrictEqual([
      null,
      null,
      [0, 0],
      [],
      true,
      common.map((step) => b.hashes[step]),
    ]);
  });
});
