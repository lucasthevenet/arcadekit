import { Schema } from "effect";

import type { EventInstance, NoFields } from "../../../game/index";

// How the Co-op client's own events are declared: each is a Schema class, typed by a written
// type that its Schema is checked against where it is declared, since the kit's type files are
// made from the written one (isolatedDeclarations).

/**
 * The class of one of the Co-op client's own events: a Schema, and the constructor of its
 * values. They are what a seat reports of itself, not what a run reports, so they are no
 * `Game.Event`s, and their tags are told from the run's by where each stands in `match`.
 */
export type SeatEvent<
  Tag extends string,
  F extends Schema.Struct.Fields,
> = Schema.Class<EventInstance<Tag, F>, Schema.TaggedStruct<Tag, F>, NoFields>;

/**
 * A seat event's class, from its tag and fields, typed by them: where one is declared, its
 * written type is checked against its Schema, so the two can't disagree. Not exported from the
 * entry: the four events are the Co-op client's, and a game declares its own with `Game.Event`.
 */
export const seatEvent = <
  const Tag extends string,
  const F extends Schema.Struct.Fields,
>(
  tag: Tag,
  fields: F
): SeatEvent<Tag, F> =>
  Schema.TaggedClass<{ readonly _tag: string }>(`arcadekit/net/${tag}`)(
    tag,
    fields
  ) as unknown as SeatEvent<Tag, F>;
