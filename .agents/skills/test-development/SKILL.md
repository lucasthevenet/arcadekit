---
name: test-development
description: How arcadekit is tested, and how a change is shown to work. Use when adding or changing a test of `packages/arcadekit` or `packages/three`, or when a change to either has to be run and shown to work.
---

A change is not done until it has been run and shown to work. Reasoning that it should work is not that.

## Workflow

1. Say what the change is to do, as what a game would see of it: that is what is tested, through the public API.
2. Select every branch the test touches, and read its file before writing. Read no branch it does not touch:
   - a test that needs something from outside the game, which a stand-in gives it (assets, the devices, a page, what draws, sound, a UI, a frame loop): [stand-ins.md](stand-ins.md), which sends its reader to the site's guide to testing;
   - a test of several peers, of what speaks to another machine, or of what a platform forbids: [peers.md](peers.md).
3. Write the test in the file that already tests the module, `test/<name>.test.ts`, as "Writing a test" says. A test is code of the repository: what the `arcadekit-development` skill says of the code under test holds for its test.
4. See it fail. Break the code the test covers, or take the fix out, and see it go red.
5. Show that the change works, as below, and run the checks that `AGENTS.md` lists for it.

The task is complete when each thing the change is to do has a test that was seen to fail without it, the change has been run as a user of it would run it, and the checks pass or are reported as not run.

## Showing that a change works

- **Run it.** The tests, then whatever a user of it would run: `pnpm --filter arcadekit demo` and `duel`, the pages with `pnpm --filter arcadekit page` and `pnpm --filter @arcadekit/three page` (Chromium and Playwright are installed in a cloud session), and the relay, `pnpm --filter arcadekit relay`, with `pnpm --filter arcadekit relay:check <address>`. Use these, and the drivers the tests already have (`Input.makeManualSource`, `Driver.makeManualDisplay`, `View.makeBridge`, `Sound.makeRecorder`, `Transport.makeHub`), before writing a script of your own.
- **The simulation's evidence is its hash.** A change to what a tick does is checked by running two apps of the same game side by side and comparing `world.hash()` after every tick, by replaying the log with `App.replay`, and, for peers, by the shuffled, late network of `test/Peers.ts`.
- **The repository's property tests are random operations against a model that is obviously right**, with a seeded generator so that a failure repeats, as `test/Storage.test.ts` and `test/Restore.test.ts` are. A change to the storage core, a query, the hash, a snapshot, a rewind or a session adds to one or extends one.
- **Every bug that is fixed comes with a test that fails without the fix.** Break the code a new test covers and see it go red. Several bugs in this package were found only because a deliberate break went unnoticed.
- **A test waits for what it expects, with a limit, and never for a fixed time.** A frame loop is turned by hand.
- **The examples and the benchmarks are type-checked and not published.** `packages/arcadekit/examples/` and `bench/` are compiled by `tsconfig.examples.json`. The relay's example on Cloudflare, `examples/relay-cloudflare/`, is declared with Alchemy, a beta and a dev dependency for that alone, and run on this machine with `pnpm --filter arcadekit relay:cloudflare`. The page's UI is built twice, with the DOM and with React, a dev dependency for that alone; `test/Page.test.ts` mounts both in a document and plays the game through them. `pnpm --filter arcadekit bench:parallel` measures loops shared between workers, and is no part of the package.

## Writing a test

- **A test name is a sentence** about the thing under test: `it("are dropped a tick after they were emitted, read or not")` inside `describe("events")`.
- **Test through the public API**, the way a game would use it. Build an app, tick it, look at the world.
- **Compare against something obviously right.** The storage tests run thousands of random operations against a `Map` and compare; a new data structure gets the same.
- **A type error is tested with `// @ts-expect-error` on the line directly above the expression that errors.** The formatter moves expressions, so put the comment inside the call, above the argument.
- **Compare a failure whole**: `expect(error).toEqual(new Assets.AssetFailed({ url, message }))`. To `toEqual` alone, two tagged errors that differ only in their `message` are equal, since it is the one field of an error that is not an enumerable property; `tooling/build/vitest-setup.ts`, which `pnpm test` runs before every test file, compares it. A test in `test/Assets.test.ts` fails if that is ever lost.
- **A test that is itself an Effect** can use `it.effect` from `@effect/vitest`; see Effect's [testing example](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/09_testing/10_effect-tests.ts). It is not installed yet. Do not use `TestClock` for game time: game time is `Time`, and a test advances it by ticking.
- **Name things as the site's concepts and guides name them.** They are the map of what a game author sees.
