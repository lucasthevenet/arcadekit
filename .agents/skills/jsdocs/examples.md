# Examples

Examples are optional. Keep or add one only for behavior not evident from the signature, meaningful composition, or useful inference or narrowing. Replace or remove examples that are trivial, misleading, contrived, or scaffolding-heavy.

An example is a run of lines indented by two spaces under a blank line, with optional prose before it. The page shows each such run as a `ts` block, and an editor shows it as it is written. Indent no prose that way, or it is shown as code.

```ts sketch
/**
 * States: a game is in the menu, playing or paused, and systems run only in
 * some of those.
 *
 *   const Phase = State.define("game/Phase", ["menu", "playing", "paused"])
 *
 *   const phase = yield* Phase      // in a system, a handler or a script
 *   phase.value                     // "menu"
 *
 * A state is a singleton of the world.
 */
```

- Write the module as a game imports it, by its namespace: `State.define`, `System.make`.
- Arrange nontrivial examples as setup, operation, then what is seen of it, as a comment at the end of the line.
- Show a part of a game, not a whole program: a body that is not the point is `function*() { ... }`.
- Nothing compiles or runs an example of a doc comment. Check each against the signature it shows and against a test that does the same, and change it with the export.
- An example worth running is a guide's: a `ts` block of a page under `website/src/content/docs/` is compiled, and one titled `*.test.ts` is run. That is the `website-docs` skill's.

If example research suggests an implementation or type bug, report it instead of changing runtime code during a documentation-only pass.
