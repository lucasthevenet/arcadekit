/**
 * Rejections: the reasons the rules refuse a command.
 *
 * `Game.Rejection` is a declaration, built as `Game.Event` is, over `Schema.TaggedError`: its
 * values are errors an Effect fails with, so whoever sent the refused command handles one by its
 * tag. A refusal is not a bug and not an event: nothing happened in the run.
 *
 * @since 0.7.0
 */
import { Schema } from "effect";
import type { Cause } from "effect";

import type { Fields, NoFields, Payload } from "./event";

/**
 * A value of a rejection: its `_tag` and its payload.
 *
 * **When to use**
 *
 * Rarely: a game names a rejection's values by its class, `OfferClosed`.
 *
 * **Example** (A rejection's value)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class OfferClosed extends Game.Rejection("OfferClosed", { offer: Schema.Int }) {}
 * const closed: Game.RejectionInstance<"OfferClosed", { readonly offer: typeof Schema.Int }> =
 *   new OfferClosed({ offer: 2 });
 * closed._tag; // => "OfferClosed"
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type RejectionInstance<Tag extends string, F extends Fields> = {
  readonly _tag: Tag;
} & Payload<F>;

/**
 * Any class made by `Game.Rejection`.
 *
 * **When to use**
 *
 * To type a list of rejections, as a command's `rejects` is.
 *
 * **Example** (A command's rejections)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 *
 * class OfferClosed extends Game.Rejection("OfferClosed") {}
 * class NotYourTurn extends Game.Rejection("NotYourTurn") {}
 * const rejects: readonly Game.AnyRejection[] = [OfferClosed, NotYourTurn];
 * rejects.map((rejection) => rejection.tag); // => ["OfferClosed", "NotYourTurn"]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface AnyRejection extends Schema.Top {
  readonly kind: "Rejection";
  readonly tag: string;
  readonly Type: { readonly _tag: string };
  new (...args: never[]): { readonly _tag: string };
}

/**
 * The class `Game.Rejection` returns: a Schema, and the constructor of its values. A value is
 * also an error an Effect can fail with, so the app that sent the command handles it by its tag.
 *
 * **When to use**
 *
 * To type a value that is some rejection's class, as a host that takes one does. A game names
 * its own class.
 *
 * **Example** (What the class holds)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class OfferClosed extends Game.Rejection("OfferClosed", { offer: Schema.Int }) {}
 * const declared: Game.RejectionClass<"OfferClosed", { readonly offer: typeof Schema.Int }> =
 *   OfferClosed;
 * declared.kind; // => "Rejection"
 * declared.tag; // => "OfferClosed"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface RejectionClass<
  Tag extends string,
  F extends Fields,
> extends Schema.Class<
  RejectionInstance<Tag, F>,
  Schema.TaggedStruct<Tag, F>,
  Cause.YieldableError
> {
  readonly kind: "Rejection";
  readonly tag: Tag;
}

/**
 * Declares a rejection: a reason the rules refuse a command, named for what is wrong ("offer
 * closed", "not your turn"). A command lists the rejections it can end with (`rejects`), its
 * `apply` handler returns one in place of changing the state, and whoever sent the command gets
 * it as a typed failure.
 *
 * **When to use**
 *
 * For each way the rules may turn down a player's decision. A refusal is not a bug and not an
 * event: nothing happened in the run, and only the sender hears of it.
 *
 * **Details**
 *
 * A handler decides before it changes anything, so a refused command leaves the state as it
 * was. A value is an error: `yield*` of one fails an Effect with it, and an app catches it with
 * `Effect.catchTag`.
 *
 * **Example** (Refusing a pick of a closed offer)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Effect, Schema } from "effect";
 *
 * class OfferClosed extends Game.Rejection("OfferClosed", { offer: Schema.Int }) {}
 * class ChooseUpgrade extends Game.Command(
 *   "ChooseUpgrade",
 *   { offer: Schema.Int },
 *   { rejects: [OfferClosed] }
 * ) {}
 *
 * // In the simulation's apply:
 * // ChooseUpgrade: (run, command) =>
 * //   run.offer === command.offer ? undefined : new OfferClosed({ offer: command.offer })
 *
 * // An app hears it as a failure, by its tag:
 * const refused = Effect.fail(new OfferClosed({ offer: 1 })).pipe(
 *   Effect.catchTag("OfferClosed", ({ offer }) => Effect.succeed(`offer ${offer} closed`))
 * );
 * Effect.runSync(refused); // => "offer 1 closed"
 * ChooseUpgrade.rejects.length; // => 1
 * ```
 *
 * @category declarations
 * @since 0.7.0
 */
export const make = <
  const Tag extends string,
  const F extends Fields = NoFields,
>(
  tag: Tag,
  fields?: F
): RejectionClass<Tag, F> => {
  // TaggedError's own type depends on its `Self`, which is only known once this returns.
  // oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError makes a class; it is not an error being thrown.
  const Base = Schema.TaggedError<RejectionInstance<Tag, F>>(tag)(
    tag,
    fields ?? ({} as F)
  ) as unknown as new (...args: never[]) => object;
  return class extends Base {
    static readonly kind = "Rejection" as const;
    static readonly tag: Tag = tag;
  } as unknown as RejectionClass<Tag, F>;
};
