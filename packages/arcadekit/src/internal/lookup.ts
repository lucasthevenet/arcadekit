/**
 * What a capability returns. `Query.View(Moving)`, `Event.Emitter(Collided)`
 * and the like each look a definition up in what the running code was given,
 * at once and without waiting. A lookup is an Effect, so `yield*` on it
 * returns what was found, and it goes wherever an Effect goes.
 *
 * In a generator that a fiber runs, `yield*` on a lookup never suspends the
 * generator. Its iterator has finished before it starts: it finds the
 * definition in the running fiber's context and returns. The fiber is not
 * asked, so a lookup costs a call and not a turn of the fiber's loop. Used
 * any other way, as in `app.read(Singleton.Read(Score))`, the fiber
 * evaluates it as it does any Effect.
 */
import { Context, Effect, Effectable, Fiber } from "effect";

/** What the running code was given: the services of its stage. */
export type Given = Context.Context<never>;

/** An iterator that has finished, with what `yield*` on it evaluates to. */
class Found<A> {
  readonly done = true;
  readonly value: A;

  constructor(value: A) {
    this.value = value;
  }

  next(): this {
    return this;
  }
}

const effect = Effectable.Prototype<Lookup<unknown, unknown, never>>({
  label: "arcadekit/Lookup",
  evaluate(fiber) {
    return Effect.succeed(this.look(fiber.context, this.of));
  },
});

/** What `yield*` does on any other Effect: hands it to the fiber, and waits. */
const suspended = effect[Symbol.iterator];

const Base: new <A, R>() => Effect.Effect<A, never, R> = (() => {
  const proto = Object.defineProperties(
    {},
    Object.getOwnPropertyDescriptors(effect)
  );
  Object.defineProperty(proto, Symbol.iterator, {
    configurable: true,
    writable: true,
    value(this: Lookup<unknown, unknown, never>) {
      const fiber = Fiber.getCurrent();
      return fiber === undefined
        ? suspended.call(this)
        : new Found(this.look(fiber.context, this.of));
    },
  });
  const Made = function () {};
  Made.prototype = proto;
  return Made as never;
})();

class Lookup<Of, A, R> extends Base<A, R> {
  readonly look: (given: Given, of: Of) => A;
  readonly of: Of;

  constructor(look: (given: Given, of: Of) => A, of: Of) {
    super();
    this.look = look;
    this.of = of;
  }
}

/**
 * @internal Makes the Effect of looking `of` up with `look`. `R` is what
 * yielding it puts in a system's requirements, which the capability that
 * returns it says.
 */
export const lookup = <Of, A, R>(
  look: (given: Given, of: Of) => A,
  of: Of
): Effect.Effect<A, never, R> => new Lookup<Of, A, R>(look, of);

/** @internal The service of a key, in what the running code was given. */
export const service = <I, S>(given: Given, key: Context.Key<I, S>): S =>
  Context.getUnsafe(given, key);
