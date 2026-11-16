/**
 * A page's devices: the keyboard, the pointer and the gamepads. This is the
 * package's `arcadekit/Input/Browser` entry, for a program that runs in a
 * page.
 *
 *   import * as InputBrowser from "arcadekit/Input/Browser"
 *
 *   App.run(...).pipe(Effect.provide(InputBrowser.layer({ target: canvas })))
 *
 * `runMain` of `arcadekit/App/Browser` provides it, with the page's display.
 */
import { Effect, Layer } from "effect";

import * as Input from "../Input";

/** As much of a gamepad as is read: the browser's `Gamepad` is one. */
export interface GamepadLike {
  readonly index: number;
  readonly connected: boolean;
  readonly buttons: ArrayLike<{ readonly pressed: boolean }>;
  readonly axes: ArrayLike<number>;
}

/** As much of an element as the pointer is measured against. */
export interface PointerTarget extends EventTarget {
  readonly getBoundingClientRect?: () => {
    readonly left: number;
    readonly top: number;
  };
}

export interface Options {
  /**
   * What the pointer is pressed on, and what its place is measured from:
   * `PointerX` and `PointerY` are CSS pixels from its top left corner.
   * The window, when left out.
   */
  readonly target?: PointerTarget;
  /**
   * The codes of the keys whose usual effect in the page is prevented, such
   * as the arrows and the space bar, which scroll it.
   */
  readonly preventDefault?: readonly string[];
  /**
   * How far from its middle a gamepad's axis has to be to count: nearer
   * than this is 0. The default is 0.1. What counts is rounded to two
   * decimals, so that a stick held still does not report every frame.
   */
  readonly deadzone?: number;
  /** Where keys and the pointer's moves are listened for. The window, when left out. */
  readonly window?: EventTarget;
  /** The gamepads, read once per sample. `navigator.getGamepads`, when left out. */
  readonly gamepads?: () => ArrayLike<GamepadLike | null>;
}

const isPad = (code: string): boolean => code.startsWith("Pad");
const isPointer = (code: string): boolean => code.startsWith("Pointer");

const listen = (
  options: Options
): { readonly source: Input.SourceShape; readonly stop: () => void } => {
  const state = Input.makeManualSource();
  const page: EventTarget = options.window ?? globalThis;
  const target: PointerTarget = options.target ?? page;
  const prevented = new Set(options.preventDefault ?? []);
  const deadzone = options.deadzone ?? 0.1;
  const gamepads =
    options.gamepads ??
    ((): ArrayLike<GamepadLike | null> =>
      typeof navigator !== "undefined" &&
      typeof navigator.getGamepads === "function"
        ? navigator.getGamepads()
        : []);
  const stops: (() => void)[] = [];
  const on = <E extends Event>(
    where: EventTarget,
    type: string,
    listener: (event: E) => void
  ): void => {
    where.addEventListener(type, listener as EventListener);
    stops.push(() =>
      where.removeEventListener(type, listener as EventListener)
    );
  };
  on(page, "keydown", (event: KeyboardEvent) => {
    if (prevented.has(event.code)) {
      event.preventDefault();
    }
    // A key held down repeats; it went down once.
    if (!event.repeat) {
      state.press(event.code);
    }
  });
  on(page, "keyup", (event: KeyboardEvent) => {
    if (prevented.has(event.code)) {
      event.preventDefault();
    }
    state.release(event.code);
  });
  // A page that loses the keyboard is not told when a key goes up.
  on(page, "blur", () => state.releaseAll((code) => !isPad(code)));
  const place = (event: PointerEvent): void => {
    const box = target.getBoundingClientRect?.();
    state.move(Input.pointerX, event.clientX - (box?.left ?? 0));
    state.move(Input.pointerY, event.clientY - (box?.top ?? 0));
  };
  on(target, "pointerdown", (event: PointerEvent) => {
    place(event);
    state.press(Input.pointerButton(event.button));
  });
  // On the page, so that a button let go outside the target is let go.
  on(page, "pointermove", place);
  on(page, "pointerup", (event: PointerEvent) => {
    place(event);
    state.release(Input.pointerButton(event.button));
  });
  on(page, "pointercancel", () => state.releaseAll(isPointer));

  // Gamepads send no events worth having: they are read when sampled.
  let known = new Set<string>();
  const round = (value: number): number =>
    Math.abs(value) < deadzone ? 0 : Math.round(value * 100) / 100;
  const readPads = (): void => {
    const seen = new Set<string>();
    const pads = gamepads();
    for (let p = 0; p < pads.length; p++) {
      const pad = pads[p];
      if (pad === null || pad === undefined || !pad.connected) {
        continue;
      }
      for (let b = 0; b < pad.buttons.length; b++) {
        const code = Input.padButton(pad.index, b);
        seen.add(code);
        if (pad.buttons[b]!.pressed) {
          state.press(code);
        } else {
          state.release(code);
        }
      }
      for (let a = 0; a < pad.axes.length; a++) {
        const code = Input.padAxis(pad.index, a);
        seen.add(code);
        state.move(code, round(pad.axes[a]!));
      }
    }
    // A gamepad that was unplugged lets go of everything.
    for (const code of known) {
      if (!seen.has(code)) {
        state.release(code);
        state.move(code, 0);
      }
    }
    known = seen;
  };
  let stopped = false;
  return {
    source: {
      sample() {
        if (stopped) {
          throw new Error(
            "The page's devices were read after their layer was let go: its listeners are gone, so it would say nothing for ever. A layer lasts as long as what it is provided to. Provide it to the whole program, as runMain of arcadekit/App/Browser does, or with App.run(...).pipe(Effect.provide(InputBrowser.layer())), not to App.make alone."
          );
        }
        readPads();
        return state.sample();
      },
    },
    stop() {
      stopped = true;
      for (const stop of stops) {
        stop();
      }
    },
  };
};

/**
 * The devices of a page, as where an app's input stage takes its samples
 * from (`Input.Source`).
 *
 * - A key's code is `KeyboardEvent.code`. A key held down went down once,
 *   and every key and pointer button goes up when the page loses focus.
 * - `PointerX` and `PointerY` are CSS pixels from the top left of `target`.
 *   Presses are heard on `target`, moves and releases on the whole page.
 * - Gamepads are read when the app samples, once per tick.
 * - It listens from when it is built until its scope closes, so provide it
 *   to the whole program and not to `App.make` alone.
 */
export const layer = (options: Options = {}): Layer.Layer<never> =>
  Layer.effect(
    Input.Source,
    Effect.map(
      Effect.acquireRelease(
        Effect.sync(() => listen(options)),
        (listening) => Effect.sync(listening.stop)
      ),
      (listening) => listening.source
    )
  ) as Layer.Layer<never>;
