import { Schema } from "effect";
import type { Cause } from "effect";

import type { Fields, NoFields, Payload } from "./event";

/** A rejection value: its `_tag` plus its payload. */
export type RejectionInstance<Tag extends string, F extends Fields> = {
  readonly _tag: Tag;
} & Payload<F>;

/** Any class made by `Game.Rejection`. */
export interface AnyRejection extends Schema.Top {
  readonly kind: "Rejection";
  readonly tag: string;
  readonly Type: { readonly _tag: string };
  new (...args: never[]): { readonly _tag: string };
}

/**
 * The class `Game.Rejection` returns: a Schema, and the constructor of its values. A value is
 * also an error an Effect can fail with, so the app that sent the command handles it by its tag.
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
 * A reason the rules refuse a command, named for what is wrong: "offer closed", "not your turn".
 * A command lists the rejections it can end with (`rejects`), its `apply` handler returns one in
 * place of changing the state, and whoever sent the command gets it as a typed failure.
 *
 * ```ts
 * export class OfferClosed extends Game.Rejection("OfferClosed", {
 *   offer: Schema.Int,
 * }) {}
 *
 * export class ChooseUpgrade extends Game.Command(
 *   "ChooseUpgrade",
 *   { offer: Schema.Int, index: Schema.Int },
 *   { rejects: [OfferClosed] }
 * ) {}
 *
 * // In the simulation:
 * apply: {
 *   ChooseUpgrade: (world, command, { player }) => {
 *     if (world.offer !== command.offer) {
 *       return new OfferClosed({ offer: command.offer });
 *     }
 *     takeUpgrade(world, player, command.index);
 *   },
 * },
 *
 * // In the app:
 * yield* engine
 *   .send(new ChooseUpgrade({ offer, index }))
 *   .pipe(Effect.catchTag("OfferClosed", () => Effect.void));
 * ```
 *
 * A refusal is not a bug and not an event: nothing happened in the run, and only the sender
 * hears of it. A handler decides before it changes anything, so a refused command leaves the
 * state as it was.
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
