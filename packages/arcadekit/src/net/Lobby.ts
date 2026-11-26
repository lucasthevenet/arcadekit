/**
 * A lobby is where the peers of a game meet before it begins, and agree on
 * who plays, a seed and the game's settings.
 *
 *   const lobby = yield* Lobby.join({
 *     me: "ada",
 *     players: 2,
 *     settings: Schema.Struct({ map: Schema.String }),
 *   })
 *   yield* lobby.set({ map: "dunes" })
 *   yield* lobby.ready()
 *   const start = yield* lobby.start          // { me, others, seed, settings }
 *   const session = yield* Session.make(Duel, { ...start, hz: 60 })
 *   return yield* lobby.connect(session)
 *
 * A lobby listens on the program's `Transport`, and says what it has to say
 * as a `Message.Aside`, which a relay passes on as it passes on a message.
 * Each peer gives a part of the seed, and the seed is a hash of every
 * player's part and the settings, so no one peer chooses it, and peers that
 * start with other settings are found as `Drift.Drifted` on the first tick
 * they compare.
 *
 * A peer may set the settings at any time before the game begins. The
 * settings set last win, the same on every peer, and a change of them takes
 * back every peer's word that it is ready. The game begins once the lobby
 * holds `players` peers and each is ready for the same settings.
 *
 * The session is connected over the lobby's own channel with `lobby.connect`,
 * which hands it what the other players' sessions sent while this one was
 * still in the lobby. A second connection to the transport would open a
 * second socket under the same name, which a relay refuses.
 */
import { Cause, Data, Effect, Exit, Random, Schema } from "effect";
import type { Scope } from "effect";

import { add, addString, finish } from "../ecs/hash.ts";
import * as Message from "./Message.ts";
import type { Session } from "./Session.ts";
import * as Transport from "./Transport.ts";

/** The topic of a lobby's asides. */
const TOPIC = "arcadekit/Lobby";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Which settings: the how-manieth change, and the peer that made it. */
const Key = Schema.Struct({ version: Count, by: Schema.String });
type Key = typeof Key.Type;

/** What a peer says in the lobby, whole, each time it says anything. */
const Word = Schema.Struct({
  /** How many words the peer has said: a later word stands for an earlier. */
  n: Count,
  /** Its part of the seed. */
  part: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: 4_294_967_295 })
  ),
  /** The latest settings it knows of, in their JSON form. */
  settings: Schema.optionalKey(
    Schema.Struct({ key: Key, value: Schema.Unknown })
  ),
  /** The settings it is ready to play with, and with whom. */
  ready: Schema.optionalKey(
    Schema.Struct({ key: Key, players: Schema.Array(Schema.String) })
  ),
});
type Word = typeof Word.Type;

const readWord = Schema.decodeUnknownExit(Word);

/**
 * Options for a lobby: this peer's name, how many play, and the schema of the
 * game's settings.
 *
 * @category Options
 */
export interface Options<S extends Schema.Codec<unknown, unknown>> {
  /** This peer's name, as its transport says it to the others. */
  readonly me: string;
  /** How many peers play, a whole number from 1. The game begins with that many. */
  readonly players: number;
  /**
   * The schema of the game's settings, which travel in their JSON form. With
   * one, the game begins only once a peer has set them. Without one, the
   * settings are `undefined`.
   */
  readonly settings?: S;
}

/**
 * What a lobby agreed on, the same on every player's peer, in the words
 * `Session.make` takes: `Session.make(Duel, { ...start, hz: 60 })`.
 *
 * @typeParam A The settings.
 * @category Models
 */
export interface Start<A> {
  /** This peer's name. */
  readonly me: string;
  /** Every other player, in order of name. */
  readonly others: readonly string[];
  /** The game's seed: a hash of every player's part of it and the settings. */
  readonly seed: number;
  /** The settings every player is ready for. */
  readonly settings: A;
}

/**
 * The room plays a game that began without this peer: the lobby had the
 * players it takes when they were ready, or they began before this peer
 * joined.
 *
 * @category Errors
 */
export class Full extends Data.TaggedError("LobbyFull")<{
  /** The players of that game, as far as this peer heard, in order of name. */
  readonly players: readonly string[];
}> {
  override get message(): string {
    return `${this.players.join(", ")} began a game without this peer, in the room it joined. Join another room.`;
  }
}

/**
 * A lobby this peer is in, from `Lobby.join`.
 *
 * @typeParam A The settings.
 * @category Models
 */
export interface Lobby<A> {
  /** This peer's name. */
  readonly me: string;
  /** How many peers play. */
  readonly players: number;
  /** The peers in the lobby, this one too, in order of name. */
  readonly members: readonly string[];
  /** The settings set last, or `undefined` while nobody has set them. */
  readonly settings: A | undefined;
  /** The peers in the lobby that aren't ready for the settings set last. */
  readonly waitingFor: readonly string[];
  /**
   * Sets the game's settings, for every peer. It takes back every peer's
   * word that it is ready, this one's too. It dies once the game has begun.
   */
  readonly set: (settings: A) => Effect.Effect<void, Transport.Closed>;
  /**
   * Says that this peer is ready to play with the settings set last, and
   * with the peers in the lobby. It dies once the game has begun.
   */
  readonly ready: () => Effect.Effect<void, Transport.Closed>;
  /**
   * Waits until every player is ready, reading what arrives every 20
   * milliseconds, and succeeds with what they agreed. Run again, it
   * succeeds with the same. It fails with `Lobby.Full` when the players
   * began without this peer.
   */
  readonly start: Effect.Effect<Start<A>, Transport.Closed | Full>;
  /**
   * Connects a session made from the start over the lobby's channel, as
   * `Transport.connect` connects one over a transport. It dies before the
   * start, and for a session whose names aren't the start's.
   */
  readonly connect: <E, HU>(
    session: Session<E, HU>,
    options?: Transport.ConnectOptions
  ) => Effect.Effect<Transport.Connected<E, HU>>;
}

/** Orders keys: the later change, and between two of one count, by name. */
const later = (a: Key, b: Key): boolean =>
  a.version !== b.version ? a.version > b.version : a.by > b.by;

const same = (a: Key, b: Key): boolean =>
  a.version === b.version && a.by === b.by;

const sameNames = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((name, at) => name === b[at]);

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Joins the lobby of the room this peer's transport reaches, and listens on
 * the transport in the current scope. The settings need a JSON form.
 *
 * **Gotchas**
 *
 * - Peers that join or leave in the moment the last player says it is
 *   ready can see two lobbies. Every player that begins does so with the
 *   same names, seed and settings as the first: a peer that hears a player
 *   began takes that player's word for it. A peer the others began without
 *   fails with `Lobby.Full`.
 * - A second `Transport.connect` on the program's transport opens a second
 *   socket under this peer's name, which a relay refuses: connect with
 *   `lobby.connect`.
 *
 * @category Constructors
 */
export const join = <
  S extends Schema.Codec<unknown, unknown> = typeof Schema.Undefined,
>(
  options: Options<S>
): Effect.Effect<
  Lobby<S["Type"]>,
  Transport.Closed,
  Transport.Transport | Scope.Scope
> =>
  Effect.gen(function* () {
    const { me, players } = options;
    if (!Number.isSafeInteger(players) || players < 1) {
      return yield* Effect.die(
        new Error(
          `A lobby's players are a whole number from 1, and this one is ${players}.`
        )
      );
    }
    const codec = Schema.toCodecJson(options.settings ?? Schema.Undefined);
    const needsSettings = options.settings !== undefined;
    const listener = yield* Transport.listen;
    const part = yield* Random.nextIntBetween(0, 4_294_967_295);

    // What every other peer said last, by name.
    const heard = new Map<string, Word>();
    // Every settings anyone said, in JSON form, by key.
    const values = new Map<string, unknown>([["0:", undefined]]);
    const named = (key: Key): string => `${key.version}:${key.by}`;
    let current: Key = { version: 0, by: "" };
    let mine: Key | undefined;
    let said = 0;
    let started: Start<S["Type"]> | undefined;
    // What the players' sessions sent before this one began, for its own.
    const held: Message.Message[] = [];

    const members = (): string[] => [me, ...heard.keys()].toSorted(byName);

    const decoded = (key: Key): S["Type"] => {
      const value = Schema.decodeUnknownExit(codec)(values.get(named(key)));
      // Each value was checked when it arrived.
      return Exit.isSuccess(value) ? value.value : undefined;
    };

    const word = (): Word => ({
      n: said++,
      part,
      ...(current.version === 0
        ? {}
        : { settings: { key: current, value: values.get(named(current)) } }),
      ...(mine === undefined
        ? {}
        : { ready: { key: mine, players: members() } }),
    });

    const say = Effect.suspend(() =>
      listener.send({ from: me, topic: TOPIC, body: word() })
    );

    const adopt = (key: Key, value: unknown): void => {
      values.set(named(key), value);
      if (later(key, current)) {
        current = key;
      }
    };

    const startWith = (
      names: readonly string[],
      key: Key
    ): Start<S["Type"]> | undefined => {
      let h = 0;
      for (const name of names) {
        const theirs = name === me ? part : heard.get(name)?.part;
        if (theirs === undefined) {
          return undefined;
        }
        h = add(addString(h, name), theirs);
      }
      h = addString(h, JSON.stringify(values.get(named(key)) ?? null));
      return {
        me,
        others: names.filter((name) => name !== me),
        seed: finish(h),
        settings: decoded(key),
      };
    };

    /** Reads what arrived, and returns the start once it is decided. */
    const poll = Effect.gen(function* () {
      let changed = false;
      // The peers whose sessions have begun, by what their messages say.
      const playing = new Set<string>();
      for (const arrived of yield* listener.receive()) {
        if ("topic" in arrived) {
          if (arrived.topic !== TOPIC || arrived.from === me) {
            continue;
          }
          const read = readWord(arrived.body);
          if (Exit.isFailure(read)) {
            continue;
          }
          const told = read.value;
          if (told.settings !== undefined) {
            const value = Schema.decodeUnknownExit(codec)(told.settings.value);
            if (Exit.isFailure(value)) {
              continue;
            }
            adopt(told.settings.key, told.settings.value);
          }
          const before = heard.get(arrived.from);
          if (before === undefined || told.n > before.n) {
            heard.set(arrived.from, told);
          }
          // A peer heard for the first time hears this one's word.
          changed ||= before === undefined;
        } else if ("from" in arrived) {
          held.push(arrived);
          playing.add(arrived.from);
        } else if ("joined" in arrived) {
          changed = true;
        } else if (heard.delete(arrived.left)) {
          changed = true;
        }
      }
      if (changed) {
        // A newcomer hears this peer, and a ready word names who is here now.
        yield* say;
      }
      // A peer that began did so with whom its last word says it was ready.
      const begun = Array.from(playing).toSorted(byName);
      if (begun.length > 0) {
        const theirs = heard.get(begun[0]!)?.ready;
        if (theirs === undefined) {
          return yield* new Full({ players: begun });
        }
        if (!theirs.players.includes(me)) {
          return yield* new Full({ players: theirs.players });
        }
        return startWith(theirs.players, theirs.key);
      }
      const all = members();
      if (
        all.length !== players ||
        (needsSettings && current.version === 0) ||
        mine === undefined ||
        !same(mine, current)
      ) {
        return undefined;
      }
      for (const name of all) {
        const theirs = name === me ? undefined : heard.get(name)?.ready;
        if (
          name !== me &&
          (theirs === undefined ||
            !same(theirs.key, current) ||
            !sameNames(theirs.players, all))
        ) {
          return undefined;
        }
      }
      return startWith(all, current);
    });

    const going = Effect.gen(function* () {
      while (started === undefined) {
        started = yield* poll;
        if (started === undefined) {
          yield* Effect.sleep("20 millis");
        }
      }
      return started;
    });

    const open = (what: string): Effect.Effect<void> =>
      started === undefined
        ? Effect.void
        : Effect.die(
            new Error(
              `${what} after the game began. The lobby is done once lobby.start has succeeded: change the game through its session.`
            )
          );

    // A peer already here learns of this one, and says its own word.
    yield* say;

    return {
      me,
      players,
      get members() {
        return members();
      },
      get settings() {
        return current.version === 0 ? undefined : decoded(current);
      },
      get waitingFor() {
        return members().filter((name) => {
          const theirs = name === me ? mine : heard.get(name)?.ready?.key;
          return theirs === undefined || !same(theirs, current);
        });
      },
      set: (settings) =>
        Effect.andThen(
          open("lobby.set was called"),
          Effect.suspend(() => {
            const value = Schema.encodeUnknownExit(codec)(settings);
            if (Exit.isFailure(value)) {
              return Effect.die(Cause.squash(value.cause));
            }
            adopt({ version: current.version + 1, by: me }, value.value);
            mine = undefined;
            return say;
          })
        ),
      ready: () =>
        Effect.andThen(
          open("lobby.ready was called"),
          Effect.suspend(() => {
            mine = current;
            return say;
          })
        ),
      start: going,
      connect: (session, connectOptions) =>
        Effect.suspend(() => {
          if (started === undefined) {
            return Effect.die(
              new Error(
                "lobby.connect was called before the game began. Make the session with what lobby.start succeeds with, then connect it."
              )
            );
          }
          const names = [started.me, ...started.others].toSorted(byName);
          if (session.me !== me || !sameNames(session.peers, names)) {
            return Effect.die(
              new Error(
                `lobby.connect was given a session of ${session.peers.join(", ")} as "${session.me}", and the lobby began with ${names.join(", ")} as "${me}". Make the session with what lobby.start succeeds with.`
              )
            );
          }
          let first = true;
          const handed: Transport.Listener = {
            send: listener.send,
            receive: () =>
              Effect.map(listener.receive(), (arrived) => {
                if (!first) {
                  return arrived;
                }
                first = false;
                return [...held, ...arrived];
              }),
          };
          return Transport.connect(session, connectOptions).pipe(
            Effect.provide(Transport.layer(handed))
          );
        }),
    };
  });
