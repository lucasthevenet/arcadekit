---
status: accepted
---

# A step uses only exact arithmetic

Lockstep (#25) needs every peer's run to stay identical, step by step, on whatever engine each peer's browser runs. ECMA-262 defines `+ - * /`, `Math.sqrt`, `Math.round`, `Math.floor`, `Math.fround` and `Math.imul` exactly: the IEEE 754 result, rounded once, never fused. It lets each engine approximate `Math.hypot`, `sin`, `cos`, `tan`, `atan2`, `exp`, `log`, `Math.pow` and `**` however it likes. [The research](../research/cross-engine-determinism.md) measured survivors in Node (V8), Bun (JavaScriptCore) and Chromium 153 (a newer V8). Every 20,000-step run ended with three different hashes, splitting as early as step 330 under analog input. The pinned 3,600-step replay still matched in all three, because the pools' `Float32Array` fields and `Math.ceil` absorbed the last-bit differences in that short scenario.

So a genre's simulation (its root entry, not `./browser`) calls no implementation-approximated `Math` function and uses no `**`.

- `packages/survivors/src/math.ts` holds survivors' replacements, built only from exact operations:
  - `hypot2(x, y)`: `Math.sqrt(x * x + y * y)`.
  - `sin`, `cos`: fdlibm's kernel polynomials after a two-term Cody-Waite reduction by π/2. Within 2^-52 of `Math` for |x| ≤ 1000; accuracy falls off past |x| ≈ 1.6e6.
  - `powInt(base, n)`: square-and-multiply for an integer exponent. Exact where every product is representable; it throws for a non-integer exponent.
- `world.ts` calls them in place of `Math.hypot`, `Math.sin`, `Math.cos` and `**`.
- They live in the genre, not in `@gamekit/core`: only survivors needs them ([ADR-0001](0001-kit-changes-need-two-genres.md)). Push-puzzle's step calls none of the approximated functions.
- `oxlint.config.ts` forbids every implementation-approximated `Math` function (`hypot`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, the hyperbolic ones, `cbrt`, `pow`, `exp`, `expm1`, `log`, `log1p`, `log2`, `log10`; `eslint/no-restricted-properties`) and `**`/`**=` (a local JS plugin, `lint/deterministic-math.ts`, since oxlint has no `no-restricted-syntax`) in `packages/survivors/src` and `packages/push-puzzle/src`, excluding `browser/**` and tests. Views may keep using them: what they draw doesn't feed back into a step.

## Considered Options

From the research's options:

- **Exact operations only** (chosen). A few dozen lines, and the measured set made all three engines agree on every step of every run. It doesn't depend on any engine's or operating system's library, so it covers platforms CI can't run (Safari's libm, Firefox on Windows).
- **A table of sines indexed by `floor(rng * N)`, or a per-level table of powers.** Faster, but changes which angles a spawn can take and would likely move the pinned replay hash.
- **Port a whole libm** (fdlibm, or a correctly rounded one). Also deterministic, and covers future `exp` or `atan2`, but more code than survivors needs today. If a genre needs another function, port that one into its `math.ts`.
- **Round results with `Math.fround`.** Makes a mismatch rarer, not impossible: two doubles either side of a float32 rounding midpoint still round apart. The pinned replay already showed this.
- **Fixed-point integers.** Fully deterministic, but a rewrite of the simulation.
- **A WebAssembly simulation.** Deterministic floats with its own libm, but a language and toolchain change.
- **Correct desyncs from the host's state instead.** Needs state serialization, which [ADR-0007](0007-no-runtime-snapshots.md) doesn't provide.

## Consequences

- **The pinned replay hash is unchanged: `1_294_328_663`.** No re-record was needed.
- **The replacements are slightly less accurate than `Math`.** `hypot2` rounds twice and misses the correctly rounded length on about one input in ten. `powInt` can be a few ulp off, for example `0.9 ** 4` gives `0.6561000000000001`. Nothing in survivors needs more.
- **A long-run test pins the arithmetic.** `packages/survivors/src/determinism.test.ts` plays three seeds for 20,000 steps through `GameLoop` under analog input and pins each run's final hash and a trace of every step's state. A change to the simulation's arithmetic fails it, even when the short replay still passes. Swapping `hypot2` back to `Math.hypot` fails all three seeds. Spawn positions are stored as float32, so a tiny change to `sin` or `cos` can pass it; `math.test.ts` pins their bits.
- **A genre that needs another function writes an exact version.** The lint rule's message points here. A new genre package must be added to the rule's `files`.
- **A cross-browser test checks it.** `pnpm test:browsers` (`packages/survivors/browser-determinism/`) plays the same long runs, from the same module (`src/long-run.ts`), in Chromium, Firefox and WebKit through Playwright, and every browser must give Node's recorded hashes at every step; once `.github/workflows/cross-browser.yml` is added, CI runs it with the three browsers installed. Linux WebKit uses glibc, so it doesn't stand in for Safari's libm, but with no approximated call left in the step, it doesn't need to. Windows and macOS aren't run. #25's desync check (hash every N steps) stays regardless.
