import { Schema } from "effect";

/** The fields of an event or a command: a `Schema.Struct`'s. */
export type Fields = Schema.Struct.Fields;

/** No fields: an event or a command that carries nothing but its `_tag`. */
export type NoFields = Record<never, never>;

/** What an event or a command carries besides its `_tag`. */
export type Payload<F extends Fields> = Schema.Struct<F>["Type"];

/** An event value: its `_tag` plus its payload. */
export type EventInstance<Tag extends string, F extends Fields> = {
  readonly _tag: Tag;
} & Payload<F>;

/** Any class made by `Game.Event`. */
export interface AnyEvent extends Schema.Top {
  readonly kind: "Event";
  readonly tag: string;
  readonly Type: { readonly _tag: string };
  new (...args: never[]): { readonly _tag: string };
}

/** The class `Game.Event` returns: a Schema, and the constructor of its values. */
export interface EventClass<
  Tag extends string,
  F extends Fields,
> extends Schema.Class<
  EventInstance<Tag, F>,
  Schema.TaggedStruct<Tag, F>,
  NoFields
> {
  readonly kind: "Event";
  readonly tag: Tag;
}

/**
 * A rare, meaningful fact a run reports to the outside, named in the past tense: "level solved",
 * "leveled up". Never per-entity data. A step reports one with `emit`, and the app hears it as a
 * value of this class, which is also its Schema, so it goes straight into a Foldkit Message.
 *
 * ```ts
 * export class LevelSolved extends Game.Event("LevelSolved", {
 *   moves: Schema.Int,
 * }) {}
 *
 * emit(new LevelSolved({ moves: puzzle.moves }));
 * ```
 *
 * A sample is declared the same way: it is an event the loop reads from the state, instead of
 * one a step reports (see `Game.Simulation`'s `sample`).
 */
export const make = <
  const Tag extends string,
  const F extends Fields = NoFields,
>(
  tag: Tag,
  fields?: F
): EventClass<Tag, F> => {
  // TaggedClass's own type depends on its `Self`, which is only known once this returns.
  const Base = Schema.TaggedClass<EventInstance<Tag, F>>(tag)(
    tag,
    fields ?? ({} as F)
  ) as unknown as new (...args: never[]) => object;
  return class extends Base {
    static readonly kind = "Event" as const;
    static readonly tag: Tag = tag;
  } as unknown as EventClass<Tag, F>;
};
