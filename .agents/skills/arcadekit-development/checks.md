# Rules and the checks that hold them

`AGENTS.md` says a rule is held by a design or a check before a sentence. A sentence that a check has made true is taken out. These checks hold rules already, and a new rule joins them:

- `tooling/lint/entries.ts` says what each entry may import, and the Oxlint rule `arcadekit/entry-imports` holds it in the sources, file by file, and so in the build, which writes each source file to its own file;
- the Oxlint rules `arcadekit/no-page`, which keeps what only a page has in `src/browser/`, `arcadekit/no-code-from-text`, `arcadekit/top-level-classes`, which keeps a class out of a function, `arcadekit/id-casts`, which keeps the conversions of an id in `src/ecs/component.ts`, `arcadekit/no-outside-state`, which keeps what the code of the tick changes in the world, and `arcadekit/no-unused-internal`, which keeps what is `@internal` out of public signatures and public exports, and refuses one no source uses;
- `test/Policy.test.ts` plays a game where making code from text is forbidden;
- the lists of writers in `test/Transaction.test.ts`, `test/Changes.test.ts` and `test/Frame.test.ts`, which every new way to write joins;
- a frozen world, which refuses a change from the frame and input stages;
- `Drift.Drifted`, which stops peers whose worlds have come apart;
- `bench:compare`, which fails on a storage core that got slower;
- the site's typecheck, which compiles the code of every page, and its build, which fails on a dead link.

Which kind of check a rule gets:

| The rule is about | The check is |
| --- | --- |
| What a caller may write | A type, with a type test: `// @ts-expect-error` above the line that must not compile |
| What code may do as it runs | A refusal there, thrown or `Effect.die`, whose message says who, what, and what to do instead |
| What a file may import or contain | A rule of the Oxlint plugin in `tooling/lint/plugin.ts`, turned on in `oxlint.config.ts`, whose message says what to do instead |
| What the sources hold together (every file behind an entry, the exports a module gives) | A test that reads the sources, as `test/Entries.test.ts` does |
| What every member of a kind must do (every writer, every way into the world) | A test with a list of them that a new one is added to |
| What must stay fast | A variant of the benchmark, which `bench:compare` holds |
| What two runs must agree on | A comparison of `world.hash()`, tick by tick |

A check is shown to hold the rule: break the rule and see it go red. What goes wrong with no error and that no check can hold yet is an issue labelled `bug` whose title begins `Silent failure:`, with what would close it, as `AGENTS.md` says.
