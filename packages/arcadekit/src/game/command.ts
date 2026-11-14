/**
 * Commands: the decisions a player makes outside what their device holds.
 *
 * `Game.Command` is a declaration, built as `Game.Event` is: the class is the command's
 * constructor and its Schema. A run changes only at a step, by its input and by the commands the
 * loop applies at the start of the step, so a replay or a lockstep peer that gets the same ones
 * computes the same run. A command the rules gave no answer to is dropped, which is
 * `CommandDropped`, not a rejection.
 *
 * @since 0.7.0
 */
import { Schema } from "effect";
import type { Cause } from "effect";

import type { Fields, NoFields, Payload } from "./event";
import type { AnyRejection } from "./rejection";

/**
 * A value of a command: its `_tag` and its payload.
 *
 * **When to use**
 *
 * Rarely: a game names a command's values by its class, `ChooseUpgrade`.
 *
 * **Example** (A command's value)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class Boost extends Game.Command("Boost", { by: Schema.Number }) {}
 * const boost: Game.CommandInstance<"Boost", { readonly by: typeof Schema.Number }> = new Boost({
 *   by: 4,
 * });
 * boost.by; // => 4
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type CommandInstance<Tag extends string, F extends Fields> = {
  readonly _tag: Tag;
} & Payload<F>;

/**
 * Any class made by `Game.Command`.
 *
 * **When to use**
 *
 * To type a list of a game's commands, as a simulation's `commands` is.
 *
 * **Example** (A list of commands)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 *
 * class Pause extends Game.Command("Pause") {}
 * class Resume extends Game.Command("Resume") {}
 * const commands: readonly Game.AnyCommand[] = [Pause, Resume];
 * commands.map((command) => command.tag); // => ["Pause", "Resume"]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface AnyCommand extends Schema.Top {
  readonly kind: "Command";
  readonly tag: string;
  readonly rejects: readonly AnyRejection[];
  readonly Type: { readonly _tag: string };
  new (...args: never[]): { readonly _tag: string };
}

/**
 * The class `Game.Command` returns: a Schema, the constructor of its values, and the rejections
 * the rules may refuse it with.
 *
 * **When to use**
 *
 * To type a value that is some command's class, as a host that takes one does. A game names its
 * own class.
 *
 * **Example** (What the class holds)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class Boost extends Game.Command("Boost", { by: Schema.Number }) {}
 * const declared: Game.CommandClass<"Boost", { readonly by: typeof Schema.Number }> = Boost;
 * declared.kind; // => "Command"
 * declared.tag; // => "Boost"
 * declared.rejects; // => []
 * ```
 *
 * @category models
 * @since 0.7.0
 */
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

/** The class `Schema.TaggedError` makes for `CommandDropped`, written out for isolatedDeclarations. */
type CommandDroppedClass = Schema.Class<
  CommandDropped,
  Schema.TaggedStruct<
    "CommandDropped",
    {
      readonly command: Schema.String;
      readonly reason: Schema.Literals<readonly ["noRun", "runEnded"]>;
    }
  >,
  Cause.YieldableError
>;

// Named so the type files can be made one file at a time (isolatedDeclarations).
const CommandDroppedBase: CommandDroppedClass =
  // oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError makes a class; it is not an error being thrown.
  Schema.TaggedError<CommandDropped>()("CommandDropped", {
    command: Schema.String,
    reason: Schema.Literals(["noRun", "runEnded"]),
  });

/**
 * A command the rules gave no answer to, neither taking nor refusing it: it was sent with no run
 * (`noRun`), or its run ended first (`runEnded`: a stop, a new run or a crash). `command` is the
 * command's tag.
 *
 * **When to use**
 *
 * Every send can fail with it. An app that only cares what the rules said catches it alone,
 * `Effect.catchTag("CommandDropped", () => Effect.void)`; one that doesn't care how a command ends
 * writes `Effect.ignore`, which hides a refusal too.
 *
 * **Details**
 *
 * After a crash, the command whose handler threw is dropped too, though that handler may have
 * changed the state before it threw: the run is over either way. A command sent again after
 * `runEnded` goes to whichever run is current.
 *
 * In a lockstep run it speaks for the sender's own peer, whose rules gave no answer because its
 * session stopped first. The other peers may still have applied the command: a player the host
 * removes after confirming the step of that player's command is told `runEnded`.
 *
 * **Example** (A command sent with no run)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class Boost extends Game.Command("Boost") {}
 * class Race extends Game.Simulation("Race", {
 *   input: Schema.Null,
 *   commands: [Boost],
 *   create: () => ({ boosts: 0 }),
 *   step: () => {},
 *   apply: {
 *     Boost: (race) => {
 *       race.boosts += 1;
 *     },
 *   },
 * }) {}
 *
 * const loop = Game.makeLoop(Race);
 * let outcome: unknown;
 * loop.send(new Boost(), 0, (settled) => {
 *   outcome = settled;
 * });
 * outcome instanceof Game.CommandDropped; // => true
 * (outcome as Game.CommandDropped).reason; // => "noRun"
 * ```
 *
 * @category errors
 * @since 0.7.0
 */
export class CommandDropped extends CommandDroppedBase {}

/**
 * How a sent command ended: `undefined` once the rules applied it, the rejection they refused it
 * with, or `CommandDropped` if they gave no answer.
 *
 * **When to use**
 *
 * To type the callback a loop's `send` calls, in a host that tells a sender of its own.
 *
 * **Example** (Telling the three apart)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 *
 * const told = (outcome: Game.Settled<Error>): string =>
 *   outcome === undefined
 *     ? "taken"
 *     : outcome instanceof Game.CommandDropped
 *       ? "dropped"
 *       : "refused";
 * told(undefined); // => "taken"
 * told(new Game.CommandDropped({ command: "Boost", reason: "runEnded" })); // => "dropped"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type Settled<Refusal> = Refusal | CommandDropped | undefined;

/**
 * Declares a command: a decision a player makes outside what their device holds, named in the
 * imperative ("choose upgrade", "continue lesson"). The app sends one, and the run applies it at
 * the start of its next step, through the simulation's `apply` handler of the same name.
 *
 * **When to use**
 *
 * For a decision a screen makes: an upgrade picked from a menu, a pause held for the whole
 * party. What a device holds for a step (a stick, a held key) is the simulation's `input`.
 *
 * **Details**
 *
 * A run changes in no other way: device input and commands both arrive at a step, so a replay
 * or a lockstep peer that gets the same ones computes the same run. A command the rules may
 * refuse lists how, as `Game.Rejection` classes in `rejects`, and its handler returns one of
 * them; the sender gets it as a typed failure.
 *
 * **Example** (Declaring a command and sending it)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class Boost extends Game.Command("Boost", { by: Schema.Number }) {}
 * class Race extends Game.Simulation("Race", {
 *   input: Schema.Null,
 *   commands: [Boost],
 *   create: () => ({ speed: 4 }),
 *   step: () => {},
 *   apply: {
 *     Boost: (race, boost) => {
 *       race.speed += boost.by;
 *     },
 *   },
 * }) {}
 *
 * const loop = Game.makeLoop(Race);
 * loop.start(null, 1, 0);
 * loop.send(new Boost({ by: 4 }));
 * // The next step applies it, before `step`.
 * loop.frame({ read: () => null }, { steps: 1 }, 0);
 * loop.state?.speed; // => 8
 * ```
 *
 * @category declarations
 * @since 0.7.0
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
