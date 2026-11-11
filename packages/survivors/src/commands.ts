import * as Game from "arcadekit/game";
import { Schema } from "effect";

// What a player decides in a survivors run outside what their device holds, and the reasons the
// rules refuse it: a pick, in every run, and the pause a player of a co-op run holds for
// everyone. `offer` is an offer's number (`World.offerSeq`, a `LeveledUp`'s `offer`).

/**
 * The offer a `ChooseUpgrade` names is not open for its sender: another offer is the open one,
 * the sender's hero has no offer open (it already picked, or the level-up is over), or the
 * sender has no hero in the run.
 */
export class OfferClosed extends Game.Rejection("OfferClosed", {
  offer: Schema.Int,
}) {}

/** The sender's open offer has no choice at `index`. */
export class NoSuchChoice extends Game.Rejection("NoSuchChoice", {
  offer: Schema.Int,
  index: Schema.Int,
}) {}

/**
 * An upgrade pick: the sender's hero takes the choice at `index` of the offer numbered `offer`,
 * and its offer closes. Naming the offer means a pick that arrives late answers nothing else.
 */
export class ChooseUpgrade extends Game.Command(
  "ChooseUpgrade",
  { offer: Schema.Int, index: Schema.Int },
  { rejects: [OfferClosed, NoSuchChoice] }
) {}

/**
 * The sender's hero is not playing, so it holds no pause: it is down, or it has left, or the
 * sender has no hero in the run, or the run is over.
 */
export class NotPlaying extends Game.Rejection("NotPlaying") {}

/**
 * The co-op pause: the sender's hero holds the run paused for everyone (`held: true`), or lets
 * go of it. The run plays on once no hero holds it. Only a playing hero of a run that is still
 * on holds one: a hero that goes down or leaves lets go, so no pause is held when a run ends,
 * and a hold or a letting go from a hero that is not playing, or sent once the run is over, is
 * refused. A single-player app pauses its engine instead (`engine.setPaused`), which stops the
 * steps themselves.
 */
export class HoldPause extends Game.Command(
  "HoldPause",
  { held: Schema.Boolean },
  { rejects: [NotPlaying] }
) {}
