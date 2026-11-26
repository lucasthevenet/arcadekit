---
"arcadekit": minor
"@arcadekit/three": minor
---

Every module names its types and errors by one rule. A module's main type is its name, and every other type is named for what it is after the namespace, which it does not repeat. A service's interface is the service's name and `Shape`. An error's class is named for what went wrong, and its tag is its module and its class together, so `Effect.catchTag` never takes two errors of one bare tag for one. A codec's `decode` fails with a tagged error of its module that has a `problem`, and its `encode` fails the same way and does not throw. The Oxlint rule `arcadekit/names` holds the names and the tags.

**Breaking**

Types:

- `Event.EventDef` is `Event.Event`, `Event.EventReader` is `Event.Reader`, and `Event.EventHandle` is `Event.Emitter`.
- `Action.ActionDef` is `Action.Action`, and `Action.AnyActionDef` is `Action.Any`.
- `State.StateView` is `State.Reader`, and `State.StateHandle` is `State.Setter`.
- `ComponentDef` and `RelationDef` of `arcadekit` are `Component.Component` and `Component.Relation`. `arcadekit/ecs` keeps `ComponentDef` and `RelationDef`.
- The interface of `Input.Source` is `Input.SourceShape`, and that of `Sound.Output` is `Sound.OutputShape`.
- `Sound.Line` is `Sound.Binding`, `Sound.Options` is `Sound.PlayOptions`, and `Sound.Scored`, what a recorder notes of a channel, is `Sound.Told`.
- `Driver.Ready` is `Driver.ReadyOptions`, `Three.Which` is `Three.KindOptions`, `Audio.AudioLike` is `Audio.ContextLike`, and `Transport.WireTransport` is `Transport.OverWire`.

Errors, with the tag `Effect.catchTag` takes:

- `Save.SaveRefused` is `Save.Refused`, still `"SaveRefused"`. `Save.LoadRefused` is `"SaveLoadRefused"`, and its `problem` is never `"world not empty"` or `"cannot be saved"`: a migration that leaves a value that can't be saved is `"migration failed"`.
- `Action.UnknownAction` is `Action.Unknown`, `"ActionUnknown"`, and `Action.InvalidPayload` is `"ActionInvalidPayload"`. A refused entry of an app's log says these tags.
- `Assets.AssetFailed` is `Assets.Failed`, `"AssetsFailed"`, and `Event.InvalidEvent` is `Event.Invalid`, `"EventInvalid"`.
- `Drift.Drifted` is `"DriftDrifted"`, `Drift.Unlike` is `"DriftUnlike"`, `Session.RewindDiverged` is `"SessionRewindDiverged"`, `Journal.HashMismatch` is `"JournalHashMismatch"`, `Journal.ReplayDiverged` is `"JournalReplayDiverged"`, and `App.FrameChangedWorld` is `"AppFrameChangedWorld"`.

Codecs:

- `Journal.encode` returns an `Exit` and fails with `Journal.Invalid`, `"no JSON form"`, where it threw: `yield* Journal.encode(recording)`. `Journal.decode` fails with `Journal.Invalid`, `"not a recording"` or `"older format"`, where it failed with a `Schema.SchemaError`.
- `Message.encode` returns an `Exit` and fails with `Message.Invalid`, `"not a message"`, where it threw. `Message.decode` and `Message.decodeNotice` fail with `Message.Invalid` where they failed with a `Schema.SchemaError`.
