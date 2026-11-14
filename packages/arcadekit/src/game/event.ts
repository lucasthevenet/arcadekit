/**
 * Events: the rare, meaningful facts a run reports to the outside (ADR-0008).
 *
 * `Game.Event` is a declaration: a game writes `class LevelSolved extends Game.Event(...) {}`, and
 * the class is the event's constructor and its Schema, so a value goes into a Foldkit Message as
 * it is. A sample, the loop's read of the state for a HUD, is declared the same way. The types
 * here are shared with `Game.Command` and `Game.Rejection`, which are built alike.
 *
 * @since 0.7.0
 */
import { Schema } from "effect";

/**
 * The fields of an event, a command or a rejection: a `Schema.Struct`'s.
 *
 * **When to use**
 *
 * To name what a declaration takes as its fields, in a helper that builds one.
 *
 * **Example** (Fields a game writes)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * const fields: Game.Fields = { moves: Schema.Int };
 * class LevelSolved extends Game.Event("LevelSolved", fields) {}
 * LevelSolved.tag; // => "LevelSolved"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type Fields = Schema.Struct.Fields;

/**
 * No fields: an event, a command or a rejection that carries nothing but its `_tag`.
 *
 * **When to use**
 *
 * To name a declaration's fields when it has none, as the builders' types do when no fields are
 * given.
 *
 * **Example** (An event with no fields)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 *
 * class Started extends Game.Event("Started") {}
 * const declared: Game.EventClass<"Started", Game.NoFields> = Started;
 * new declared()._tag; // => "Started"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type NoFields = Record<never, never>;

/**
 * What a value of an event, a command or a rejection carries besides its `_tag`.
 *
 * **When to use**
 *
 * To type what a function reads from a value without its tag, such as a sample's `read`.
 *
 * **Example** (An event's payload)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * const payload: Game.Payload<{ readonly moves: typeof Schema.Int }> = { moves: 3 };
 * payload.moves; // => 3
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type Payload<F extends Fields> = Schema.Struct<F>["Type"];

/**
 * A value of an event: its `_tag` and its payload.
 *
 * **When to use**
 *
 * Rarely: a game names an event's values by its class, `LevelSolved`.
 *
 * **Example** (An event's value)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class LevelSolved extends Game.Event("LevelSolved", { moves: Schema.Int }) {}
 * const solved: Game.EventInstance<"LevelSolved", { readonly moves: typeof Schema.Int }> =
 *   new LevelSolved({ moves: 3 });
 * solved._tag; // => "LevelSolved"
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type EventInstance<Tag extends string, F extends Fields> = {
  readonly _tag: Tag;
} & Payload<F>;

/**
 * Any class made by `Game.Event`.
 *
 * **When to use**
 *
 * To type a list of a game's events, as a simulation's `events` is.
 *
 * **Example** (A list of events)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 *
 * class Started extends Game.Event("Started") {}
 * class Ended extends Game.Event("Ended") {}
 * const events: readonly Game.AnyEvent[] = [Started, Ended];
 * events.map((event) => event.tag); // => ["Started", "Ended"]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface AnyEvent extends Schema.Top {
  readonly kind: "Event";
  readonly tag: string;
  readonly Type: { readonly _tag: string };
  new (...args: never[]): { readonly _tag: string };
}

/**
 * The class `Game.Event` returns: a Schema, and the constructor of its values.
 *
 * **When to use**
 *
 * To type a value that is some event's class, as a host that takes one does. A game names its
 * own class.
 *
 * **Example** (What the class holds)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class LevelSolved extends Game.Event("LevelSolved", { moves: Schema.Int }) {}
 * const declared: Game.EventClass<"LevelSolved", { readonly moves: typeof Schema.Int }> =
 *   LevelSolved;
 * declared.kind; // => "Event"
 * declared.tag; // => "LevelSolved"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
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
 * Declares an event: a rare, meaningful fact a run reports to the outside, named in the past
 * tense ("level solved", "leveled up"). A step reports one with `report`, and the app hears it as
 * a value of this class, which is also its Schema, so it goes into a Foldkit Message as it is.
 *
 * **When to use**
 *
 * For each thing the UI, the sound or an analytics hook should hear of: a level solved, a boss
 * spawned. Never per-entity data, which a view reads from the state. A sample, the loop's read of
 * the state for a HUD, is declared the same way and given to `Game.Simulation`'s `sample`.
 *
 * **Details**
 *
 * The tag is the declared name, and the fields are a `Schema.Struct`'s. A scenario checks a
 * reported event against one it makes by its tag and its payload.
 *
 * **Example** (Declaring and reporting an event)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class LevelSolved extends Game.Event("LevelSolved", { moves: Schema.Int }) {}
 *
 * // In a step: report(new LevelSolved({ moves: puzzle.moves }))
 * const solved = new LevelSolved({ moves: 3 });
 * solved._tag; // => "LevelSolved"
 * Schema.decodeUnknownSync(LevelSolved)({ _tag: "LevelSolved", moves: 3 }).moves; // => 3
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
