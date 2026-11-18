/**
 * The view bridge: how a game's menus and heads-up display see the game
 * and act on it, whatever they are built with.
 *
 *   // What the UI may see, and its value before the game says anything.
 *   const Hud = View.define("game/Hud", { score: 0, lives: 3 })
 *
 *   // The game says what it is, once per frame.
 *   const ShowHud = View.publish(Hud, function*() {
 *     const score = yield* Score
 *     return { score: score.points, lives: score.lives }
 *   })
 *   const Game = Plugin.make("Game", {
 *     plugins: [View.plugin],
 *     systems: [ShowHud],
 *     handlers: [newGame],
 *   })
 *
 *   // The UI is handed the bridge, and nothing else.
 *   const ui = View.makeBridge()
 *   ui.subscribe(Hud, ({ score }) => { label.textContent = `${score}` })
 *   button.onclick = () => ui.send(NewGame, {})
 *
 *   Browser.runMain(
 *     App.run({ plugins: [Game] }, { hz: 60 }).pipe(Effect.provide(View.layer(ui)))
 *   )
 *
 * A view is a value the game lets the UI see. It is published from the
 * frame stage, once per frame, and only when it is not the value the UI
 * already has: a value that did not change costs the UI nothing.
 *
 * The UI acts by sending actions, like every other source of input. What
 * it sends is issued in the input stage, before the next tick, and is in
 * the log: a replay needs no UI.
 *
 * Neither side holds the other. The UI holds the bridge, which holds
 * values and no world; the game publishes to whoever is there, and where
 * nobody is, on a server or in a replay, says nothing and computes
 * nothing. A game with a UI and the same game with none have the same
 * hash, log and save, given the same actions.
 */
import { Context, Effect, Equal, Layer } from "effect";

import * as Action from "./Action";
import * as Plugin from "./Plugin";
import { World } from "./Services";
import * as System from "./System";

// --- a view ----------------------------------------------------------------------

/**
 * A value the UI may see: its name, and what it is before the game has said.
 *
 * @category Models
 */
export interface View<A> {
  readonly name: string;
  readonly initial: A;
}

/**
 * Declares a value the UI may see. `initial` is what the UI has of it
 * until the game first publishes, and gives it its type:
 *
 *   const Menu = View.define("game/Menu", { phase: "title" as Phase })
 *
 * A view is a key and nothing of the game: the module that declares it is
 * one the UI can import, beside the actions it may send.
 *
 * Its value is plain data (text, numbers, booleans, arrays and objects of
 * them), which is what two values are compared as. Its name is its
 * identity on a bridge, which refuses two different views with one name.
 *
 * @category Constructors
 */
export const define = <A>(name: string, initial: A): View<A> => ({
  name,
  initial,
});

// --- the bridge ------------------------------------------------------------------

/** Left out for an action that takes no payload. */
type PayloadArgument<P> = undefined extends P ? [payload?: P] : [payload: P];

/**
 * An action the UI asked for, waiting for the input stage.
 *
 * @category Models
 */
export interface Sent {
  readonly action: Action.ActionDef<string, any, unknown>;
  readonly payload: unknown;
}

/**
 * What a UI is handed: the game's views, and a way to ask for an action.
 *
 * @category Models
 */
export interface Bridge {
  /**
   * A view's value as it was last published, or its initial value. It is
   * the same object until the view is published with another value, so it
   * can be compared with `===`.
   */
  readonly get: <A>(view: View<A>) => A;
  /**
   * Calls `listener` each time a view is published with a new value, and
   * returns what stops it. It is not called with the value the view has
   * now: read that with `get`. A listener that throws fails the frame, as
   * any bug in the frame stage does, once every other listener was told.
   */
  readonly subscribe: <A>(
    view: View<A>,
    listener: (value: A) => void
  ) => () => void;
  /**
   * Asks the game for an action. It is issued before the game's next tick,
   * logged, and applied or refused by its handler, as a key bound to it
   * would be.
   *
   * An action the game has no handler for is a bug, and throws here, where
   * it was sent. Sent before the game is made, when nobody can tell yet, it
   * throws in the game's first input stage.
   */
  readonly send: <N extends string, P>(
    action: Action.ActionDef<N, P, unknown>,
    ...payload: PayloadArgument<P>
  ) => void;
  /**
   * The game's end: sets a view's value and tells its listeners, unless it
   * is the value the view has. Says whether it was.
   * @internal
   */
  readonly _publish: <A>(view: View<A>, value: A) => boolean;
  /**
   * The game's end: the actions sent since this was last asked.
   * @internal
   */
  readonly _take: () => readonly Sent[];
  /**
   * The game's end: says which actions the game has a handler for, from
   * now until what is returned is called. A bridge serves one game at a
   * time: the last to say.
   * @internal
   */
  readonly _connect: (
    handles: (action: Sent["action"]) => boolean
  ) => () => void;
}

const NOTHING: readonly Sent[] = Object.freeze([]);

interface Slot {
  readonly view: View<any>;
  value: unknown;
  readonly listeners: Set<(value: any) => void>;
}

/**
 * Makes a bridge. The entry point makes one, hands it to the UI, and
 * provides it to the game with `View.layer`:
 *
 *   const ui = View.makeBridge()
 *   mountMenu(document.body, ui)
 *   Browser.runMain(
 *     App.run({ plugins: [Game] }, { hz: 60 }).pipe(Effect.provide(View.layer(ui)))
 *   )
 *
 * It holds the views' values, their listeners and the actions waiting to
 * be issued: nothing of the world. A UI can be mounted on it before the
 * game is made, and sees every view at its initial value until then.
 *
 * @category Constructors
 */
export const makeBridge = (): Bridge => {
  const slots = new Map<string, Slot>();
  let sent: Sent[] = [];
  // Which actions the game handles, once a game is there to say.
  let handles: ((action: Sent["action"]) => boolean) | undefined;
  const slotOf = (view: View<any>): Slot => {
    let slot = slots.get(view.name);
    if (slot === undefined) {
      slot = { view, value: view.initial, listeners: new Set() };
      slots.set(view.name, slot);
    } else if (slot.view !== view) {
      throw new Error(
        `Two different views are both named "${view.name}". A view's name identifies it on a bridge, so give each its own, prefixed with the feature it belongs to.`
      );
    }
    return slot;
  };
  return {
    get: (view) => slotOf(view).value as never,
    subscribe(view, listener) {
      const { listeners } = slotOf(view);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    send(action, ...payload) {
      if (handles !== undefined && !handles(action)) {
        throw new Error(
          `The action "${action.name}" was sent to a game that has no handler for it. List its handler in a plugin's handlers, or in the app's.`
        );
      }
      sent.push({ action, payload: payload[0] });
    },
    _publish(view, value) {
      const slot = slotOf(view);
      // Compared as data: an object made anew each frame with the same
      // fields is the same value, and nobody is told.
      if (Equal.equals(slot.value, value)) {
        return false;
      }
      slot.value = value;
      if (slot.listeners.size > 0) {
        // Every listener hears of it, even if one of them throws; the
        // first to throw then fails the frame, as a bug there does.
        let failure: { readonly error: unknown } | undefined;
        // Copied first: a listener may stop itself, or start another.
        for (const listener of Array.from(slot.listeners)) {
          if (slot.listeners.has(listener)) {
            try {
              listener(value);
            } catch (error) {
              failure ??= { error };
            }
          }
        }
        if (failure !== undefined) {
          throw failure.error;
        }
      }
      return true;
    },
    _take() {
      if (sent.length === 0) {
        return NOTHING;
      }
      const taken = sent;
      sent = [];
      return taken;
    },
    _connect(mine) {
      handles = mine;
      return () => {
        // A game that ended after another began leaves the other's.
        if (handles === mine) {
          handles = undefined;
        }
      };
    },
  };
};

const noBridge: Bridge = {
  get: (view) => view.initial,
  subscribe: () => () => {},
  send() {
    throw new Error(
      "An action was sent to the bridge that stands for no UI. Make one with View.makeBridge() and provide it to the game with View.layer."
    );
  },
  _publish: () => false,
  _take: () => NOTHING,
  _connect: () => () => {},
};

/**
 * The bridge a game publishes to and hears from. A `Context.Reference`
 * whose default is no UI at all, which is what a server, a replay and most
 * tests have: nothing is published there, and no view is even worked out.
 * A page provides one with `View.layer`.
 */
export const Bridge: Context.Reference<Bridge> = Context.Reference<Bridge>(
  "arcadekit/View.Bridge",
  { defaultValue: () => noBridge }
);

/**
 * Provides a bridge to the game: `Effect.provide(View.layer(ui))`.
 *
 * @category Layers
 */
export const layer = (bridge: Bridge): Layer.Layer<never> =>
  Layer.succeed(Bridge, bridge) as Layer.Layer<never>;

// --- the app's end of the bridge ---------------------------------------------------

/**
 * The app's end of the bridge to a UI: what a system of the frame stage
 * publishes views through.
 *
 * @category Services
 */
export interface PortShape {
  /** Whether a UI is there to be told. False on a server, in a replay, in most tests. */
  readonly connected: boolean;
  /**
   * Publishes a view: sets its value and tells the UI, unless it is the
   * value the view already has. Says whether it was published. For the
   * stages between ticks; in the tick it throws.
   */
  readonly publish: <A>(view: View<A>, value: A) => boolean;
  /**
   * The actions the UI sent since this was last asked.
   * @internal
   */
  readonly take: () => readonly Sent[];
}

/**
 * An app's end of the bridge. `View.plugin` provides it, `View.publish`
 * works it, and a frame system of the game's own can publish through it:
 * `(yield* View.Port).publish(Hud, value)`.
 *
 * @category Services
 */
export class Port extends Context.Service<Port, PortShape>()(
  "arcadekit/View.Port"
) {}

const portLayer = Layer.effect(
  Port,
  Effect.gen(function* () {
    const bridge = yield* Bridge;
    // Between ticks an app's world is frozen: that is how the stages that
    // may talk to the UI are told from the tick.
    const world = yield* World;
    // From here to the app's end the bridge knows what the game handles,
    // and refuses the rest where it is sent.
    const { handles } = yield* Action.Actions;
    yield* Effect.acquireRelease(
      Effect.sync(() => bridge._connect(handles)),
      (leave) => Effect.sync(leave)
    );
    return {
      connected: bridge !== noBridge,
      publish(view, value) {
        if (!world.frozen) {
          throw new Error(
            `The view "${view.name}" was published in the tick. What the UI sees is no part of the game: a replay and a server have no UI, and a tick must not depend on whether one is there. Publish it from a system of the frame stage, which View.publish makes.`
          );
        }
        return bridge._publish(view, value);
      },
      take: () => bridge._take(),
    };
  })
);

/** Issues what the UI sent as actions, before the tick: input like any other. */
const Send = System.make("arcadekit/View.Send", function* () {
  const sent = (yield* Port).take();
  if (sent.length === 0) {
    return;
  }
  const { enqueue } = yield* Action.Actions;
  for (const one of sent) {
    enqueue(one.action, one.payload);
  }
}).pipe(System.inStage("input"));

/**
 * Connects an app to the bridge it was given. A plugin whose systems are
 * made with `View.publish`, or whose UI sends actions, lists it in
 * `plugins`.
 *
 * - What the UI sent is issued in the input stage, just before a tick, in
 *   the order it was sent, with `Actions.enqueue`: logged, and applied at
 *   the start of the tick.
 * - An action the app has no handler for is a bug. The bridge is told which
 *   the app handles when the app is made, and `send` throws for another;
 *   one sent before that throws here, in the app's first input stage.
 * - Where no bridge was provided the plugin does nothing.
 *
 * @category Plugins
 */
export const plugin = Plugin.make("arcadekit/View", {
  layer: portLayer,
  systems: [Send],
});

/**
 * Makes a system of the frame stage that publishes a view: each frame it
 * works the value out and, if it is not the value the UI has, publishes
 * it.
 *
 *   const ShowHud = View.publish(Hud, function*() {
 *     const score = yield* Score
 *     return { score: score.points, lives: score.lives }
 *   })
 *
 * - The body reads what a system of the frame stage can: singletons,
 *   states, queries, events, assets. It cannot change the game.
 * - Two values are compared as data, field by field and however deep, so
 *   a body returns a new object each frame and the UI is told only when a
 *   field differs.
 * - Several ticks and one frame are one publication, of the latest value.
 * - Where no UI is there, the body is not run at all.
 * - It takes `System.runIf` like any system: a view that is not published
 *   keeps the value it had. That is what a view that is costly to work
 *   out, and is worked out now and then, wants. One that belongs to a
 *   part of the game, and should not be seen when the game is elsewhere,
 *   says `System.otherwise(View.reset(view))`.
 * - The system is named `View.publish(<the view's name>)`. One per view.
 *
 * @category Systems
 */
export const publish = <A, Eff extends Effect.Effect<any, any, any>>(
  view: View<A>,
  body: () => Generator<Eff, A, never>
): System.System<Effect.Error<Eff>, Effect.Services<Eff> | Port> => {
  const read = Effect.gen(body) as Effect.Effect<
    A,
    Effect.Error<Eff>,
    Effect.Services<Eff>
  >;
  return System.make(`View.publish(${view.name})`, function* () {
    const port = yield* Port;
    if (port.connected) {
      port.publish(view, yield* read);
    }
  }).pipe(System.inStage("frame")) as System.System<
    Effect.Error<Eff>,
    Effect.Services<Eff> | Port
  >;
};

/**
 * Publishes a view's first value again, the one it was defined with: what
 * a UI should see of a view whose part of the game is not there.
 *
 *   const ShowHud = View.publish(Hud, readHud).pipe(
 *     System.runIf(State.is(Phase, "playing")),
 *     System.otherwise(View.reset(Hud))
 *   )
 *
 * A view that is not published keeps the value it had, so the score of a
 * level that was left would stay on the screen. Given to
 * `System.otherwise`, this is what is published in its place while the
 * system does not run. The UI is told once, as of any value: said again
 * it is the value the view has. For the stages between ticks, as
 * publishing is.
 *
 * @category Utilities
 */
export const reset = <A>(view: View<A>): Effect.Effect<void, never, Port> =>
  // Where no UI is there, this publishes to nobody.
  Effect.map(Effect.service(Port), (port) => {
    port.publish(view, view.initial);
  });
