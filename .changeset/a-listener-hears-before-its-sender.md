---
"arcadekit": patch
---

The docs now say what a listener has heard when a `send` completes. `Game.Engine`'s `send` said that its answer and the events of its step "arrive in no fixed order". That was wrong for a listener: the order is fixed, and a game may rely on it. No code changed, so nothing breaks: tests now hold the order.

- **`engine.send`.** When it completes, the callback given to `engine.listen` has been called with everything the frame of the command's step reported: the events of each of that frame's steps, then its sample if one was due. So an Effect that listens and then sends knows, on the line after the send, what its command's step did, such as whether a pick opened another offer. It holds whether the rules took the command or refused it, and after a wait behind a pause.
- **The one exception is a frame that throws before its listeners have heard it all**, as `attach` fails with `GameCrashed`. A command one of its steps had applied still gets the rules' answer. But if a step threw, what the frame had reported is discarded with its run and reaches no listener; and if a listener threw, the telling ended there: the listeners called before it heard that event, and none heard what came after. A render that throws comes after both, so the listeners heard its whole frame.
- **A send that fails with `CommandDropped`** had no step to hear of. One that a new `start` dropped completes after the listener heard that run's start.
- **A lockstep session's `send`, the scoped session's and the Co-op client's** have the same order, with no exception: a session's listeners are called inside the tick and its senders after it, and a tick that throws tells its senders `CommandDropped`. So no sender hears the rules' answer to a command whose step its listeners did not hear.
- **The order is that of the two calls, not of Messages.** An app's Subscription makes a Message of each event and its Command another of the send's result, and the kit fixes no order between those in `update`. A Command that needs what its command's step reported listens itself, around its send.

`Game.Loop`'s `subscribe` and `frame`, the entries' READMEs (`arcadekit/game`, `arcadekit/net`) and the glossary say the same.
