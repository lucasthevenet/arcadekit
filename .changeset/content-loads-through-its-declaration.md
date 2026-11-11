---
"arcadekit": minor
---

A game's content loads through its `Content` declaration, and in no other way.

**Breaking**

`arcadekit/content` no longer exports `loadContent` or `LoadContentOptions`. `loadContent({ ...definition, source })` was the same call as a declared content's `read(source)`, so there were two ways to read and check a game's files once. What to write:

```ts
export class MyContent extends Content("MyContent", {
  schema: MyGameContent,
  files: { levels: "levels.json" },
}) {}

// Before: loadContent({ schema: MyGameContent, files: { levels: "levels.json" }, source })
const checked = MyContent.read(source);
```

`read` keeps nothing, which suits a test of a game's real content files: it runs the checks the game runs. An app loads with `MyContent.load`, over `MyContent.layer(source)`, which keeps the first success.

**Fixed**

- A handler in `apply` takes the state `create` returns wherever it is written below `create`. Written directly under a `create` with an unannotated parameter (`create: (config: Config, { seed }) => ...`), it had a state of type `unknown`, and only a `step` between the two hid that. The exported type `Game.CommandHandlers` is keyed by the commands' tags as before, and now reads them from the list without renaming the keys, which is what lets TypeScript type a handler before the state is settled.

**Changed**

- Attaching an engine or a Co-op client that is already attached still dies, and the defect now names the declaration and says what to do: `Engine "MyEngine" is already attached to an element. An engine draws into one element at a time: interrupt the first attach, which detaches it, before attaching again.` A `Coop`'s says the same of its Co-op client.
- `Game.Simulation`'s doc comment says what it refuses when declared and shows a loop that steps one, and `Game.Engine`'s example is push-puzzle's engine as it is written, with its cue sounds in `uses`.
