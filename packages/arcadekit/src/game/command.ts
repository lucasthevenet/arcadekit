import { Data, Schema } from "effect";

import type { Fields, NoFields, Payload } from "./event";
import type { AnyRejection } from "./rejection";

/** A command value: its `_tag` plus its payload. */
export type CommandInstance<Tag extends string, F extends Fields> = {
  readonly _tag: Tag;
} & Payload<F>;

/** Any class made by `Game.Command`. */
export interface AnyCommand extends Schema.Top {
  readonly kind: "Command";
  readonly tag: string;
  readonly rejects: readonly AnyRejection[];
  readonly Type: { readonly _tag: string };
  new (...args: never[]): { readonly _tag: string };
}

/** The class `Game.Command` returns: a Schema, and the constructor of its values. */
export interface CommandClass<
  Tag extends string,
  F extends Fields,
  Rejects extends readonly AnyRejection[] = readonly [],
> extends Schema.Class<
  CommandInstance<Tag, F>,
  Schema.TaggedStruct<Tag, F>,
  NoFields
> {
  readonly kind: "Command";
  readonly tag: Tag;
  /** The rejections the rules may refuse this command with. */
  readonly rejects: Rejects;
}

// Named so the type files can be made one file at a time (isolatedDeclarations).
const CommandDroppedBase: ReturnType<
  typeof Data.TaggedError<"CommandDropped">
> = Data.TaggedError("CommandDropped");

/**
 * A command that was never applied, so the rules neither took nor refused it: it was sent with
 * no run (`noRun`), or its run ended before its next step (`runEnded`: a stop, a new run or a
 * crash). `command` is the command's tag.
 */
export class CommandDropped extends CommandDroppedBase<{
  readonly command: string;
  readonly reason: "noRun" | "runEnded";
}> {}

/**
 * How a sent command ended: `undefined` once the rules applied it, the rejection they refused it
 * with, or `CommandDropped` if it never reached them.
 */
export type Settled<Refusal> = Refusal | CommandDropped | undefined;

/**
 * A decision a player makes outside what their device holds, named in the imperative: "choose
 * upgrade", "continue lesson". The app sends one, and the run applies it at the start of its
 * next step, through the simulation's `apply` handler of the same name. A run changes in no
 * other way: device input and commands both arrive at a step, so a replay or a lockstep peer
 * that gets the same ones computes the same run.
 *
 * ```ts
 * export class Boost extends Game.Command("Boost", { by: Schema.Number }) {}
 *
 * yield* engine.send(new Boost({ by: 4 }));
 * ```
 *
 * A command the rules may refuse lists how, as `Game.Rejection` classes, in `rejects`. Its
 * handler returns one of them, and the sender gets it as a typed failure:
 *
 * ```ts
 * export class ChooseUpgrade extends Game.Command(
 *   "ChooseUpgrade",
 *   { offer: Schema.Int, index: Schema.Int },
 *   { rejects: [OfferClosed] }
 * ) {}
 * ```
 */
export const make = <
  const Tag extends string,
  const F extends Fields = NoFields,
  const Rejects extends readonly AnyRejection[] = readonly [],
>(
  tag: Tag,
  fields?: F,
  options?: {
    /** The rejections the rules may refuse this command with. */
    readonly rejects?: Rejects;
  }
): CommandClass<Tag, F, Rejects> => {
  // TaggedClass's own type depends on its `Self`, which is only known once this returns.
  const Base = Schema.TaggedClass<CommandInstance<Tag, F>>(tag)(
    tag,
    fields ?? ({} as F)
  ) as unknown as new (...args: never[]) => object;
  return class extends Base {
    static readonly kind = "Command" as const;
    static readonly tag: Tag = tag;
    static readonly rejects = options?.rejects ?? [];
  } as unknown as CommandClass<Tag, F, Rejects>;
};
