/**
 * The view bridge connects a game's menus and HUD to the game, whatever UI
 * library they are built with.
 *
 *   // What the UI may see, and its value before the game publishes anything.
 *   const Hud = View.define("game/Hud", { score: 0, lives: 3 })
 *
 *   // The game publishes its value, once per frame.
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
 *   // The UI receives the bridge, and nothing else.
 *   const ui = View.makeBridge()
 *   ui.subscribe(Hud, ({ score }) => { label.textContent = `${score}` })
 *   button.onclick = () => ui.send(NewGame, {})
 *
 *   Browser.runMain(
 *     App.run(App.define({ plugins: [Game] }), {}, { hz: 60 }).pipe(Effect.provide(View.layer(ui)))
 *   )
 *
 * A view is a value the game exposes to the UI. It is published from the frame
 * stage, once per frame, and only when it differs from the value the UI already
 * has, so an unchanged value costs the UI nothing.
 *
 * The UI acts by sending actions, like any other input source. What it sends is
 * issued in the input stage, before the next tick, and is logged, so a replay
 * needs no UI.
 *
 * Neither side holds the other. The UI holds the bridge, which holds values but
 * no world; the game publishes to whoever is listening, and when no one is, on
 * a server or in a replay, it publishes and computes nothing. A game with a UI
 * and the same game without one have the same hash, log and save, given the
 * same actions.
 */
import { Context, Effect, Equal, Layer } from "effect";

import * as Action from "./Action";
import * as Plugin from "./Plugin";
import { World } from "./Services";
import * as System from "./System";

// --- a view ----------------------------------------------------------------------

/**
 * A value the UI may see: its name, and its value before the game publishes.
 *
 * @category Models
 */
export interface View<A> {
  readonly name: string;
  readonly initial: A;
}

/**
 * Declares a value the UI may see. `initial` is the UI's value until the game
 * first publishes, and determines its type:
 *
 *   const Menu = View.define("game/Menu", { phase: "title" as Phase })
 *
 * A view is only a key, with no part of the game in it, so the UI can import
 * the module that declares it, along with the actions it may send.
 *
 * Its value is plain data (strings, numbers, booleans, and arrays and objects
 * of them), and two values are compared as data. Its name is its identity on a
 * bridge, which refuses two different views with the same name.
 *
 * @category Constructors
 */
export const define = <A>(name: string, initial: A): View<A> => ({
  name,
  initial,
});

// --- the bridge ------------------------------------------------------------------

/** Omitted for an action that takes no payload. */
type PayloadArgument<P> = undefined extends P ? [payload?: P] : [payload: P];

/**
 * An action the UI requested, waiting for the input stage.
 *
 * @category Models
 */
export interface Sent {
  readonly action: Action.AnyActionDef;
  readonly payload: unknown;
}

/**
 * What the UI receives: the game's views, and a way to request actions.
 *
 * @category Models
 */
export interface Bridge {
  /**
   * Returns a view's last published value, or its initial value. It is the same
   * object until the view is published with a different value, so you can
   * compare it with `===`.
   */
  readonly get: <A>(view: View<A>) => A;
  /**
   * Calls `listener` each time a view is published with a new value, and
   * returns a function that unsubscribes. It isn't called with the current
   * value: read that with `get`. A listener that throws fails the frame, like
   * any bug in the frame stage, after every other listener has been called.
   */
  readonly subscribe: <A>(
    view: View<A>,
    listener: (value: A) => void
  ) => () => void;
  /**
   * Requests an action from the game. It is issued before the game's next tick,
   * logged, and applied or refused by its handler, just as a key bound to it
   * would be.
   *
   * An action the game has no handler for is a bug, and throws here, where it
   * was sent. If it is sent before the game is created, when that can't be
   * known yet, it throws in the game's first input stage.
   */
  readonly send: <N extends string, P>(
    action: Action.ActionDef<N, P>,
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
  readonly view: View<unknown>;
  value: unknown;
  /** Each of the slot's view: handed its value, and nothing else. */
  readonly listeners: Set<(value: never) => void>;
}

/**
 * Makes a bridge. The entry point creates one, passes it to the UI, and
 * provides it to the game with `View.layer`:
 *
 *   const ui = View.makeBridge()
 *   mountMenu(document.body, ui)
 *   Browser.runMain(
 *     App.run(App.define({ plugins: [Game] }), {}, { hz: 60 }).pipe(Effect.provide(View.layer(ui)))
 *   )
 *
 * It holds the views' values, their listeners and the actions waiting to be
 * issued, and nothing of the world. A UI can mount on it before the game is
 * created, and sees every view at its initial value until then.
 *
 * @category Constructors
 */
export const makeBridge = (): Bridge => {
  const slots = new Map<string, Slot>();
  let sent: Sent[] = [];
  // Which actions the game handles, once a game is there to say.
  let handles: ((action: Sent["action"]) => boolean) | undefined;
  const slotOf = (view: View<unknown>): Slot => {
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
              listener(value as never);
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
 * The bridge a game publishes to and receives actions from. A
 * `Context.Reference` whose default is no UI at all, which is the case on a
 * server, in a replay and in most tests: nothing is published, and no view is
 * even computed. A page provides one with `View.layer`.
 */
export const Bridge: Context.Reference<Bridge> = Context.Reference<Bridge>(
  "arcadekit/View.Bridge",
  { defaultValue: () => noBridge }
);

/**
 * Returns a layer that provides a bridge to the game:
 * `Effect.provide(View.layer(ui))`.
 *
 * @category Layers
 */
export const layer = (bridge: Bridge): Layer.Layer<never> =>
  Layer.succeed(Bridge, bridge) as Layer.Layer<never>;

// --- the app's end of the bridge ---------------------------------------------------

/**
 * The app's end of the bridge to a UI, through which frame-stage systems
 * publish views.
 *
 * @category Services
 */
export interface PortShape {
  /** Whether a UI is listening. False on a server, in a replay, and in most tests. */
  readonly connected: boolean;
  /**
   * Publishes a view: sets its value and notifies the UI, unless the value is
   * unchanged. Returns whether it was published. For the stages between ticks;
   * during the tick it throws.
   */
  readonly publish: <A>(view: View<A>, value: A) => boolean;
  /**
   * The actions the UI sent since this was last asked.
   * @internal
   */
  readonly take: () => readonly Sent[];
}

/**
 * An app's end of the bridge. `View.plugin` provides it, `View.publish` drives
 * it, and your own frame system can publish through it: `(yield*
 * View.Port).publish(Hud, value)`.
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

/** Issues the UI's requests as actions, before the tick: input like any other. */
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
 * Connects an app to the bridge it was given. A plugin whose systems are made
 * with `View.publish`, or whose UI sends actions, lists it in `plugins`.
 *
 * - The UI's requests are issued in the input stage, just before a tick, in the
 *   order they were sent, with `Actions.enqueue`: logged, and applied at the
 *   start of the tick.
 * - An action the app has no handler for is a bug. The bridge learns which
 *   actions the app handles when the app is created, and `send` throws for any
 *   other; one sent before that throws here, in the app's first input stage.
 * - Without a bridge, the plugin does nothing.
 *
 * @category Plugins
 */
export const plugin = Plugin.make("arcadekit/View", {
  layer: portLayer,
  systems: [Send],
});

/**
 * Makes a frame-stage system that publishes a view: each frame it computes the
 * value and, if it differs from the UI's, publishes it.
 *
 *   const ShowHud = View.publish(Hud, function*() {
 *     const score = yield* Score
 *     return { score: score.points, lives: score.lives }
 *   })
 *
 * - The body can read whatever a frame-stage system can: singletons, states,
 *   queries, events and assets. It can't change the game.
 * - Values are compared as data, field by field at any depth, so the body can
 *   return a new object every frame and the UI is only notified when a field
 *   differs.
 * - Several ticks within one frame produce one publication, of the latest
 *   value.
 * - When no UI is listening, the body doesn't run at all.
 * - It accepts `System.runIf` like any system: a view that isn't published
 *   keeps its last value, which suits a view that is expensive to compute and
 *   is refreshed occasionally. For a view that belongs to one part of the game
 *   and shouldn't show elsewhere, add `System.otherwise(View.reset(view))`.
 * - The system is named `View.publish(<the view's name>)`. Use one per view.
 *
 * @category Systems
 */
export const publish = <
  A,
  Eff extends Effect.Effect<unknown, unknown, unknown>,
>(
  view: View<A>,
  body: () => Generator<Eff, A, never>
): System.System<System.GenError<Eff>, System.GenServices<Eff> | Port> => {
  const read = Effect.gen(body);
  return System.make(`View.publish(${view.name})`, function* () {
    const port = yield* Port;
    if (port.connected) {
      port.publish(view, yield* read);
    }
  }).pipe(System.inStage("frame")) as System.System<
    System.GenError<Eff>,
    System.GenServices<Eff> | Port
  >;
};

/**
 * Publishes a view's initial value again: what a UI should show for a view
 * whose part of the game isn't active.
 *
 *   const ShowHud = View.publish(Hud, readHud).pipe(
 *     System.runIf(State.is(Phase, "playing")),
 *     System.otherwise(View.reset(Hud))
 *   )
 *
 * A view that isn't published keeps its last value, so the score of a level the
 * player left would stay on screen. Passed to `System.otherwise`, this
 * publishes the initial value instead while the system doesn't run. The UI is
 * notified once, as for any value: after that, the value is unchanged. Like
 * publishing, it is for the stages between ticks.
 *
 * @category Utilities
 */
export const reset = <A>(view: View<A>): Effect.Effect<void, never, Port> =>
  // Where no UI is there, this publishes to nobody.
  Effect.map(Effect.service(Port), (port) => {
    port.publish(view, view.initial);
  });
