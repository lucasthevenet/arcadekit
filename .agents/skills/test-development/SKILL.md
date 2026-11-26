---
name: test-development
description: How arcadekit is tested, and how a change is shown to work. Use when adding or changing a test of `packages/arcadekit` or `packages/three`, or when a change to either has to be run and shown to work.
---

## Workflow

1. Say what the change is to do, as what a game would see of it, and test that through the public API as a game would: build an app, tick it, look at the world. pstack's [`principle-test-behavior-not-implementation`](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-test-behavior-not-implementation/SKILL.md) skill says what such a test asserts.
2. Select every branch the test touches, and read its file before writing. Read no branch it does not touch:
   - a test that needs something from outside the game, which a stand-in gives it (assets, the devices, a page, what draws, sound, a UI, a frame loop): [stand-ins.md](stand-ins.md), which sends its reader to the site's guide to testing;
   - a test of several peers, of what speaks to another machine, or of what a platform forbids: [peers.md](peers.md).
3. Write the test in the file that already tests the module, `test/<name>.test.ts`, as "Writing a test" says. A test is code of the repository: what the `arcadekit-development` skill says of the code under test holds for its test.
4. See it fail. Break the code the test covers, or take the fix out, and see it go red.
5. Show that the change works, as below, and run the checks that `AGENTS.md` lists for it.

The task is complete when each thing the change is to do has a test that was seen to fail without it, the change has been run as a user of it would run it, and the checks pass or are reported as not run.

## Showing that a change works

- **Run it.** The tests, then whatever a user of it would run: each example of `examples/` with `pnpm --filter @arcadekit/example-<folder> start`: `demo` and `duel`, the pages `page` and `three` (Chromium and Playwright are installed in a cloud session), and the relay, `relay`, with `pnpm --filter @arcadekit/example-relay check <address>`. Use these, and the drivers the tests already have (`Test.make`, which gives a game its stand-ins, and `Driver.makeManualDisplay`, `Transport.makeHub` and `Three.makeRecorder`), before writing a script of your own.
- **The simulation's evidence is its hash.** A change to what a tick does is checked by running two apps of the same game side by side and comparing `world.hash()` after every tick, by replaying the log with `Replay.verify`, and, for peers, by the shuffled, late network of `test/peers.ts`.
- **The repository's property tests are random operations against a model that is obviously right**, such as a `Map`, with a seeded generator so that a failure repeats, as `test/Storage.test.ts` and `test/Restore.test.ts` are. A new data structure, or a change to the storage core, a query, the hash, a snapshot, a rewind or a session, adds to one or extends one.
- **A test waits for what it expects, with a limit, and never for a fixed time.** A frame loop is turned by hand.
- **The examples and the benchmarks are type-checked and not published.** A package's `bench/` is compiled by its own `tsconfig.json`, which the type-aware lint finds beside it, and so is each example of `examples/`, a private workspace package with its own dependencies. The relay's example on Cloudflare, `examples/relay-cloudflare/`, is declared with Alchemy, a beta, and run on this machine with `pnpm --filter @arcadekit/example-relay-cloudflare start`. The page's UI is built twice, with the DOM and with React; `examples/page/src/page.test.ts` mounts both in a document and plays the game through them. `pnpm --filter arcadekit bench:parallel` measures loops shared between workers, and is no part of the package.

## Writing a test

- **A test name is a sentence** about the thing under test: `it("are dropped a tick after they were emitted, read or not")` inside `describe("events")`.
- **A type error is tested with `// @ts-expect-error` on the line directly above the expression that errors.** The formatter moves expressions, so put the comment inside the call, above the argument.
- **Compare a failure whole**: `expect(error).toEqual(new Assets.Failed({ url, message }))`. To `toEqual` alone, two tagged errors that differ only in their `message` are equal, since it is the one field of an error that is not an enumerable property; `tooling/build/vitest-setup.ts`, which `pnpm test` runs before every test file, compares it. A test in `test/Assets.test.ts` fails if that is ever lost.
- **A test that runs an Effect is an Effect**: `it.effect` from `@effect/vitest`, its body an `Effect.gen` that yields each effect, as Effect's [testing example](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/09_testing/10_effect-tests.ts) does. `it.effect` gives it `TestClock`; a test that waits in real time, on a socket or a timer of the page, is `it.live`. What an effect fails or dies with is checked with `toThrow` through `thrown` of `test/checks.ts`. Do not use `TestClock` for game time: game time is `Time`, and a test advances it by ticking.
- **Name things as the site's concepts and guides name them.** They are the map of what a game author sees.
