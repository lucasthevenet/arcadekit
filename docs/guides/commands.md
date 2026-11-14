# Commands and refusals

A command is what a player decides outside what their devices hold, such as an upgrade to pick: a `Game.Command` the simulation lists in `commands`, which its `apply` handler takes at the start of the next step ([The simulation](simulation.md)). A command is the one way a run changes besides its input.

## Refusing a command

A command the rules may turn down says how. Each way is a `Game.Rejection`, listed in the command's `rejects`. Its `apply` handler returns one in place of changing the state, and whoever sent the command gets it back as a typed failure. A refusal is not a bug and not an event: nothing happened in the run, and only the sender hears of it.

```ts
import * as Game from "arcadekit/game";
import * as Scenario from "arcadekit/game/scenario";
import { Schema } from "effect";

// Why the rules refuse it, and the command that says it may be refused that way.
class OfferClosed extends Game.Rejection("OfferClosed", {
  offer: Schema.Int,
}) {}
class ChooseUpgrade extends Game.Command(
  "ChooseUpgrade",
  { offer: Schema.Int, index: Schema.Int },
  { rejects: [OfferClosed] }
) {}
class Upgraded extends Game.Event("Upgraded", { level: Schema.Int }) {}

class Run extends Game.Simulation("Run", {
  input: Schema.Null,
  events: [Upgraded],
  commands: [ChooseUpgrade],
  create: () => ({ offer: 1, level: 0 }),
  step: () => {},
  apply: {
    ChooseUpgrade: (run, command, { report }) => {
      // Decide first, then change: a refused command leaves the state as it was.
      if (command.offer !== run.offer) {
        return new OfferClosed({ offer: command.offer });
      }
      run.level += 1;
      run.offer += 1;
      report(new Upgraded({ level: run.level }));
    },
  },
}) {}

const scenario = Scenario.make(Run);

// The same offer picked twice: the first pick is taken, the second refused.
scenario(
  Scenario.given(null),
  Scenario.send(new ChooseUpgrade({ offer: 1, index: 0 })),
  Scenario.send(new ChooseUpgrade({ offer: 1, index: 2 })),
  Scenario.step(null),
  Scenario.reported(new Upgraded({ level: 1 })),
  Scenario.refused(new OfferClosed({ offer: 1 }))
);
```

- **A handler returns nothing, or one of its command's rejections**: a value of the rejection's class, `new OfferClosed(...)`. Anything else is a type error, and the loop refuses at run time what a cast gets past the types. Under `noImplicitReturns`, a handler that refuses on one path ends its other path with `return undefined;`.
- **A handler decides before it changes anything.** A refused command changed nothing in the run. The loop holds a handler to the part it can see: one that reports an event and then refuses is thrown out. It can't see a quiet change to the state, so a scenario checks that.
- **The app gets it from `engine.send`**, which waits for the rules' answer: `yield* engine.send(new ChooseUpgrade({ offer, index }))` succeeds if the handler took the command and fails with `OfferClosed`, the class's own value, if it refused. An app handles it by its tag, `Effect.catchTag("OfferClosed", ...)`. The handler runs at the start of the run's next step, and the send completes after that step's frame has drawn: the line after it never runs inside a step, so it may start or stop a run.
- **A listener hears a step before its sender does.** When a send completes, the callback given to `engine.listen` has been called with everything the frame of the command's step reported: the events of each of its steps, then its sample if one was due. So a Command that listens and then sends knows, on the line after the send, what its command's step did, such as whether a pick opened another offer. It holds whenever the rules answered, whether they took the command or refused it, with one exception: a frame that throws before its listeners have heard it all, as `attach` fails with `GameCrashed`. A command it had applied still gets the rules' answer. But if a step threw, what that frame reported is discarded with its run and reaches no listener; and if a listener threw, the telling ended there: the listeners called before it heard that event, and none heard what came after. A render that throws comes after both, so the listeners heard its whole frame. A send that fails with `CommandDropped` had no step to hear of; one a new `start` dropped completes after the listener heard that run's start. The order is that of the two calls, not of Messages: an app's Subscription makes a Message of each event and its Command another of the send's result, and the kit fixes no order between those in `update`.
- **`Game.CommandDropped`** is the other way a send fails: the rules gave no answer, because there is no run (`reason: "noRun"`) or the run ended first (`"runEnded"`: a stop, a new run or a crash). Every send can fail with it. An app that only cares what the rules said writes `Effect.catchTag("CommandDropped", () => Effect.void)`, and one that doesn't care how a command ends writes `Effect.ignore`, which hides a refusal too. A command sent again after `runEnded` goes to whichever run is current.
- **A step needs a frame**, so a send waits while the engine is paused or not attached, and ends when its run next steps or ends: bound it with `Effect.timeout` if a screen can't wait. A screen that sends a command leaves the run stepping, and freezes the game in its rules if it must. Interrupting a send takes the command back, if it hasn't been applied yet.
- **In a lockstep run**, the same command and the same rejections travel: `session.send` and the Co-op client's `send` ([`arcadekit/net`](lockstep-sessions.md#commands)) carry a command to every peer's rules at one step, each peer's `apply` handler takes or refuses it alike, and only the sender hears. `CommandDropped` then speaks for the sender's own peer: its run stopped before its rules answered.
- **With `Game.Loop`**, `loop.send(command, player, settled)` calls `settled` with `undefined`, the rejection or a `CommandDropped`, once the loop is out of the frame, the `start` or the `stop` that ended the command, so `settled` may send, start or stop. By then the loop's listeners (`loop.subscribe`) have heard what that frame or that start reported: a frame's events, then its sample. It returns a function that takes the command back: `settled` is not called after it. A frame that throws tells no sender: the `stop` that follows tells them. If a step or a handler threw, that `stop` also discards what the frame had reported, which no listener hears; a listener that throws ends the telling where it threw. An input source's `read(step)` may send: a command sent there is applied in that same step, before `step`, which is how a host that knows a command's step (a replay, a lockstep session) gives it to the rules at exactly that step.
- **To name the types**: `Game.RejectionOf<typeof Survivors>` is every rejection of a simulation, and `Game.EngineOf<typeof Survivors>` the running engine, for a function that takes one.
