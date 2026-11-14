/**
 * Rooms: the limits of a signalling room, which the signalling worker holds a run's peers in
 * while they set up their WebRTC connections.
 *
 * A room holds at most its room size, host included, which an app sets where it sets up its
 * worker, and lives for minutes. Its numbers are here, in the protocol both sides read, so a
 * `Coop` refuses a `maxPlayers` no room can hold and the worker refuses a room size no room can
 * have. Plain on purpose: constants.
 *
 * @since 0.7.0
 */

/**
 * The players a room holds, host included, unless the worker is set up with another room size
 * (2 to 4 players).
 *
 * **When to use**
 *
 * As the most players a run takes when a game says nothing else, as a `Coop`'s `maxPlayers` does.
 *
 * **Example** (A room's size when the app says none)
 *
 * ```ts
 * import { Room } from "arcadekit/net/signalling";
 *
 * Room.defaultSize; // => 4
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export const defaultSize = 4;

/**
 * The largest room size a worker can be set up with, host included.
 *
 * **When to use**
 *
 * To check a room size, or a game's most players, before a worker or a `Coop` refuses it.
 *
 * **Details**
 *
 * A lockstep run holds at most 16 players too, on the wire.
 *
 * **Example** (A room size a worker takes)
 *
 * ```ts
 * import { Room } from "arcadekit/net/signalling";
 *
 * const fits = (size: number) => Number.isInteger(size) && size >= 2 && size <= Room.maxSize;
 * fits(8); // => true
 * fits(32); // => false
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export const maxSize = 16;

/**
 * How long a room lives after its host connects, in milliseconds: ten minutes. Signalling takes
 * seconds, so this is generous.
 *
 * **When to use**
 *
 * To tell players how long a join code stays good.
 *
 * **Details**
 *
 * An expired room admits no one, and its expiry alarm closes the sockets still in it, with
 * `expired`.
 *
 * **Example** (A room's life in minutes)
 *
 * ```ts
 * import { Room } from "arcadekit/net/signalling";
 *
 * Room.ttlMs / 60_000; // => 10
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export const ttlMs: number = 10 * 60 * 1000;
