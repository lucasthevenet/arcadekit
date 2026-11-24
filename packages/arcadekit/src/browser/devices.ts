import * as Input from "../Input";
import type { GamepadLike, Options, PointerTarget } from "./options";

const isPad = (code: string): boolean => code.startsWith("Pad");
const isPointer = (code: string): boolean => code.startsWith("Pointer");

/**
 * Listens to the page's keyboard, pointer and gamepads, for `Browser.layer`'s
 * input source, until stopped.
 *
 * @internal
 */
export const listen = (
  options: Options
): { readonly listener: Input.Listener; readonly stop: () => void } => {
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
  // A page reports one press, when the first button goes down, and one
  // release, when the last goes up. A button that changes while another is
  // held comes as a move, and `buttons` says which are down by then: a bit
  // each, in an order of their own.
  const BITS: readonly (readonly [bit: number, button: number])[] = [
    [1, 0],
    [2, 2],
    [4, 1],
    [8, 3],
    [16, 4],
  ];
  // Whether a press on the target began what is held now.
  let held = false;
  const letGo = (): void => {
    held = false;
    state.releaseAll(isPointer);
  };
  /** Syncs the buttons held down with the ones the page reports. */
  const follow = (buttons: number): void => {
    for (const [bit, button] of BITS) {
      const code = Input.pointerButton(button);
      if ((buttons & bit) === 0) {
        state.release(code);
      } else {
        state.press(code);
      }
    }
  };
  on(target, "pointerdown", (event: PointerEvent) => {
    place(event);
    held = true;
    state.press(Input.pointerButton(event.button));
    if (event.buttons > 0) {
      follow(event.buttons);
    }
  });
  // On the page, so that a button let go outside the target is let go.
  on(page, "pointermove", (event: PointerEvent) => {
    place(event);
    if (!held || typeof event.buttons !== "number") {
      return;
    }
    if (event.buttons === 0) {
      // Let go where the page could not hear of it.
      letGo();
    } else {
      follow(event.buttons);
    }
  });
  on(page, "pointerup", (event: PointerEvent) => {
    place(event);
    state.release(Input.pointerButton(event.button));
    if (event.buttons === 0) {
      letGo();
    } else if (event.buttons > 0) {
      follow(event.buttons);
    }
  });
  on(page, "pointercancel", letGo);

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
    listener: {
      sample() {
        if (stopped) {
          throw new Error(
            "The page's devices were read after they were let go: the app that listened to them was closed, or the scope Input.listen ran in had ended. They would say nothing for ever: read them through an app that is open."
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
