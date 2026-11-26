/**
 * Events let systems and handlers signal that something happened,
 * without knowing about each other.
 *
 *   const Collided = Event.define("physics/Collided", Schema.Struct({ a: EntityId, b: EntityId }))
 *
 *   // in a system of the tick
 *   const collided = yield* Collided.emits
 *   collided.emit({ a, b })                 // plain call, fine inside loops
 *   for (const hit of collided.read()) ...  // unseen ones, from before this run
 *
 *   // in any stage
 *   for (const hit of (yield* Collided).read()) ...
 *
 * Every system sees every event exactly once, whatever order the systems run
 * in. A system that runs before the emitter sees the event on the next tick,
 * so an event emitted while systems run is kept until the end of the
 * following tick. The emitter itself reads the event on its next run. A
 * system or a handler reads only what was emitted before its run began, so
 * an entity that an event names is spawned by the time the event is read. An
 * event that a dispatched action's handler emits between ticks is dropped at
 * the end of the next tick.
 *
 * Only the simulation emits. No log holds an event, so code outside the
 * simulation issues an action whose handler emits the event.
 *
 * A system that `System.runIf` has disabled misses the events of the ticks it
 * skipped. When it runs again, those events are gone, and so are the changes
 * its change queries would have seen in them.
 *
 * The event's schema gives the payload its type. Emitting is a plain call
 * that validates nothing. The schema converts a payload to JSON only when the
 * event leaves the program: in a save, which holds the events waiting to be
 * read, or through `Event.encode` and `Event.decode`, for a tool.
 */
import { Cause, Data, Effect, Effectable, Exit, Schema } from "effect";

import type { WithSpawned } from "./ecs/spawned.ts";
import { EventBus, defining } from "./internal/eventBus.ts";
import { Events } from "./Services.ts";
import type { Sim } from "./Services.ts";

/**
 * The handle to one event type that `yield* SomeEvent` gives the code of any
 * stage, which reads the events its holder has not seen yet. To emit, the
 * code of the tick asks for `yield* SomeEvent.emits`.
 *
 * @category Models
 */
export interface Reader<P> {
  /**
   * Returns the events not yet seen through this handle, oldest first. In the
   * tick, they are the events emitted before the code reading them began to
   * run.
   */
  readonly read: () => readonly P[];
}

/**
 * The handle to one event type that `yield* SomeEvent.emits` gives the code
 * of the tick: a system of the tick, a handler or a plugin's setup. It emits
 * events and reads the ones its holder hasn't seen yet. The holder reads its
 * own events on its next run.
 *
 * @category Models
 */
export interface Emitter<P> extends Reader<P> {
  /**
   * Queues an event. It is a plain synchronous call, so a query loop can make
   * it. It is a method, so a handle of any payload is an
   * `Emitter<unknown>`. An entity in the payload may be one that
   * `Commands.spawn` returned, since the event is read once that entity is
   * placed.
   */
  emit(payload: WithSpawned<P>): void;
}

/**
 * An event type, as `Event.define` makes it. It is an Effect, and `yield*`
 * returns its `Event.Reader` in the current app.
 *
 * @category Models
 */
export class Event<P> extends Effectable.Class<Reader<P>, never, Events> {
  readonly name: string;
  /** Converts a payload to and from JSON. Derived from the event's schema. */
  readonly codec: Schema.Codec<P, unknown>;
  private effect: Effect.Effect<Reader<P>, never, Events> | undefined;
  private emitting: Effect.Effect<Emitter<P>, never, Events | Sim> | undefined;

  constructor(name: string, codec: Schema.Codec<P, unknown>) {
    super();
    this.name = name;
    this.codec = codec;
    defining(this as Event<unknown>);
  }

  asEffect(): Effect.Effect<Reader<P>, never, Events> {
    return (this.effect ??= Effect.map(Effect.service(Events), (bus) => {
      const handle = bus.handle(this);
      return { read: () => handle.read() };
    }));
  }

  /**
   * The same events, with `emit`. Asking for it adds `Sim` to the system's
   * requirements, and a system of the frame or input stage that requires
   * `Sim` doesn't compile.
   */
  get emits(): Effect.Effect<Emitter<P>, never, Events | Sim> {
    return (this.emitting ??= Effect.map(Effect.service(Events), (bus) => {
      if (!(bus instanceof EventBus)) {
        throw new Error(
          `${this.name}.emits was asked for outside the tick. The frame stage and the input stage read events, and only the tick emits.`
        );
      }
      return bus.handle(this);
    }));
  }
}

/**
 * Defines an event type, with the schema of its payload. The payload type is
 * inferred from the schema:
 * `Event.define("physics/Collided", Schema.Struct({ ... }))`. An event with no
 * payload takes only its name, `Event.define("game/Started")`, and is emitted
 * with `undefined`.
 *
 * **Gotchas**
 *
 * An event's name identifies it in an app and in a save, so prefix each name
 * with its feature. When two different events share a name, the second throws
 * the first time an app uses it.
 *
 * @category Constructors
 */
export function define(name: string): Event<void>;
export function define<S extends Schema.Codec<unknown, unknown>>(
  name: string,
  payload: S
): Event<S["Type"]>;
export function define(
  name: string,
  payload: Schema.Codec<unknown, unknown> = Schema.Void
): Event<unknown> {
  return new Event<unknown>(name, Schema.toCodecJson(payload));
}

/**
 * An event's payload couldn't be encoded to JSON, or decoded from it.
 *
 * @category Errors
 */
export class Invalid extends Data.TaggedError("EventInvalid")<{
  readonly event: string;
  /** What was wrong, as the schema reported it. */
  readonly message: string;
}> {}

const convert = <P, A>(
  def: Event<P>,
  run: (codec: Schema.Codec<P, unknown>) => Exit.Exit<A, unknown>
): Exit.Exit<A, Invalid> => {
  const exit = run(def.codec);
  if (Exit.isSuccess(exit)) {
    return Exit.succeed(exit.value);
  }
  const error = Cause.squash(exit.cause);
  return Exit.fail(
    new Invalid({
      event: def.name,
      message: error instanceof Error ? error.message : String(error),
    })
  );
};

/**
 * Encodes an event's payload to the JSON form a save holds it in, for a tool
 * or a message to another program. Fails with `Event.Invalid` when the event's
 * schema rejects the payload.
 *
 * @category Codecs
 */
export const encode = <P>(
  def: Event<P>,
  payload: P
): Exit.Exit<unknown, Invalid> =>
  convert(def, (codec) => Schema.encodeUnknownExit(codec)(payload));

/**
 * Decodes an event's payload from its JSON form, and validates it against the
 * event's schema. Fails with `Event.Invalid` when the data doesn't match the
 * schema.
 *
 * @category Codecs
 */
export const decode = <P>(
  def: Event<P>,
  data: unknown
): Exit.Exit<P, Invalid> =>
  convert(def, (codec) => Schema.decodeUnknownExit(codec)(data));

/**
 * The name of the store that holds an app's waiting events, as a snapshot
 * lists it in `readSnapshot(save.world).stores`. Each entry of the store is
 * `{ name, waiting, read }`: the event's name, the waiting events in JSON form
 * with the oldest first, and how many of them each system and handler has
 * read.
 *
 * @category Constants
 */
export const STORE = "arcadekit/events";

/**
 * The app's events as `yield* Events` hands them, which read and have no
 * `emit`. A system of the tick emits through an event's `emits`.
 *
 * @category Models
 */
export interface ReadingEvents {
  /** Returns a handle to an event type, which reads it. */
  handle<P>(def: Event<P>): Reader<P>;
}
