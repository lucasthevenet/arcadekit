/**
 * Survivors' commands: what a player decides outside what their device holds, and the reasons
 * the rules refuse it.
 *
 * A pick answers a hero's upgrade offer, in every run, and a player of a co-op run holds the
 * pause for everyone. Each is a declaration, sent to the engine or the Co-op client and applied
 * by the rules at the start of a step (`World.chooseUpgrade`, `World.holdPause`), on every peer;
 * a refusal is one of the rejections the command declares. `offer` is an offer's number
 * (`World.Arena`'s `offerSeq`, a `LeveledUp`'s `offer`).
 */
import * as Game from "arcadekit/game";
import { Schema } from "effect";

/**
 * The offer a `ChooseUpgrade` names is not open for its sender: another offer is the open one,
 * the sender's hero has no offer open (it already picked, or the level-up is over), or the sender
 * has no hero in the run.
 *
 * **When to use**
 *
 * In an app, as one way a pick it sent can end: a late or repeated pick, which changed nothing.
 *
 * **Example** (A refusal's offer)
 *
 * ```ts
 * import { OfferClosed } from "#survivors";
 *
 * const closed = new OfferClosed({ offer: 3 });
 * [closed._tag, closed.offer]; // => ["OfferClosed", 3]
 * ```
 *
 * @category declarations
 */
export class OfferClosed extends Game.Rejection("OfferClosed", {
  offer: Schema.Int,
}) {}

/**
 * The sender's open offer has no choice at `index`.
 *
 * **When to use**
 *
 * In an app, as one way a pick it sent can end: its index was out of the offer's range. The offer
 * stays open.
 *
 * **Example** (A pick past the last choice)
 *
 * ```ts
 * import { NoSuchChoice } from "#survivors";
 *
 * const refused = new NoSuchChoice({ offer: 1, index: 5 });
 * [refused._tag, refused.index]; // => ["NoSuchChoice", 5]
 * ```
 *
 * @category declarations
 */
export class NoSuchChoice extends Game.Rejection("NoSuchChoice", {
  offer: Schema.Int,
  index: Schema.Int,
}) {}

/**
 * An upgrade pick: the sender's hero takes the choice at `index` of the offer numbered `offer`,
 * and its offer closes. The run resumes at the step that closes the last open offer.
 *
 * **When to use**
 *
 * In an app, when its player picks: a single-player app sends it to the engine
 * (`engine.send`), and a co-op app to the Co-op client, where it rides the player's next step to
 * every peer.
 *
 * **Details**
 *
 * Naming the offer means a pick that arrives late answers nothing else: it is refused with
 * `OfferClosed`. An index the offer lacks is refused with `NoSuchChoice`. A refused pick changes
 * nothing.
 *
 * **Example** (A pick with no offer open)
 *
 * ```ts
 * import { ChooseUpgrade, GameContent, Survivors } from "#survivors";
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(GameContent.GameContent)({
 *   rules: {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 5, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1, basePickupRadius: 2.5, choicesPerLevelUp: 3, runLength: 60,
 *   },
 *   heroes: [{ id: "bolter", name: "Bolter", description: "", color: "#ffffff", maxHp: 100, moveSpeed: 6, startingWeapon: "bolt" }],
 *   enemies: [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   weapons: [{
 *     id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *     cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 5,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   passives: [],
 *   waves: [{ from: 0, to: 60, enemy: "grunt", perSecond: 1 }],
 * });
 * const loop = Game.makeLoop(Survivors);
 * loop.start({ content, heroIds: ["bolter"] }, 1, 0);
 * const answers: unknown[] = [];
 * loop.send(new ChooseUpgrade({ offer: 1, index: 0 }), 0, (outcome) => answers.push(outcome?._tag));
 * loop.frame(Game.soloInput({ read: () => ({ moveX: 0, moveZ: 0 }) }), { steps: 1 }, 0);
 * answers; // => ["OfferClosed"]
 * ```
 *
 * @category declarations
 */
export class ChooseUpgrade extends Game.Command(
  "ChooseUpgrade",
  { offer: Schema.Int, index: Schema.Int },
  { rejects: [OfferClosed, NoSuchChoice] }
) {}

/**
 * The sender's hero is not playing, so it holds no pause: it is down, or it has left, or the
 * sender has no hero in the run, or the run is over.
 *
 * **When to use**
 *
 * In a co-op app, as one way a `HoldPause` it sent can end, so it stops showing the run as paused
 * for its player.
 *
 * **Example** (The refusal's tag)
 *
 * ```ts
 * import { NotPlaying } from "#survivors";
 *
 * new NotPlaying()._tag; // => "NotPlaying"
 * ```
 *
 * @category declarations
 */
export class NotPlaying extends Game.Rejection("NotPlaying") {}

/**
 * The co-op pause: the sender's hero holds the run paused for everyone (`held: true`), or lets go
 * of it. The run plays on once no hero holds it.
 *
 * **When to use**
 *
 * In a co-op app, when its player opens or closes the run's menu. A single-player app pauses its
 * engine instead (`engine.setPaused`), which stops the steps themselves.
 *
 * **Details**
 *
 * A held pause freezes the run in its rules: the steps still run, so the peers stay in touch.
 * Only a playing hero of a run that is still on holds one: a hero that goes down or leaves lets
 * go, so no pause is held when a run ends, and a hold or a letting go from a hero that is not
 * playing, or sent once the run is over, is refused with `NotPlaying`.
 *
 * **Example** (A held pause stops the run's clock)
 *
 * ```ts
 * import { GameContent, HoldPause, Survivors } from "#survivors";
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * const content = Schema.decodeUnknownSync(GameContent.GameContent)({
 *   rules: {
 *     arenaHalfSize: 20, maxEnemies: 50, xpToLevel2: 5, xpGrowth: 1.3,
 *     baseMoveSpeedScale: 1, basePickupRadius: 2.5, choicesPerLevelUp: 3, runLength: 60,
 *   },
 *   heroes: [{ id: "bolter", name: "Bolter", description: "", color: "#ffffff", maxHp: 100, moveSpeed: 6, startingWeapon: "bolt" }],
 *   enemies: [{ id: "grunt", name: "Grunt", color: "#00ff00", hp: 8, speed: 2.5, damage: 10, radius: 0.45, xp: 1 }],
 *   weapons: [{
 *     id: "bolt", name: "Bolt", description: "", color: "#ffff00", damage: 10, damagePerLevel: 3,
 *     cooldown: 0.5, cooldownScalePerLevel: 0.9, maxLevel: 5,
 *     behavior: { kind: "bolt", projectileSpeed: 20, count: 1, countPerLevel: 0.5, pierce: 0, range: 14 },
 *   }],
 *   passives: [],
 *   waves: [{ from: 0, to: 60, enemy: "grunt", perSecond: 1 }],
 * });
 * const loop = Game.makeLoop(Survivors);
 * const still = Game.soloInput({ read: () => ({ moveX: 0, moveZ: 0 }) });
 * loop.start({ content, heroIds: ["bolter"] }, 1, 0);
 * loop.send(new HoldPause({ held: true }));
 * loop.frame(still, { steps: 30 }, 500);
 * loop.state?.time; // => 0
 * ```
 *
 * @category declarations
 */
export class HoldPause extends Game.Command(
  "HoldPause",
  { held: Schema.Boolean },
  { rejects: [NotPlaying] }
) {}
