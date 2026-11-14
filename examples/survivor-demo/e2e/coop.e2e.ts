// oxlint-disable eslint/no-await-in-loop -- the test plays a script in time order, one step after another.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Co-op end to end (#25): the demo under `alchemy dev` (Vite's dev server, with the Worker that
// serves the signalling routes and its Durable Objects in workerd), and two Chromium pages, each
// its own player. The host hosts, the guest joins with the code the host's
// page shows, each picks a hero, the host starts, and both play pressing different keys until
// each has picked an upgrade: a pick is a command that crosses to the other page, and the run
// plays on only once both pages have both picks. Then each page in turn holds the co-op pause,
// another command: the other page says who paused, and the run's clock stands on both while
// they keep stepping. Both pages must then report the same state hash at the same steps, and no
// error.
//
// A single-player run is checked too, to show it still runs on the single-player engine.
//
// Then a hidden guest: the guest plays from a Chromium of its own, in a tab that a second tab then
// covers, so the browser really hides it and throttles its main-thread timers to about once a
// second, as a background tab on a desktop. (Playwright keeps its own pages visible, and
// dispatching `visibilitychange` would throttle nothing.) The run must keep stepping at full rate
// for longer than the host's 10 s drop-out, with no one removed and the hashes agreeing.
//
// Run it with `pnpm test:e2e`. It isn't part of `pnpm test`: it needs Chromium and workerd, and
// takes about a minute. It skips itself when Playwright or Chromium is missing, or when
// `alchemy dev` doesn't come up (workerd not installed: see the demo's README).

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
  /** The run's clock in seconds: it stands while the run is frozen, though the steps go on. */
  readonly time: number | null;
}

const debug = (page: Page) =>
  page.evaluate<Debug>("globalThis.arcadekitCoop.debug()");

const demoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * A Chromium of its own, started as a person's would be, without Playwright's flags that keep
 * a background tab's timers at full rate, and attached with no default overrides (Playwright's
 * focus emulation would keep its pages visible). `hide` opens a second tab in front of the page.
 */
const startDesktopChromium = async (pw: Playwright) => {
  const profile = mkdtempSync(path.join(tmpdir(), "arcadekit-e2e-"));
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
  const endpoint = await waitForOutput(
    child,
    [child.stderr!],
    /DevTools listening on (?<url>ws:\/\/\S+)/u,
    30_000
  );
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

/**
 * The demo under `alchemy dev`, in a stage of its own so it doesn't touch a developer's. Resolves
 * with the site's URL once the Worker is ready; rejects with Alchemy's output if it isn't.
 */
const startAlchemyDev = async () => {
  const child = spawn(
    "pnpm",
    ["exec", "alchemy", "dev", "--no-input", "--stage", "e2e"],
    {
      cwd: demoRoot,
      // Vite passes VITE_* variables on to the app. No STUN: both players are on this machine,
      // and a sandbox may have no route out.
      env: { ...process.env, VITE_STUN_URLS: "" },
      // Its own process group, so closing it stops the sidecar, Vite and workerd too.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const exited = once(child, "exit");
  const close = async () => {
    if (
      child.pid !== undefined &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      process.kill(-child.pid!, "SIGTERM");
      await exited;
    }
  };
  try {
    const url = await waitForOutput(
      child,
      [child.stdout, child.stderr],
      /\[Website\] ready at (?<url>http:\/\/\S+)/u,
      90_000,
      // `alchemy dev` reports a failed run and waits for a file change instead of exiting.
      /ERROR/u
    );
    return { url, close };
  } catch (error) {
    await close();
    throw error;
  }
};

/**
 * Reads a child process's output until `pattern` matches it, and returns the match's `url`
 * group. Fails with the output if `fails` matches first, the process exits or `timeoutMs`
 * passes. The streams keep flowing after, so a full pipe never blocks the process.
 */
const waitForOutput = async (
  child: ChildProcess,
  streams: readonly Readable[],
  pattern: RegExp,
  timeoutMs: number,
  fails?: RegExp
): Promise<string> => {
  let output = "";
  const done = new AbortController();
  const onData = (chunk: Buffer) => {
    output += String(chunk);
    if (pattern.test(output) || fails?.test(output) === true) {
      done.abort();
    }
  };
  for (const stream of streams) {
    stream.on("data", onData);
  }
  child.once("exit", () => done.abort());
  child.once("error", (error) => {
    output += String(error);
    done.abort();
  });
  const signal = AbortSignal.any([done.signal, AbortSignal.timeout(timeoutMs)]);
  if (!signal.aborted) {
    await once(signal, "abort");
  }
  const url = pattern.exec(output)?.groups?.url;
  if (url === undefined) {
    throw new Error(
      `${child.spawnargs.join(" ")} didn't start:\n${output.slice(-2000)}`
    );
  }
  return url;
};

let browser: Browser | undefined;
let dev: Awaited<ReturnType<typeof startAlchemyDev>> | undefined;
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
    try {
      dev = await startAlchemyDev();
    } catch (error) {
      skipReason = String(error);
    }
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await dev?.close();
  });

  it("still plays single-player on the single-player engine", async ({
    skip,
  }) => {
    if (
      skipReason !== undefined ||
      browser === undefined ||
      dev === undefined
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
    await page.goto(dev.url);
    await page.click("button:has-text('Start run')");
    await page.waitForSelector("text=Esc to pause", { timeout: 15_000 });
    await page.keyboard.down("Escape");
    await page.keyboard.up("Escape");
    await page.waitForSelector("text=Resume");
    expect([
      errors,
      await page.evaluate("globalThis.arcadekitCoop.debug().stepIndex"),
    ]).toStrictEqual([[], 0]);
  });

  it("hosts, joins and plays the same run on both pages", async ({ skip }) => {
    if (
      skipReason !== undefined ||
      browser === undefined ||
      dev === undefined
    ) {
      skip(skipReason);
      return;
    }
    const errors: string[] = [];
    const host = await openPage(browser, errors);
    const guest = await openPage(browser, errors);
    const pages = [host, guest];
    await startRun(host, guest, dev.url);

    // Different inputs on each page, taking every upgrade offered, for a few seconds and then
    // until each page has picked one. The team levels up together, so both are offered at once.
    const legs: [string, string][] = [
      ["ArrowRight", "ArrowLeft"],
      ["ArrowUp", "ArrowDown"],
      ["ArrowLeft", "ArrowUp"],
      ["ArrowDown", "ArrowRight"],
    ];
    const picks = [0, 0];
    const giveUpAt = performance.now() + 60_000;
    for (
      let leg = 0;
      leg < 3 || (picks.includes(0) && performance.now() < giveUpAt);
      leg++
    ) {
      const [hostKey, guestKey] = legs[leg % legs.length]!;
      await host.keyboard.down(hostKey);
      await guest.keyboard.down(guestKey);
      for (let i = 0; i < 4; i++) {
        await sleep(400);
        const taken = await takeOffers(pages);
        picks[0]! += taken[0]!;
        picks[1]! += taken[1]!;
      }
      await host.keyboard.up(hostKey);
      await guest.keyboard.up(guestKey);
    }
    // A pick that didn't reach the other page would leave its run waiting for it.
    const playedOn = await runsOn(pages);
    expect({
      picked: picks.map((count) => count > 0),
      playedOn,
    }).toStrictEqual({ picked: [true, true], playedOn: true });

    // The co-op pause, held by each page in turn.
    const pauses = [
      await pauseHeldBy(host, guest, "Host"),
      await pauseHeldBy(guest, host, "Guest 1"),
    ];
    expect(pauses).toStrictEqual([HELD_AND_LET_GO, HELD_AND_LET_GO]);

    await host.waitForFunction(
      "globalThis.arcadekitCoop.debug().stepIndex > 300",
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
      dev === undefined
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
      await startRun(host, guest, dev.url);

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
        "globalThis.arcadekitCoop.debug().stepIndex > 60",
        undefined,
        { timeout: 15_000 }
      )
    )
  );
};

const has = async (page: Page, selector: string) =>
  (await page.locator(selector).count()) > 0;

/**
 * Takes the first choice of every upgrade offer open on these pages. Returns how many it took
 * on each.
 */
const takeOffers = async (pages: readonly Page[]) => {
  const taken: number[] = [];
  for (const page of pages) {
    const offered = await has(page, ".choice");
    if (offered) {
      await page.locator(".choice").first().click();
    }
    taken.push(offered ? 1 : 0);
  }
  return taken;
};

/**
 * Waits until `seen` holds, taking every upgrade offered on `pages` meanwhile: an open offer
 * freezes the run and covers the playing screen. False if it didn't hold in time.
 */
const eventually = async (
  pages: readonly Page[],
  seen: () => Promise<boolean>,
  timeoutMs = 10_000
) => {
  const giveUpAt = performance.now() + timeoutMs;
  while (performance.now() < giveUpAt) {
    if (await seen()) {
      return true;
    }
    await takeOffers(pages);
    await sleep(100);
  }
  return false;
};

/** Each page's run, read `overMs` apart: its clock and its step index. */
const readTwice = async (pages: readonly Page[], overMs: number) => {
  const before = await Promise.all(pages.map(debug));
  await sleep(overMs);
  const after = await Promise.all(pages.map(debug));
  return { before, after };
};

/** Whether the run's clock moves on every page, once no offer holds it. */
const runsOn = (pages: readonly Page[]) =>
  eventually(pages, async () => {
    const { before, after } = await readTwice(pages, 300);
    return after.every((now, at) => (now.time ?? 0) > (before[at]!.time ?? 0));
  });

const PAUSED = "text=The run is paused for everyone until you resume.";

/** What the test expects of `pauseHeldBy`. */
const HELD_AND_LET_GO = {
  holderSaysPaused: true,
  otherSaysWho: true,
  clockStands: true,
  stepsGoOn: true,
  playsOnAfter: true,
};

/**
 * `holder` holds the co-op pause with Escape and lets go with Resume. The pause is a command
 * that crosses to `other`: its page says who paused, and the run's clock stands at one time on
 * both pages while both keep stepping.
 */
const pauseHeldBy = async (holder: Page, other: Page, name: string) => {
  const pages = [holder, other];
  // Escape opens the menu on the playing screen only. One pressed under an offer that has just
  // opened does nothing, so it is pressed again once the offer is taken.
  let holderSaysPaused = false;
  for (let press = 0; press < 3 && !holderSaysPaused; press++) {
    await holder.keyboard.down("Escape");
    await holder.keyboard.up("Escape");
    holderSaysPaused = await eventually(pages, () => has(holder, PAUSED), 3000);
  }
  const otherSaysWho = await eventually(pages, () =>
    has(other, `text=Paused by ${name}`)
  );
  // Each page takes the pause at the same step, a moment apart: wait for one standing clock.
  const standing = async (overMs: number) => {
    const { before, after } = await readTwice(pages, overMs);
    return {
      stands:
        after.every((now, at) => now.time === before[at]!.time) &&
        after[0]!.time === after[1]!.time,
      stepsGoOn: after.every(
        (now, at) => now.stepIndex > before[at]!.stepIndex
      ),
    };
  };
  await eventually(pages, async () => {
    const { stands } = await standing(300);
    return stands;
  });
  const { stands: clockStands, stepsGoOn } = await standing(1000);
  if (await has(holder, "button:has-text('Resume')")) {
    await holder.click("button:has-text('Resume')");
  }
  const playsOnAfter = await runsOn(pages);
  return {
    holderSaysPaused,
    otherSaysWho,
    clockStands,
    stepsGoOn,
    playsOnAfter,
  };
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
