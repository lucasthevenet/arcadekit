/**
 * What a page keeps beyond a visit, in its local storage: the saves of a
 * game's slots and its settings, each under the game's name.
 */
import { Effect, Result } from "effect";
import { Base64 } from "effect/encoding";

import { said } from "../../internal/intake.ts";
import * as Save from "../../Save.ts";
import * as Setting from "../../Setting.ts";

/**
 * A game's saves in the page's local storage, `Browser.saves`: each slot's
 * bytes as base64 text, under `<name>/save/<slot>`.
 *
 * @internal
 */
export const saves = (name: string): Save.StoreShape => {
  const prefix = `${name}/save/`;
  const failed = (slot: string | undefined, doing: string, error: unknown) =>
    new Save.StoreFailed({
      slot,
      message: `The page's storage could not ${doing}: ${said(error)}`,
    });
  return {
    get: (slot) =>
      Effect.flatMap(
        Effect.try({
          try: () => localStorage.getItem(`${prefix}${slot}`),
          catch: (error) => failed(slot, `read the slot "${slot}"`, error),
        }),
        (text) => {
          if (text === null) {
            return Effect.succeed(undefined);
          }
          const bytes = Base64.decode(text);
          return Result.isSuccess(bytes)
            ? Effect.succeed(bytes.success)
            : Effect.fail(
                failed(
                  slot,
                  `read the slot "${slot}"`,
                  "what it holds is not the base64 text of a save"
                )
              );
        }
      ),
    set: (slot, bytes) =>
      Effect.try({
        try: () =>
          localStorage.setItem(`${prefix}${slot}`, Base64.encode(bytes)),
        catch: (error) => failed(slot, `keep the slot "${slot}"`, error),
      }),
    remove: (slot) =>
      Effect.try({
        try: () => localStorage.removeItem(`${prefix}${slot}`),
        catch: (error) => failed(slot, `empty the slot "${slot}"`, error),
      }),
    slots: Effect.try({
      try: () => {
        const found: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key?.startsWith(prefix) === true) {
            found.push(key.slice(prefix.length));
          }
        }
        return found.toSorted();
      },
      catch: (error) => failed(undefined, "list its slots", error),
    }),
  };
};

/**
 * A game's settings in the page's local storage, `Browser.settings`: each as
 * its text, under `<name>/setting/<key>`. A setting is read from the storage
 * the first time it is asked for, and kept in memory from then on, since the
 * frame stage asks every frame.
 *
 * @internal
 */
export const settings = (name: string): Setting.StoreShape => {
  const prefix = `${name}/setting/`;
  const read = new Map<string, string | undefined>();
  return {
    get: (key) => {
      if (!read.has(key)) {
        let text: string | undefined;
        try {
          text = localStorage.getItem(`${prefix}${key}`) ?? undefined;
        } catch {
          // A page whose storage is turned off has no setting kept.
        }
        read.set(key, text);
      }
      return read.get(key);
    },
    set: (key, text) =>
      Effect.try({
        try: () => {
          localStorage.setItem(`${prefix}${key}`, text);
          read.set(key, text);
        },
        catch: (error) =>
          new Setting.StoreFailed({
            key,
            message: `The page's storage could not keep the setting "${key}": ${said(error)}`,
          }),
      }),
  };
};
