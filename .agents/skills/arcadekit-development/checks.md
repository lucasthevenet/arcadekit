# Rules and the checks that hold them

A rule that matters is held by something that runs. Prose is for what no check holds yet, and a sentence that a check has made true is taken out.

The repository already works this way, and a new rule joins these:

- `test/entries.test.ts`, `packages/three/test/entries.test.ts` and `scripts/lint-entries.mjs` hold each entry to what it may import;
- `test/policy.test.ts` plays a game where making code from text is forbidden;
- the lists of writers in `test/transaction.test.ts`, `test/changes.test.ts`, `test/access.test.ts` and `test/frame.test.ts`, which every new way to write joins;
- the world's guard, which refuses what a system did not say with `System.access`;
- a frozen world, which refuses a change from the frame and input stages;
- `Lockstep.Drifted`, which stops peers whose worlds have come apart;
- `bench:compare`, which fails on a storage core that got slower;
- the site's typecheck, which compiles the code of every page, and its build, which fails on a dead link.

Which kind of check a rule gets:

| The rule is about | The check is |
| --- | --- |
| What a caller may write | A type, with a type test: `// @ts-expect-error` above the line that must not compile |
| What code may do as it runs | A refusal there, thrown or `Effect.die`, whose message says who, what, and what to do instead |
| What a file may import or contain | A test that reads the sources, as `test/entries.test.ts` does |
| What every member of a kind must do (every writer, every way into the world) | A test with a list of them that a new one is added to |
| What must stay fast | A variant of the benchmark, which `bench:compare` holds |
| What two runs must agree on | A comparison of `world.hash()`, tick by tick |

A check is shown to hold the rule: break the rule and see it go red. What goes wrong with no error and that no check can hold yet is a line of [to-revisit.md](../../../roadmap/to-revisit.md), with what would close it.
