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
 *   const Arcade = App.define({ plugins: [Game] })
 *
 *   // The UI receives the bridge, and nothing else.
 *   const ui = View.makeBridge(Arcade)
 *   ui.subscribe(Hud, ({ score }) => { label.textContent = `${score}` })
 *   button.onclick = () => ui.send(NewGame, {})
 *
 *   Browser.runMain(
 *     Driver.run(App.make(Arcade), { hz: 60 }).pipe(Effect.provide(View.layer(ui)))
 *   )
 *
 * A view is a value the game exposes to the UI. It is published from the frame
 * stage, once per frame, and only when it differs from the value the UI already
 * has. An unchanged value costs the UI nothing.
 *
 * The UI acts by sending actions, like any other input source. A bridge is made
 * from its game, and sends only the actions the game has a handler for. Any
 * other action doesn't compile. What the bridge sends is issued in the input
 * stage, before the next tick, and is logged, so a replay needs no UI.
 *
 * Neither side holds the other. The UI holds the bridge, which holds values but
 * no world. The game publishes to whoever is listening. When no one is, on a
 * server or in a replay, it publishes and computes nothing. Given the same
 * actions, a game with a UI and the same game without one have the same hash,
 * log and save.
 */
import { Context, Effect, Equal, Layer } from "effect";

import * as Action from "./Action";
import * as Plugin from "./Plugin";
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
 * Its value is plain data, made of strings, numbers, booleans, and arrays and
 * objects of them. Two values are compared as data. Its name is its identity on
 * a bridge, which refuses two different views with the same name.
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
type PayloadOf<D> = D extends Action.ActionDef<string, infer P> ? P : never;
/** The actions of a union of handlers. Distributive: none for no handler. */
type ActionOf<HU> = HU extends Action.AnyHandler ? HU["action"] : never;

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
 * What the UI receives: the game's views, and a way to request the actions
 * `Sends`.
 *
 * `View.makeBridge(game)` makes one whose actions are every action the game
 * has a handler for. A UI names the actions it sends, as
 * `View.Bridge<typeof Start | typeof Quit>`, and is handed a bridge only if its
 * game handles each of them. A `View.Bridge` with no actions reads views and
 * sends nothing.
 *
 * @typeParam Sends the actions it sends
 *
 * @category Models
 */
export interface Bridge<
  // Without `in`, the compiler takes a bridge for one that sends more.
  in Sends extends Action.AnyActionDef = never,
> {
  /**
   * Returns a view's last published value, or its initial value. It is the same
   * object until the view is published with a different value, so you can
   * compare it with `===`.
   */
  readonly get: <A>(view: View<A>) => A;
  /**
   * Calls `listener` each time a view is published with a new value, and
   * returns a function that unsubscribes. It isn't called with the current
   * value, which `get` reads. A listener that throws fails the frame, like any
   * bug in the frame stage, after every other listener has been called.
   */
  readonly subscribe: <A>(
    view: View<A>,
    listener: (value: A) => void
  ) => () => void;
  /**
   * Requests one of the bridge's actions from the game, with its payload. It is
   * issued before the game's next tick, logged, and applied or refused by its
   * handler, just as a key bound to it would be.
   */
  readonly send: <D extends Action.AnyActionDef>(
    // Not `D extends Sends`, under which an action of no handler that takes
    // no payload is reported as a payload missing.
    action: D & Sends,
    ...payload: PayloadArgument<PayloadOf<D>>
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
}

const NOTHING: readonly Sent[] = Object.freeze([]);

interface Slot {
  readonly view: View<unknown>;
  value: unknown;
  /** Each of the slot's view: handed its value, and nothing else. */
  readonly listeners: Set<(value: never) => void>;
}

/**
 * Makes the bridge of a game. The entry point makes one, hands it to the UI,
 * and provides it to the game's app with `View.layer`:
 *
 *   const Arcade = App.define({ plugins: [Game] })
 *   const ui = View.makeBridge(Arcade)
 *   mountMenu(document.body, ui)
 *   Browser.runMain(
 *     Driver.run(App.make(Arcade), { hz: 60 }).pipe(Effect.provide(View.layer(ui)))
 *   )
 *
 * The game gives the bridge its type. The bridge sends every action the game
 * has a handler for, its plugins' among them, and no other. It holds the views'
 * values, their listeners and the actions waiting to be issued, and nothing of
 * the game or its world. A UI can mount on it before the app is made, and sees
 * every view at its initial value until then.
 *
 * **Gotchas**
 *
 * - Provided to the app of another game, it can send an action that app has
 *   no handler for, which throws in the app's input stage. Provide it to an
 *   app of the game it was made from.
 *
 * @param game a game, as `App.define` makes it
 *
 * @category Constructors
 */
export function makeBridge<
  H extends readonly Action.AnyHandler[],
  P extends readonly Plugin.Any[],
>(game: {
  readonly handlers: readonly [...H];
  readonly plugins: readonly [...P];
  // A game has a version, and a plugin has none.
  readonly version: number;
}): Bridge<ActionOf<H[number] | Plugin.HandlerOf<P[number]>>>;
// A bridge takes nothing from its game but the type.
export function makeBridge(): Bridge<Action.AnyActionDef> {
  const slots = new Map<string, Slot>();
  let sent: Sent[] = [];
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
  };
}

const noBridge: Bridge = {
  get: (view) => view.initial,
  subscribe: () => () => {},
  // Its type sends no action: only a cast reaches this.
  send() {
    throw new Error(
      "An action was sent to the bridge that stands for no UI. Make one with View.makeBridge(game) and provide it to the game with View.layer."
    );
  },
  _publish: () => false,
  _take: () => NOTHING,
};

/**
 * The bridge a game publishes to and receives actions from. It is a
 * `Context.Reference` whose default stands for no UI, as on a server, in a
 * replay and in most tests. With the default, nothing is published, and no
 * view is computed. A page provides a bridge with `View.layer`.
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
   * Publishes a view. It sets the view's value and notifies the UI, unless the
   * value is unchanged, and returns whether it published. A system of the frame
   * stage publishes, and a system of the tick can't require `View.Port`.
   */
  readonly publish: <A>(view: View<A>, value: A) => boolean;
}

/**
 * The actions a UI has sent, for the input stage. Publishing is `View.Port`,
 * which a system of the input stage cannot require.
 *
 * @internal
 */
export class Intake extends Context.Service<
  Intake,
  { readonly take: () => readonly Sent[] }
>()("arcadekit/View.Intake") {}

interface PortValue extends PortShape {
  readonly take: () => readonly Sent[];
}

/**
 * An app's end of the bridge. `View.plugin` provides it, `View.publish`
 * publishes through it, and so can your own frame system.
 *
 *   (yield* View.Port).publish(Hud, value)
 *
 * @category Services
 */
export class Port extends Context.Service<Port, PortShape>()(
  "arcadekit/View.Port"
) {}

const portLayer = Layer.unwrap(
  Effect.gen(function* () {
    const bridge = yield* Bridge;
    const port: PortValue = {
      connected: bridge !== noBridge,
      publish(view, value) {
        return bridge._publish(view, value);
      },
      take: () => bridge._take(),
    };
    return Layer.mergeAll(
      Layer.succeed(Port, port),
      Layer.succeed(Intake, { take: () => port.take() })
    );
  })
);

/** Issues the UI's requests as actions, before the tick: input like any other. */
const Send = System.input("arcadekit/View.Send", function* () {
  const sent = (yield* Intake).take();
  if (sent.length === 0) {
    return;
  }
  const { enqueue } = yield* Action.Actions;
  for (const one of sent) {
    enqueue(one.action, one.payload);
  }
});

/**
 * Connects an app to the bridge it was given. A plugin whose systems are made
 * with `View.publish`, or whose UI sends actions, lists it in `plugins`.
 *
 * - The UI's requests are issued in the input stage, just before a tick, in the
 *   order they were sent, with `Actions.enqueue`: logged, and applied at the
 *   start of the tick.
 * - Without a bridge, the plugin does nothing.
 *
 * @category Plugins
 */
export const plugin = Plugin.make("arcadekit/View", {
  layer: portLayer,
  systems: [Send],
});

/**
 * Makes a frame-stage system that publishes a view. Each frame it computes the
 * value, and publishes it if it differs from the UI's.
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
 * - It accepts `System.runIf` like any system. A view that isn't published
 *   keeps its last value, which suits a view that is expensive to compute and
 *   refreshed occasionally. For a view that belongs to one part of the game
 *   and shouldn't show elsewhere, add `System.otherwise(View.reset(view))`.
 * - The system is named `View.publish(<the view's name>)`. Use one per view.
 *
 * @category Systems
 */
export function publish<
  A,
  Eff extends Effect.Effect<unknown, unknown, unknown>,
>(
  view: View<A>,
  body: System.FrameBody<Eff, A>
): System.System<
  System.GenError<Eff>,
  System.GenServices<Eff> | Port,
  string,
  "frame"
>;
export function publish<
  A,
  Eff extends Effect.Effect<unknown, unknown, unknown>,
>(
  view: View<A>,
  body: () => Generator<Eff, A, never>
): System.System<
  System.GenError<Eff>,
  System.GenServices<Eff> | Port,
  string,
  "frame"
> {
  const read = Effect.gen(body);
  return System.raw(`View.publish(${view.name})`, "frame", function* () {
    const port = yield* Port;
    if (port.connected) {
      port.publish(view, yield* read);
    }
  });
}

/**
 * Publishes a view's initial value again, which is what a UI should show for a
 * view whose part of the game isn't active.
 *
 *   const ShowHud = View.publish(Hud, readHud).pipe(
 *     System.runIf(State.is(Phase, "playing")),
 *     System.otherwise(View.reset(Hud))
 *   )
 *
 * A view that isn't published keeps its last value, so the score of a level the
 * player left would stay on screen. Passed to `System.otherwise`, this
 * publishes the initial value instead while the system doesn't run. The UI is
 * notified once, as for any value, since after that the value is unchanged.
 * Like publishing, it is for the stages between ticks.
 *
 * @category Utilities
 */
export const reset = <A>(view: View<A>): Effect.Effect<void, never, Port> =>
  // Where no UI is there, this publishes to nobody.
  Effect.map(Effect.service(Port), (port) => {
    port.publish(view, view.initial);
  });
