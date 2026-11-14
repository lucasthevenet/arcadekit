// What the key presses and the shortcut presses share, and no app calls: the window's keydowns
// as a Stream, kept to the presses of the keys it was made for, each as the app's Message.

import { Stream } from "effect";
import type { Predicate } from "effect";

/**
 * Each keydown on the window that `isPress` keeps and whose code is in `codes`, as
 * `toMessage(code)`. The window is read when the Stream runs, so making one needs no browser:
 * an app may make it as its module loads, where a test in Node has no window.
 */
export const pressesOf = <Code extends string, Message>(
  codes: readonly Code[],
  toMessage: (code: Code) => Message,
  isPress: Predicate.Predicate<KeyboardEvent>
): Stream.Stream<Message> => {
  const listed: readonly string[] = codes;
  const isListed = (code: string): code is Code => listed.includes(code);
  return Stream.suspend(() =>
    Stream.fromEventListener<KeyboardEvent>(window, "keydown")
  ).pipe(
    Stream.filter(isPress),
    Stream.map((event) => event.code),
    Stream.filter(isListed),
    Stream.map((code) => toMessage(code))
  );
};
