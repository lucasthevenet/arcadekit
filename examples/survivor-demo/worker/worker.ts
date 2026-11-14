/**
 * The survivors demo's Worker (#25): it serves the site's files and is co-op's signalling worker,
 * which is the kit's (`arcadekit/net/worker`). `alchemy.run.ts` declares the Worker, routes only
 * the signalling paths to it ahead of the assets, and binds `ROOMS`; Alchemy supplies `ASSETS`.
 *
 * Cloudflare owns a Worker's entry points, so the kit's handler and room class run their Effects
 * themselves: this file only names the class and the bindings.
 */
import { SignallingWorker } from "arcadekit/net/worker";

/**
 * One join code's room, of up to 4 players (the kit's default room size): the Durable Object
 * class `alchemy.run.ts` binds as `ROOMS`.
 */
export class SignallingRoom extends SignallingWorker.room() {}

/**
 * The Worker's handler: `GET /host` opens a room under a fresh join code and `GET /join/<code>`
 * joins one (`ROOMS`), and anything else that reaches it is answered from the site's files
 * (`ASSETS`).
 */
export default SignallingWorker.make({ rooms: "ROOMS", assets: "ASSETS" });
