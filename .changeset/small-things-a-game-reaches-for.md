---
"arcadekit": minor
---

Small things a game reaches for:

- An action that takes no payload is issued with none: `app.dispatch(Pause)`, `app.enqueue(Pause)` and `actions.enqueue(Pause)`. `Action.PayloadArgument` is the rest of the arguments they take. An event with no payload is emitted with `emit()`.
- `ui.subscribe(view, listener)` hands the listener the view's current value at once, then each value published, so a UI needs no `get` beside it.
- `View.define<A>(name, initial)` gives a view its type where the initial value says less, such as an empty list of ids, and the lint rule `arcadekit/id-casts` names it in place of a cast.
- `App.make(game, save === undefined ? { seed } : { save })` compiles, and may fail as a load does.
- `Resource.make(key, value)` takes its default value.
- `Color.hex(0xff6188)` is the value `Color.Rgb.of` takes for a hex code, and refuses a number that is none.
- `Assets.match(status, { Absent, Loading, Ready, Failed })` returns what the case of a bundle's status returns.
- `random.range(2, 5)` and `random.chance(0.1)`, on the world's generator and the frame's.
- A plugin typed `any`, as one whose import failed is, is refused where the plugins are listed, with a message that says so, in place of one about the order of systems.

**Breaking**

- `Resource.make(key, { defaultValue: () => value })` is `Resource.make(key, value)`.
- `Assets.during(condition, bundle)` is `Assets.during(bundle).pipe(System.runIf(condition))`, as every system's condition is, and with no condition it keeps the bundle loaded. `Assets.during(key, family)` is `Assets.during(family, key)`.
- A `Sound.Speaker` is told its options by name, as `Sound.Player` is: `play(cue, { volume, rate })` and `music(channel, track, { volume, fade, once })`, where they were positional.
- A gamepad is read through `Input.Gamepads` alone, as the keyboard and the pointer are through theirs: `yield* Input.Gamepad(i)` is `(yield* Input.Gamepads)(i)`.
- `ui.subscribe` calls its listener at once: a listener that counted what the game published counts the value it was handed when it subscribed too.
