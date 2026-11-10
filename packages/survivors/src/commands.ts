import * as Game from "arcadekit/game";
import { Schema } from "effect";

// What a player decides in a survivors run outside what their device holds, and the reasons the
// rules refuse it. `offer` is an offer's number (`World.offerSeq`, a `LeveledUp`'s `offer`).

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
