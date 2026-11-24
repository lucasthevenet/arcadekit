/**
 * The `arcadekit/browser` entry point: what only a page can use.
 *
 *   import { App, Driver } from "arcadekit"
 *   import { Browser } from "arcadekit/browser"
 *
 *   Browser.runMain(Driver.run(App.define({ plugins: [Game] }), { hz: 60 }), {
 *     target: canvas,
 *   })
 *
 * Each module is also an entry of its own, such as `arcadekit/browser/Browser`,
 * for a program that wants only that module. It is the only entry point of
 * `arcadekit` that imports a browser package, so a server, a replay or a test
 * of the game imports `arcadekit` alone.
 *
 * - `Browser`: the page's display, input devices and images, and the way a
 *   program starts in it. It gives `Audio`'s sound too.
 * - `Audio`: the page's sound, played with Web Audio.
 */
export * as Audio from "./Audio";
export * as Browser from "./Browser";
