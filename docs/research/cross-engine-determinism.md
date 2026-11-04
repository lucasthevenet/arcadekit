# Cross-engine determinism of the survivors simulation

Research and a prototype for [#25](https://github.com/lucasthevenet/gamekit/issues/25) (lockstep co-op), with notes for [#28](https://github.com/lucasthevenet/gamekit/issues/28) (the step loop without a browser frame). Measured and read on 2026-11-04.

## Question

Lockstep needs every peer's run to stay identical, step by step, given the same seed and inputs. Survivors' replay test proves that within one engine. Does it hold across V8, SpiderMonkey and JavaScriptCore? #25 names the suspects in `packages/survivors/src/world.ts`: `Math.hypot` (9 uses), `Math.sin`/`Math.cos` (the spawn ring) and `**` (weapon cooldown scaling, line 233; XP curve, line 609).

## Answer in short

- **No, not today.** On one Linux machine, Node (V8), Bun (JavaScriptCore) and headless Chromium (a newer V8) give three different results for every long run we tried, starting 5–100 s of game time into the run.
- **The pinned replay hides it.** All three engines reproduce the pinned hash `1_294_328_663`, step for step. The `Math` calls do return different last bits during it, but writing the values into the pools' `Float32Array` fields and `Math.ceil` absorb them in that short scenario. Passing the replay test is not evidence of cross-engine determinism.
- **Two V8 versions disagree too.** Node 22 and Chromium 153 differ on `sin`, `cos` and `**`. Pinning "V8" is not enough.
- **Replacing four functions with exact operations fixes every tested case.** With `hypot`, `sin`, `cos` and `**` rebuilt from `+ - * /` and `Math.sqrt`, all three engines agree bit for bit on every step of every run, and the pinned replay hash stays `1_294_328_663`.

## Why: what the spec requires

- ECMA-262 makes `+ - * /` (Number::add, ::multiply, …), `Math.sqrt` and `Math.fround` exact: the IEEE 754-2019 result, rounded ties-to-even. Each operation rounds on its own, so an engine may not fuse `a*b+c` into an FMA. ([§6.1.6.1](https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-numeric-types-number), [§21.3.2.33](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-math.sqrt))
- `sin`, `cos`, `hypot`, `pow`/`**`, `exp`, `log`, `atan2` and the other transcendentals are "implementation-approximated": any accuracy is allowed. The spec only recommends fdlibm. `**` and `Math.pow` are the same operation (Number::exponentiate), and integer exponents get no exemption. ([§21.3.2 note](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-function-properties-of-the-math-object), [§4.2 implementation-approximated](https://tc39.es/ecma262/multipage/overview.html#implementation-approximated))

So code that uses only exact operations must give the same bits in every conforming engine. Code that calls an approximated function gets whatever that engine's library returns.

## What each engine calls (source reading, `main` branches)

| function | V8 (Chromium) | SpiderMonkey (Firefox) | JavaScriptCore (Safari) |
| --- | --- | --- | --- |
| `sin`, `cos` | LLVM libc ([`src/base/ieee754.cc`](https://github.com/v8/v8/blob/main/src/base/ieee754.cc)), which aims to be correctly rounded ([status](https://libc.llvm.org/headers/math/index.html)) | fdlibm, except **Windows, which uses the UCRT** (`use_fdlibm_for_sin_cos_tan` defaults to false there, [`StaticPrefList.yaml`](https://github.com/mozilla-firefox/firefox/blob/main/modules/libpref/init/StaticPrefList.yaml); [`Math.cpp`](https://github.com/mozilla-firefox/firefox/blob/main/js/src/builtin/Math.cpp)) | host libm: Apple libm on macOS/iOS, glibc on Linux ([`MathCommon.h`](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/runtime/MathCommon.h)) |
| `hypot` (2 args) | own code, `sqrt` of scaled squares, no libm ([`math.tq`](https://github.com/v8/v8/blob/main/src/builtins/math.tq)) | fdlibm | host `std::hypot` ([`MathObject.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/runtime/MathObject.cpp)) |
| `**` | `x*x` for 2, `sqrt` for 0.5, otherwise host `std::pow` (`use_std_math_pow` is true except on AIX; [`ieee754.cc`](https://github.com/v8/v8/blob/main/src/numbers/ieee754.cc), [`flag-definitions.h`](https://github.com/v8/v8/blob/main/src/flags/flag-definitions.h)) | small integer exponents by multiplication (`powi`), otherwise `std::pow` | integer exponents 0–1000 by repeated squaring, otherwise `std::pow` (`MathCommon.cpp`) |

Every function survivors calls has three different implementations, and some depend on the operating system's C library as well as the engine. One secondary post claims V8's `Math.pow` is now the same on every OS ([scrapfly.dev, 2026-07](https://scrapfly.dev/posts/browser-math-os-fingerprint/)); that conflicts with the source above and I couldn't check V8's commit history.

## Method

A scratch harness, kept out of the repo because it needs Bun and Playwright, which aren't workspace dependencies. Anyone can rebuild it from this description:

1. **Bundle.** `Bun.build` bundles a runner with `packages/survivors/src/world.ts`, `schema.ts`, `@gamekit/core` and `effect` into one DOM-free ES module (~200 KB). A second bundle rewrites the two `**` in `world.ts` into `globalThis.__pow(a, b)` so they can be logged.
2. **Runner.** Copies `replay.test.ts` verbatim (content, FNV-1a `hashWorld`, zig-zag script, "the second upgrade when offered", 1/60 s steps) and records the hash after every step.
3. **Long runs** (not repo scenarios): `runLength` 400, hero `maxHp` 1e9, 6 enemies/s for the whole run, 20,000 steps, seeds 1, 1234, 4321, 99 and 2026. Two input scripts: the zig-zag, and `wander`, which sets analog stick values from an integer hash every 30 steps. Each run: ~2,000 kills, level 18, 10–12M `hypot` calls.
4. **Engines.** The same bundle in Node, in Bun, and in Chromium through Playwright (`page.route` serves the files; no server, no network).
5. **Per-function check.** Wrappers record every input the simulation passes to `hypot`, `sin`, `cos` and `**` (all calls in the pinned replay; all trig and `**` calls and the first 2M `hypot` calls per long run), plus a 2M-input synthetic corpus per function. Each engine evaluates the same inputs; outputs are compared bit for bit and against exact BigInt references to see which are correctly rounded.
6. **Replacements.** The same runs with the four functions swapped for versions built from exact operations (see Options, 1).

The instrumented bundle gives the same hashes as the plain one in every engine, so the wrappers don't change behaviour. No other approximated function is called: `world.ts` otherwise uses only `floor`, `ceil`, `min`, `max` and `imul`.

## Results per engine

Platform: Linux x64 (Intel Xeon, AVX2/FMA), Ubuntu, glibc 2.39.

| label | engine | version |
| --- | --- | --- |
| node | V8 | Node 22.23.4, V8 12.4.254.21 |
| bun | JavaScriptCore | Bun 1.4.4 (WebKit d6375c72), linked against the system glibc libm |
| chromium | V8 | HeadlessChrome 153.0.8010.12 (Playwright 1.63.0) |

**Pinned replay** (seed 1234, 3600 steps): `1294328663` in all three, identical at every step. Two 600-step runs (seeds 1234, 4321) also match.

**Long runs:** all 10 end with three different hashes. First step whose hash differs:

| run                 | node vs bun | node vs chromium | bun vs chromium |
| ------------------- | ----------- | ---------------- | --------------- |
| zigzag 1            | 3112        | 5810             | 3112            |
| zigzag 1234         | 2356        | 4850             | 2356            |
| zigzag 4321         | 5811        | 1147             | 1147            |
| zigzag 99           | 5993        | 1325             | 1325            |
| zigzag 2026         | 3666        | 975              | 975             |
| wander, all 5 seeds | 330         | 1892–5643        | 330             |

With an analog stick, JavaScriptCore and V8 split at step 330 (5.5 s) every time.

## Results per `Math` function

Share of calls in the observed corpus whose output differs between engines:

| function | calls | node vs bun | node vs chromium | bun vs chromium |
| --- | --- | --- | --- | --- |
| `hypot` | 20.3M | 30.9% (≤ 2 ulp) | 0 | 30.9% |
| `sin` | 20,229 | 3.1% (1 ulp) | 3.1% | 0.11% |
| `cos` | 20,229 | 3.5% (1 ulp) | 3.6% | 0.16% |
| `**` | 17,393 (27 distinct) | 35% (≤ 2 ulp) | 46% (1 ulp) | 81% |

The synthetic corpus shows the same pattern; for `**` with large integer exponents, Node and Bun differ by up to 154 ulp.

Results that are **not** correctly rounded:

| function | node | bun | chromium |
| --- | --- | --- | --- |
| `hypot` (200k unbiased inputs) | ~30–35% | ~0.5% | ~30–35% |
| `sin` (observed) | 505 / 15,778 | 19 / 15,778 | 0 |
| `cos` (observed) | 561 / 15,778 | 26 / 15,778 | 0 |
| `**`, integer exponents (synthetic) | 98k / 1M | 941k / 1M | 1,330 / 1M |

Examples: Bun gives `1.3 ** 3 = 2.1970000000000005` (correct: 2.197); Node gives `0.9 ** 4 = 0.6561000000000001` (correct: 0.6561).

These fit the source reading: Chromium's `sin`/`cos` are correctly rounded (LLVM libc), Node 22's older V8 isn't, V8's `hypot` is its own code in both versions, and Bun's `**` error grows with the exponent, as repeated squaring would.

Each engine gave the same outputs on a cold and a warmed-up pass.

## Still unknown

- **SpiderMonkey:** not installed; nothing measured. Source reading says fdlibm (UCRT for trig on Windows).
- **Safari on macOS/iOS:** JavaScriptCore there uses Apple's libm, not glibc. Bun on Linux is not a stand-in.
- **ARM, Windows, other CPUs:** not tested.
- **JIT tiers:** JavaScriptCore's DFG/FTL lowering of `**` wasn't read; within each tested engine cold and warm passes agreed.
- **The replacements on SpiderMonkey and Safari:** they use only exact operations, so the spec says they must agree, but that is unmeasured.
- **Browser updates:** V8 has switched math libraries between releases (Node 22 vs Chromium 153 above). Two peers on different Chrome versions can desync while the simulation calls approximated functions.

## Options

1. **Use only exact operations in a step** (what the prototype did).
   - `Math.hypot(a, b)` → `Math.sqrt(a*a + b*b)`. Deterministic but not correctly rounded (differs from the exact value on ~10% of inputs), and it can overflow at magnitudes the arena never reaches.
   - `sin`/`cos` → fdlibm's kernel polynomials with Cody-Waite range reduction by π/2 (~20 lines). Or a table of literal doubles indexed by `floor(rng * N)`, which is faster but changes which angles a spawn can take.
   - `**` with an integer exponent → square-and-multiply. Or a per-level table computed when the run is created.
   - Cost: a few lines, a little speed, and a lint rule banning `Math.hypot`/`sin`/`cos`/`pow` and `**` in genre root entries' simulation. The measured set keeps `1_294_328_663`; a lookup table would likely change it.
   - Covers platforms we can't test, because it no longer depends on any engine's library.
2. **Port a whole libm to JavaScript** (fdlibm, or a correctly rounded one such as LLVM libc). Deterministic for the same reason, and covers future uses of `exp`, `atan2` and the rest. More code and slower; more than survivors needs today.
3. **Round results to float32 with `Math.fround`** ([Rune](https://developers.rune.ai/blog/making-js-deterministic-for-fun-and-glory) does this). Makes a mismatch rarer, not impossible: two doubles either side of a float32 rounding midpoint still round apart. The pinned replay already shows this effect.
4. **Fixed-point integers** (`Math.imul`, shifts). Fully deterministic, but a rewrite of the simulation.
5. **WebAssembly simulation.** Float operations are deterministic except NaN bit patterns and relaxed SIMD ([WebAssembly design](https://github.com/WebAssembly/design/blob/main/Nondeterminism.md)), and the libm ships inside the module. A language and toolchain change.
6. **Don't guarantee determinism; correct it.** The host sends authoritative state, as [NetplayJS](https://github.com/rameshvarun/netplayjs) does by default. Needs state serialization, which [ADR-0007](../adr/0007-no-runtime-snapshots.md) doesn't provide.

## Recommendation

**For #25's determinism decision:** take option 1. Replace the four functions in `world.ts` with exact-operation versions in one change, and add a lint rule so new approximated calls can't creep into a step. It is the only option measured here that made all three engines agree, it is small, it keeps the pinned replay hash, and it removes the dependency on platforms CI can't run (Safari's libm, Firefox on Windows). Keep the desync check of #25's decision 3 regardless: this research shows agreement on tested platforms, not a proof.

For the cross-browser test #25 asks for:

- Use a long run with analog input and per-step hashes, not only the pinned replay, which passes even while engines disagree.
- Run Chromium, Firefox and WebKit through Playwright (CI needs those browsers installed). Linux WebKit uses glibc, so a passing test on Linux CI says nothing about Safari unless the simulation calls no approximated function, which option 1 ensures.

**For #28:** the harness already ran survivors' simulation as one DOM-free bundle in Node, Bun and Chromium, which confirms the root entry needs no browser. Once #28 gives a DOM-free step loop, build the cross-engine check on it rather than on a copy of the replay loop, so engines run the same step order the demos do (`endStep`, `endFrame` and samples included). Option 1 doesn't conflict with #28's constraint that the replay keeps `1_294_328_663`: the measured replacements leave it unchanged. Land them in their own PR anyway, so a hash change can be traced to one cause.

## What landed

Option 1, as recommended, in its own change with [ADR-0011](../adr/0011-a-step-uses-only-exact-math.md):

- `packages/survivors/src/math.ts` has `hypot2`, `sin`, `cos` and `powInt`, the measured replacements. One fix: the prototype's cosine coefficient `C2` had a transcription error (`-1.38888888887411252e-3` for fdlibm's `-1.38888888888741095749e-3`), which put `cos` up to ~30 ulp off near π/4. It was just as deterministic, which is why all engines still agreed. With fdlibm's value, `sin` and `cos` are within 2^-52 of `Math` for |x| ≤ 1000. Both versions keep `1_294_328_663`.
- `world.ts` calls them; the pinned replay hash is unchanged.
- `oxlint.config.ts` forbids every implementation-approximated `Math` function (`hypot`, `sin`, `cos`, `pow`, `exp`, `log`, `atan2` and the rest) and `**` in both genres' simulation code.
- `packages/survivors/src/determinism.test.ts` runs this document's long scenario (`runLength` 400, unkillable hero, 6 enemies/s, the `wander` stick) through `GameLoop` for seeds 1, 1234 and 2026, 20,000 steps each (~1 s per seed in Node), and pins each run's final hash and a per-step trace. Its hashes differ from this harness's: it steps through `GameLoop` and uses the corrected `C2`.

Then the cross-browser test (#25's decision 8):

- `long-run.ts` in `packages/survivors/src` now holds the long scenario, its seeds and its recorded hashes; `determinism.test.ts` plays it in Node.
- `pnpm test:browsers` (`packages/survivors/browser-determinism/`) bundles that module with survivors' simulation and `GameLoop` using Vite, serves it to Chromium, Firefox and WebKit with Playwright's `route` (no server, no network), plays the three seeds for 20,000 steps in each, and compares each run's final hash and its trace after every step with Node's. A mismatch names the first step whose state differs. Playwright 1.63.0 is now a root dev dependency, so CI can install matching browsers.
- Chromium 153 gives Node's hashes at every step of every seed (about 1.5 s per seed). A browser-only 1-ulp change to `Math.sqrt` after 2M calls is caught and located (first diverging step 240 to 7,920, depending on the seed).
- `.github/workflows/cross-browser.yml` runs it on pull requests and on `main` with all three browsers installed, and fails if one can't launch. Until it runs, Firefox (SpiderMonkey) and WebKit (JavaScriptCore) are still unmeasured here; Safari on macOS, Windows and ARM still aren't run at all.

## Sources

- ECMA-262 (ES2027 draft): [Math function properties](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-function-properties-of-the-math-object), [implementation-approximated](https://tc39.es/ecma262/multipage/overview.html#implementation-approximated)
- V8: [`src/base/ieee754.cc`](https://github.com/v8/v8/blob/main/src/base/ieee754.cc), [`src/numbers/ieee754.cc`](https://github.com/v8/v8/blob/main/src/numbers/ieee754.cc), [`src/builtins/math.tq`](https://github.com/v8/v8/blob/main/src/builtins/math.tq), [`flag-definitions.h`](https://github.com/v8/v8/blob/main/src/flags/flag-definitions.h); [LLVM libc math status](https://libc.llvm.org/headers/math/index.html)
- SpiderMonkey: [`js/src/builtin/Math.cpp`](https://github.com/mozilla-firefox/firefox/blob/main/js/src/builtin/Math.cpp), [`StaticPrefList.yaml`](https://github.com/mozilla-firefox/firefox/blob/main/modules/libpref/init/StaticPrefList.yaml), [bug 933257](https://bugzilla.mozilla.org/show_bug.cgi?id=933257), [2021 intent thread](https://groups.google.com/a/mozilla.org/g/dev-platform/c/0dxAO-JsoXI/m/eEhjM9VsAgAJ), [2023 intent to ship](https://groups.google.com/a/mozilla.org/g/dev-platform/c/wBpkmbmyzqw)
- JavaScriptCore: [`runtime/MathObject.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/runtime/MathObject.cpp), [`runtime/MathCommon.h`](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/runtime/MathCommon.h), `runtime/MathCommon.cpp`
- Prior art: [Rune, "Making JS deterministic"](https://developers.rune.ai/blog/making-js-deterministic-for-fun-and-glory), [NetplayJS](https://github.com/rameshvarun/netplayjs), [WebAssembly nondeterminism](https://github.com/WebAssembly/design/blob/main/Nondeterminism.md), [Gaffer On Games, "Floating Point Determinism"](https://gafferongames.com/post/floating_point_determinism/)
- Secondary: [scrapfly.dev, browser Math fingerprinting](https://scrapfly.dev/posts/browser-math-os-fingerprint/) (2026-07)

WebRTC transport, signalling and TURN costs (#25's decision 4) are out of scope here.
