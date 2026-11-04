// oxlint-disable eslint/no-await-in-loop -- the test plays a script in time order, one step after another.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
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
// Then a hidden guest: the guest plays from a Chromium of its own, in a tab that a second tab then
// covers, so the browser really hides it and throttles its main-thread timers to about once a
// second, as a background tab on a desktop. (Playwright keeps its own pages visible, and
// dispatching `visibilitychange` would throttle nothing.) The run must keep stepping at full rate
// for longer than the host's 10 s drop-out, with no one removed and the hashes agreeing.
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
interface Context {
  readonly newPage: () => Promise<Page>;
  readonly pages: () => Page[];
}
interface Browser {
  readonly newContext: (options?: {
    readonly viewport?: { readonly width: number; readonly height: number };
  }) => Promise<Context>;
  readonly contexts: () => Context[];
  readonly newBrowserCDPSession: () => Promise<{
    readonly send: (method: string, params?: object) => Promise<unknown>;
  }>;
  readonly close: () => Promise<void>;
}
interface Playwright {
  readonly chromium: {
    readonly launch: (options?: {
      readonly args?: string[];
    }) => Promise<Browser>;
    readonly executablePath: () => string;
    readonly connectOverCDP: (
      endpoint: string,
      options?: { readonly noDefaults?: boolean }
    ) => Promise<Browser>;
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

/**
 * A Chromium of its own, started as a person's would be, without Playwright's flags that keep
 * a background tab's timers at full rate, and attached with no default overrides (Playwright's
 * focus emulation would keep its pages visible). `hide` opens a second tab in front of the page.
 */
const startDesktopChromium = async (pw: Playwright) => {
  const profile = mkdtempSync(path.join(tmpdir(), "gamekit-e2e-"));
  const child: ChildProcess = spawn(
    pw.chromium.executablePath(),
    [
      "--headless=new",
      "--no-sandbox",
      "--no-first-run",
      "--remote-debugging-port=0",
      "--window-size=480,360",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  let output = "";
  let endpoint: string | undefined;
  for await (const chunk of child.stderr!) {
    output += String(chunk);
    endpoint = /DevTools listening on (?<url>ws:\/\/\S+)/u.exec(output)?.groups
      ?.url;
    if (endpoint !== undefined) {
      break;
    }
  }
  if (endpoint === undefined) {
    throw new Error(`Chromium didn't start: ${output}`);
  }
  const desktop = await pw.chromium.connectOverCDP(endpoint, {
    noDefaults: true,
  });
  const context = desktop.contexts()[0]!;
  const page = context.pages()[0] ?? (await context.newPage());
  return {
    page,
    hide: async () => {
      const session = await desktop.newBrowserCDPSession();
      await session.send("Target.createTarget", {
        url: "about:blank",
        newWindow: false,
      });
    },
    close: async () => {
      await desktop.close();
      const exited =
        child.exitCode === null ? once(child, "exit") : Promise.resolve();
      child.kill();
      await exited;
      rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    },
  };
};

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
    const errors: string[] = [];
    const host = await openPage(browser, errors);
    const guest = await openPage(browser, errors);
    await startRun(host, guest, vite.resolvedUrls!.local[0]!);

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
        await takeOffers([host, guest]);
      }
      await host.keyboard.up(hostKey);
      await guest.keyboard.up(guestKey);
    }

    await host.waitForFunction(
      "globalThis.gamekitCoop.debug().stepIndex > 300",
      undefined,
      { timeout: 10_000 }
    );
    expect(await outcome(host, guest, errors)).toStrictEqual(AGREED);
  });

  it("keeps stepping at full rate while the guest's tab is hidden", async ({
    skip,
  }) => {
    if (
      skipReason !== undefined ||
      playwright === undefined ||
      browser === undefined ||
      vite === undefined
    ) {
      skip(skipReason);
      return;
    }
    const errors: string[] = [];
    const desktop = await startDesktopChromium(playwright);
    try {
      const host = await openPage(browser, errors);
      const guest = desktop.page;
      guest.on("pageerror", (error) => errors.push(error.message));
      await startRun(host, guest, vite.resolvedUrls!.local[0]!);

      // A main-thread timer on the guest's page, to see the browser throttle it.
      await guest.evaluate(
        "globalThis.probeTicks = 0; setInterval(() => globalThis.probeTicks++, 10); 0"
      );
      await desktop.hide();
      await guest.waitForFunction("document.visibilityState === 'hidden'");
      const read = async () => {
        const { stepIndex } = await debug(host);
        return {
          hostStep: stepIndex,
          probe: await guest.evaluate<number>("globalThis.probeTicks"),
          atMs: performance.now(),
        };
      };
      const before = await read();
      // Longer than the host's drop-out (about 10 s of stalling on one player).
      const HIDDEN_MS = 13_000;
      for (let waited = 0; waited < HIDDEN_MS; waited += 500) {
        await sleep(500);
        await takeOffers([host]);
      }
      const after = await read();
      const seconds = (after.atMs - before.atMs) / 1000;
      const throttled = (after.probe - before.probe) / seconds < 10;
      if (!throttled) {
        skip("This Chromium doesn't throttle a hidden tab's timers");
        return;
      }
      // A run steps 60 times a second, even while frozen for a level-up the hidden guest hasn't
      // picked. A guest ticked by its throttled main thread would hold it to a few.
      const stepsPerSecond = (after.hostStep - before.hostStep) / seconds;
      expect({
        hidden: await guest.evaluate<string>("document.visibilityState"),
        keptUp: stepsPerSecond > 50,
      }).toStrictEqual({ hidden: "hidden", keptUp: true });
      expect(await outcome(host, guest, errors)).toStrictEqual(AGREED);
    } finally {
      await desktop.close();
    }
  });
});

/** A small window: Chromium draws WebGL in software here, and a big one starves the timers. */
const openPage = async (from: Browser, errors: string[]) => {
  const context = await from.newContext({
    viewport: { width: 480, height: 360 },
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  return page;
};

/** Opens co-op on both pages, hosts on one, joins on the other, and starts the run. */
const startRun = async (host: Page, guest: Page, url: string) => {
  for (const page of [host, guest]) {
    await page.goto(url);
    await page.click("text=Co-op");
  }
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
};

/** Takes the first choice of every upgrade offer open on these pages. */
const takeOffers = async (pages: readonly Page[]) => {
  for (const page of pages) {
    if ((await page.locator(".choice").count()) > 0) {
      await page.locator(".choice").first().click();
    }
  }
};

/** What the test expects of `outcome`: no error anywhere, and hashes for the same steps that agree. */
const AGREED = {
  errors: [null, null],
  failed: [0, 0],
  pageErrors: [],
  enoughCommonSteps: true,
  hashesAgree: true,
};

/** Both pages' errors, and whether they report hashes for the same steps, and those agree. */
const outcome = async (host: Page, guest: Page, pageErrors: string[]) => {
  const [a, b] = await Promise.all([debug(host), debug(guest)]);
  const common = Object.keys(a.hashes).filter((step) => step in b.hashes);
  const failed = await Promise.all(
    [host, guest].map((page) => page.locator(".coop-error").count())
  );
  return {
    errors: [a.error, b.error],
    failed,
    pageErrors,
    enoughCommonSteps: common.length >= 3,
    hashesAgree: common.every((step) => a.hashes[step] === b.hashes[step]),
  };
};
