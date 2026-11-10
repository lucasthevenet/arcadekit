import { Schema } from "effect";

import type { Fields, NoFields, Payload } from "./event";

/** A command value: its `_tag` plus its payload. */
export type CommandInstance<Tag extends string, F extends Fields> = {
  readonly _tag: Tag;
} & Payload<F>;

/** Any class made by `Game.Command`. */
export interface AnyCommand extends Schema.Top {
  readonly kind: "Command";
  readonly tag: string;
  readonly Type: { readonly _tag: string };
  new (...args: never[]): { readonly _tag: string };
}

/** The class `Game.Command` returns: a Schema, and the constructor of its values. */
export interface CommandClass<
  Tag extends string,
  F extends Fields,
> extends Schema.Class<
  CommandInstance<Tag, F>,
  Schema.TaggedStruct<Tag, F>,
  NoFields
> {
  readonly kind: "Command";
  readonly tag: Tag;
}

/**
 * A decision a player makes outside what their device holds, named in the imperative: "choose
 * upgrade", "continue lesson". The app sends one, and the run applies it at the start of its
 * next step, through the simulation's `apply` handler of the same name. A run changes in no
 * other way: device input and commands both arrive at a step, so a replay or a lockstep peer
 * that gets the same ones computes the same run.
 *
 * ```ts
 * export class ChooseUpgrade extends Game.Command("ChooseUpgrade", {
 *   index: Schema.Int,
 * }) {}
 *
 * yield* engine.send(new ChooseUpgrade({ index: 1 }));
 * ```
 */
export const make = <
  const Tag extends string,
  const F extends Fields = NoFields,
>(
  tag: Tag,
  fields?: F
): CommandClass<Tag, F> => {
  // TaggedClass's own type depends on its `Self`, which is only known once this returns.
  const Base = Schema.TaggedClass<CommandInstance<Tag, F>>(tag)(
    tag,
    fields ?? ({} as F)
  ) as unknown as new (...args: never[]) => object;
  return class extends Base {
    static readonly kind = "Command" as const;
    static readonly tag: Tag = tag;
  } as unknown as CommandClass<Tag, F>;
};
