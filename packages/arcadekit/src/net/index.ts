/**
 * The `arcadekit/net` entry point: a game played on several machines.
 *
 *   import { Session, Transport } from "arcadekit/net"
 *
 *   const session = yield* Session.make(Duel, { seed, me, others, delta: 1 / 60 })
 *   yield* Driver.frames(yield* Transport.connect(session))
 *
 * Each module is an entry of its own too, `arcadekit/net/Session`, for a
 * program that wants one of them: a relay server imports
 * `arcadekit/net/Relay`, and no session with it.
 *
 * - `Session`: one peer of a game, with the app it makes and steps.
 * - `Transport`: what carries a session's messages to the other peers.
 * - `Relay`: the rules of a server that passes messages on between peers.
 * - `Message`: what peers send each other, and its form as text.
 * - `Drift`: peers that are no longer playing the same game.
 * - `Peer`: a session without its app, which a transport carries the messages of.
 */
export * as Drift from "./Drift";
export * as Message from "./Message";
export * as Peer from "./Peer";
export * as Relay from "./Relay";
export * as Session from "./Session";
export * as Transport from "./Transport";
