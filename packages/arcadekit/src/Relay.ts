/**
 * A relay: what passes a game's messages on between peers on different
 * machines.
 *
 * Each peer opens a WebSocket to the relay, at an address that names a room
 * and the peer. What one sends, the relay passes on to the others in the
 * room. It runs no game and keeps no state of one: it is given text and
 * hands text on.
 *
 * It is a handler, and no server: three plain functions that say what to do
 * with a connection and with what it sent, for whatever accepts the
 * sockets to call. That may keep its connections anywhere, with the socket
 * itself where the platform lets go of everything else between two
 * messages:
 *
 *   // a peer asks to connect: who is it, and may it come in?
 *   const member = Relay.join(request.url, present)        // Exit<Member, Refused>
 *
 *   // a member sent something: what goes to whom?
 *   const deliveries = Relay.forward(member, data, present) // Exit<Delivery[], Refused>
 *   for (const { to, text } of deliveries.value) socketOf(to).send(text)
 *
 * `present` is whoever is connected to that room, as the host knows them:
 * on Cloudflare, what a Durable Object reads back from its sockets'
 * attachments; behind an API gateway, the rows of a table of connections.
 * `Relay.make()` keeps them itself, for a host that stays in memory, a
 * Node server or a test.
 *
 * What the relay adds to a wire is that it vouches for the sender. A peer
 * says who it is once, when it connects, and the relay holds it to that:
 * a message that says it is from anyone else is refused, and the socket
 * with it. So `from`, which a handler is told, is who the relay let in
 * under that name. Whether to let that peer in under that name is the
 * host's to decide before it calls `join`: a token in the request, a
 * session, whatever it has.
 *
 * The room is named in the address and is one object of the host's, as in
 * PartyServer, which gives each room a Durable Object, and as matchbox's
 * signalling server names a room in the URL its peers connect to. The
 * sender is the server's to say, as it is wherever a server stands between
 * players.
 */
import { Data, Exit, Schema } from "effect";

import * as Lockstep from "./Lockstep";

/**
 * Who a connection is: the room it is in, and the peer it speaks for. A
 * host keeps this with the connection, and hands the relay everyone in a
 * room when it asks what to do.
 */
export const Member: Schema.Struct<{
  readonly room: typeof Schema.String;
  readonly peer: typeof Schema.String;
}> = Schema.Struct({ room: Schema.String, peer: Schema.String });
export type Member = typeof Member.Type;

/** One text to send to one member of the room. */
export interface Delivery {
  readonly to: Member;
  readonly text: string;
}

/**
 * The relay will not have it: a peer that may not come in, or something a
 * member sent that it will not pass on.
 *
 * A host closes the socket with `code` and `reason`:
 * `socket.close(refused.code, refused.reason)`. The reason is a few words,
 * since a close frame carries 123 bytes at most, and it is what the peer's
 * transport is told. `message` says more, with the names, for a log or for
 * the body of an HTTP answer with `status`. A page is told nothing of a
 * request to connect that was turned away with a status, so a host that
 * wants the peer to know why accepts the socket and closes it.
 */
export class Refused extends Data.TaggedError("RelayRefused")<{
  readonly reason:
    | "not an address"
    | "name taken"
    | "room full"
    | "not a peer"
    | "not a message"
    | "speaks for another"
    | "too long";
  readonly message: string;
  /** For a request to connect that is turned away: 400, 403 or 409. */
  readonly status: number;
  /** For a socket that is closed: 1007, 1008 or 1009. */
  readonly code: number;
}> {}

export interface Options {
  /**
   * The most peers a room takes: 8 when left out. One more is refused
   * with `"room full"`.
   */
  readonly maxPeers?: number;
  /**
   * The only names a room lets in, for a game that knows its players.
   * Anyone, when left out.
   */
  readonly peers?: readonly string[];
  /**
   * The longest text a member may send, in characters: 65,536 when left
   * out. A longer one is refused with `"too long"`.
   */
  readonly maxLength?: number;
}

/** A room's or a peer's name is this long at most. */
const NAME_LENGTH = 64;

const refuse = (
  reason: Refused["reason"],
  message: string,
  status: number,
  code: number
): Exit.Exit<never, Refused> =>
  Exit.fail(new Refused({ reason, message, status, code }));

/**
 * The address a peer connects to: the relay's own, then the room, and the
 * peer's name as a query.
 *
 *   Relay.address("wss://relay.example.com/rooms", { room: "blue", peer: "ada" })
 *   // "wss://relay.example.com/rooms/blue?peer=ada"
 */
export const address = (base: string, member: Member): string =>
  `${base.replace(/\/+$/u, "")}/${encodeURIComponent(member.room)}?peer=${encodeURIComponent(member.peer)}`;

/**
 * Whether a peer may come in, from the address it asked for and whoever is
 * in that room already. Its member is what the host keeps with the
 * connection.
 *
 * The room is the last part of the address's path and the peer its `peer`
 * query, as `address` writes them. It is refused when the address names
 * neither, when the name is taken in that room, when the room is full, or
 * when the room lets in only names this is not one of.
 *
 * It does not ask whether the peer is who it says: that is the host's to
 * settle before it calls this, with whatever the request carries.
 */
export const join = (
  url: string,
  present: readonly Member[],
  options: Options = {}
): Exit.Exit<Member, Refused> => {
  let room: string | undefined;
  let peer: string | null;
  try {
    // A host may be handed the whole address or its path alone.
    const parsed = new URL(url, "ws://relay");
    room = decodeURIComponent(
      parsed.pathname.split("/").findLast((part) => part !== "") ?? ""
    );
    peer = parsed.searchParams.get("peer");
  } catch {
    room = undefined;
    peer = null;
  }
  if (
    room === undefined ||
    room === "" ||
    room.length > NAME_LENGTH ||
    peer === null ||
    peer === "" ||
    peer.length > NAME_LENGTH
  ) {
    return refuse(
      "not an address",
      `"${url}" is not a relay's address: it ends in a room's name and says which peer is asking, as Relay.address writes it, each ${NAME_LENGTH} characters at most.`,
      400,
      1008
    );
  }
  if (options.peers !== undefined && !options.peers.includes(peer)) {
    return refuse(
      "not a peer",
      `"${peer}" is not one of the peers the room "${room}" lets in.`,
      403,
      1008
    );
  }
  const inRoom = present.filter((member) => member.room === room);
  if (inRoom.some((member) => member.peer === peer)) {
    return refuse(
      "name taken",
      `A peer named "${peer}" is in the room "${room}" already.`,
      409,
      1008
    );
  }
  const most = options.maxPeers ?? 8;
  if (inRoom.length >= most) {
    return refuse(
      "room full",
      `The room "${room}" has the ${most} peers it takes.`,
      403,
      1008
    );
  }
  return Exit.succeed({ room, peer });
};

const decoder = new TextDecoder();

/**
 * What to do with something a member sent: the text to pass on to every
 * other member of its room.
 *
 * What is passed on is the message as the relay read it, written out again,
 * so nothing rides along that is not part of one. It is refused, and the
 * host closes the socket with the refusal's `code`, when it is not a
 * message, when it is longer than the relay takes, or when it says it is
 * from anyone but the member that sent it.
 */
export const forward = (
  from: Member,
  data: string | ArrayBuffer | ArrayBufferView,
  present: readonly Member[],
  options: Options = {}
): Exit.Exit<readonly Delivery[], Refused> => {
  const text = typeof data === "string" ? data : decoder.decode(data);
  const longest = options.maxLength ?? 65_536;
  if (text.length > longest) {
    return refuse(
      "too long",
      `"${from.peer}" sent ${text.length} characters, and the relay takes ${longest} at most.`,
      400,
      1009
    );
  }
  const message = Lockstep.decode(text);
  if (Exit.isFailure(message)) {
    return refuse(
      "not a message",
      `"${from.peer}" sent something that is not a message.`,
      400,
      1007
    );
  }
  if (message.value.from !== from.peer) {
    return refuse(
      "speaks for another",
      `"${from.peer}" sent a message that says it is from "${message.value.from}". A peer speaks for itself.`,
      403,
      1008
    );
  }
  const passedOn = Lockstep.encode(message.value);
  const deliveries: Delivery[] = [];
  for (const member of present) {
    if (member.room === from.room && member.peer !== from.peer) {
      deliveries.push({ to: member, text: passedOn });
    }
  }
  return Exit.succeed(deliveries);
};

/** A peer's connection to a relay that keeps its rooms in memory. */
export interface Connection {
  readonly member: Member;
  /**
   * Takes what the peer sent, and sends it on to the others in the room.
   * Fails when it is refused, for the host to close the socket.
   */
  readonly receive: (
    data: string | ArrayBuffer | ArrayBufferView
  ) => Exit.Exit<void, Refused>;
  /** The peer is gone: its name is free again. */
  readonly close: () => void;
}

/** A relay that keeps who is connected itself. */
export interface Server {
  /**
   * A peer asks to connect, at `url`: `send` is how the relay sends to it.
   * Fails when the peer may not come in.
   */
  readonly connect: (
    url: string,
    send: (text: string) => void
  ) => Exit.Exit<Connection, Refused>;
  /** Who is in a room, in the order they came in. */
  readonly members: (room: string) => readonly Member[];
  /** How many rooms have anyone in them. */
  readonly rooms: number;
}

/**
 * A relay for a host that stays in memory: a Node server, a Durable Object
 * that does not hibernate, a test. It keeps who is connected, and is told
 * of each socket as it comes and goes.
 *
 *   const relay = Relay.make()
 *   server.on("connection", (socket, request) => {
 *     const connection = relay.connect(request.url, (text) => socket.send(text))
 *     if (Exit.isFailure(connection)) return socket.close(1008, "refused")
 *     socket.on("message", (data) => connection.value.receive(data))
 *     socket.on("close", () => connection.value.close())
 *   })
 */
export const make = (options: Options = {}): Server => {
  // Per room, how to send to each peer in it, by name.
  const rooms = new Map<
    string,
    Map<string, { readonly send: (text: string) => void }>
  >();
  const members = (room: string): Member[] =>
    Array.from(rooms.get(room)?.keys() ?? [], (peer) => ({ room, peer }));
  return {
    connect(url, send) {
      // Only that room's members are needed, and the address says which.
      const all = Array.from(rooms.keys()).flatMap((room) => members(room));
      const joined = join(url, all, options);
      if (Exit.isFailure(joined)) {
        return Exit.failCause(joined.cause);
      }
      const member = joined.value;
      let room = rooms.get(member.room);
      if (room === undefined) {
        room = new Map();
        rooms.set(member.room, room);
      }
      // The connection itself, so that its close is told from a later one's.
      const self = { send };
      room.set(member.peer, self);
      const peers = room;
      return Exit.succeed({
        member,
        receive(data) {
          const deliveries = forward(
            member,
            data,
            members(member.room),
            options
          );
          if (Exit.isFailure(deliveries)) {
            return Exit.failCause(deliveries.cause);
          }
          for (const { text, to } of deliveries.value) {
            peers.get(to.peer)?.send(text);
          }
          return Exit.void;
        },
        close() {
          // Unless the name has been given to a newer connection since.
          if (peers.get(member.peer) === self) {
            peers.delete(member.peer);
            if (peers.size === 0 && rooms.get(member.room) === peers) {
              rooms.delete(member.room);
            }
          }
        },
      });
    },
    members,
    get rooms() {
      return rooms.size;
    },
  };
};
