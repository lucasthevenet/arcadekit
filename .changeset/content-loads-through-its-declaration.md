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

- A handler in `apply` takes the state `create` returns wherever it is written, with `create` the first of the handlers. Written directly under a `create` with an unannotated parameter (`create: (config: Config, { seed }) => ...`), it had a state of type `unknown`, and only another handler between the two (a `step`, a `sample`) hid that. `Game.CommandHandlers` is keyed by the commands' tags as before, and now reads them from the list without renaming the keys, which is what lets TypeScript type a handler before the state is settled. It also changes a definition that compiled: an `apply` written above a `create` written in place can now leave the whole simulation's state `unknown`, sometimes with no error, as a `step` there always could. Write `create` before `step`, `apply` and `sample`: this repository's lint reports the order (`declaration/create-first`).
- A handler in `apply` with no command declared for it is refused: it was never called, and nothing said so. In a simulation that declares no command it is now a type error on the handler's line: `apply` is typed there by `Game.NoHandlers`, a new exported type. One the types let through (a cast, handlers held in a variable) makes `Game.Simulation` throw when declared: ``Simulation "Jar" has apply.Empty but declares no command "Empty". List the command's class in `commands`, or remove the handler.``

**Changed**

- Attaching an engine or a Co-op client that is already attached still dies, and the defect now names the declaration and says what to do: `Engine "MyEngine" is already attached to an element. An engine draws into one element at a time: interrupt the first attach, which detaches it, before attaching again.` A `Coop`'s says the same of its Co-op client.
- `Game.Simulation`'s doc comment says what it refuses when declared and shows a loop that steps one, and `Game.Engine`'s example is push-puzzle's engine as it is written, with its cue table in `uses`.
