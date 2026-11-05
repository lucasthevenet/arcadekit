import { InputController, MOVE_AXES } from "@arcadekit/input";
import { hostLockstep, joinLockstep, schemaCodec } from "@arcadekit/net";
import type {
  LockstepError,
  LockstepOptions,
  LockstepSession,
} from "@arcadekit/net";
import { hostRoom, joinRoom, linksTransport } from "@arcadekit/net/browser";
import type {
  PeerLink,
  RoomEvent,
  SignallingOptions,
  SignallingRoom,
} from "@arcadekit/net/browser";
import type { StepInput } from "@arcadekit/runtime";
import { combineViews } from "@arcadekit/runtime/browser";
import type { GameView } from "@arcadekit/runtime/browser";
import {
  HeroInput,
  combineHeroInputs,
  hashWorld,
  isChoosing,
  survivorsSimulation,
} from "@arcadekit/survivors";
import type {
  GameContent,
  HudSample,
  RunSummary,
  SurvivorsConfig,
  SurvivorsEvent,
  SurvivorsInput,
  UpgradeChoice,
  UpgradePick,
  World,
} from "@arcadekit/survivors";
import {
  SurvivorsSoundView,
  SurvivorsView,
} from "@arcadekit/survivors/browser";
import type {
  SurvivorsArt,
  SurvivorsGameSound,
} from "@arcadekit/survivors/browser";

import { contentHash } from "./content-hash";
import { encodeLobbyMessage, parseLobbyMessage, playerName } from "./lobby";
import type { LobbyMessage, LobbyPlayer } from "./lobby";
import { workerTicker } from "./ticker";
import type { Ticker } from "./ticker";

/**
 * What the co-op client reports to the app. Player names are for display ("Guest 2"); the
 * game's events are the local player's only.
 */
export type CoopEvent =
  /** The lobby changed: who's in it and their heroes, host first. */
  | {
      readonly type: "lobby";
      readonly role: "host" | "guest";
      readonly code: string;
      readonly self: string;
      readonly players: readonly LobbyPlayer[];
    }
  /** The run started. `slot` is the local player's hero; `players` every player's name, by slot. */
  | {
      readonly type: "started";
      readonly slot: number;
      readonly players: readonly string[];
    }
  /**
   * Who stepping waits on (lockstep's "waiting for X"), once it has waited `WAITING_SHOWN_MS`,
   * and which other players have an upgrade offer open while the run is frozen for a level-up.
   * Reported when either changes.
   */
  | {
      readonly type: "waiting";
      readonly waitingFor: readonly string[];
      readonly choosing: readonly string[];
    }
  /** The lobby or the run failed for good: unreachable signalling, a desync, removal, a lost host… */
  | { readonly type: "failed"; readonly message: string }
  | { readonly type: "hud"; readonly hud: HudSample }
  /** The local player's hero has offer `offer` open. Answer with `pickUpgrade`. */
  | {
      readonly type: "levelUp";
      readonly offer: number;
      readonly choices: readonly UpgradeChoice[];
    }
  | { readonly type: "runEnded"; readonly summary: RunSummary };

export interface CoopClientOptions {
  /** How to reach the signalling worker, and WebRTC's STUN servers. */
  readonly signalling: SignallingOptions;
  /** Opens rooms. Defaults to `hostRoom` and `joinRoom` with `signalling`; tests pass fakes. */
  readonly rooms?: {
    readonly host: () => SignallingRoom;
    readonly join: (code: string) => SignallingRoom;
  };
  /**
   * What ticks the session. Defaults to a timer in a dedicated worker, which a hidden tab doesn't
   * throttle (`workerTicker`); tests pass the main thread's timers.
   */
  readonly ticker?: Ticker;
  /** Steps ahead local input is scheduled. 4 steps is 67 ms at 60 Hz (ADR-0012). */
  readonly inputDelay?: number;
  /** Steps between state hash comparisons. */
  readonly hashEvery?: number;
  /**
   * What the run's sounds play through: every peer hears the whole fight, its own hero's hurt
   * and down loudest. Without it the run is silent.
   */
  readonly sound?: SurvivorsGameSound;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type SessionOptions = LockstepOptions<
  SurvivorsConfig,
  World,
  SurvivorsInput,
  SurvivorsEvent,
  HeroInput
>;

/** How often the session ticks. Browsers clamp shorter timers to about 4 ms anyway. */
const TICK_MS = 4;
/**
 * How long stepping must wait before the players it waits on are shown. Lockstep waits a frame
 * now and then as input arrives; that isn't worth a banner.
 */
const WAITING_SHOWN_MS = 300;
/** How many recent state hashes `debug` keeps. */
const KEPT_HASHES = 32;

const now = () => performance.now();

const stopMessage = (error: LockstepError): string => {
  const { reason } = error;
  switch (reason.kind) {
    case "desync": {
      return `The run stopped: the players' games no longer match. ${error.message}.`;
    }
    case "contentMismatch": {
      return `Your game content differs from the host's, so you can't play this run together (host ${reason.hostContentHash}, yours ${reason.localContentHash}).`;
    }
    case "removed": {
      return `The host removed you from the run at step ${reason.step}: it waited on you too long.`;
    }
    case "hostLost": {
      return `Lost the host: nothing heard for ${Math.round(reason.silentMs / 1000)} s. The run is over.`;
    }
  }
};

/**
 * One player's side of a co-op survivors run in the browser (#25): the lobby over the
 * signalling worker and WebRTC, then a lockstep session stepped on a worker's timer, and a view
 * drawn on `requestAnimationFrame`. A hidden tab keeps stepping at full rate, so it holds no one
 * up, and draws nothing, since the browser runs no animation frames for it (ADR-0012). Picks and pause reach the run as this player's step input, never as
 * a `modify` (ADR-0012).
 */
export class CoopClient {
  private readonly options: CoopClientOptions;
  private readonly listeners = new Set<(event: CoopEvent) => void>();
  private room: SignallingRoom | null = null;
  private stopRoom: (() => void) | null = null;
  private content: GameContent | null = null;
  private heroId = "";
  /** The lobby: the host keeps it; a guest has the host's last word on it. */
  private roster: LobbyPlayer[] = [];
  private session: LockstepSession<World, SurvivorsEvent> | null = null;
  private slot = 0;
  private players: readonly string[] = [];
  /** Stops the ticker, while one runs. */
  private stopTicking: (() => void) | null = null;
  private failed = false;
  /** The run ended: what the session reports after that (the others leaving) is no failure. */
  private ended = false;
  private waitingKey = "";
  /** Since when stepping has waited without a break, or null. */
  private waitingSinceMs: number | null = null;
  /** The local player's pick, sent with every step's input until its offer closes. */
  private pick: UpgradePick | null = null;
  private paused = false;
  private readonly input: Mutable<HeroInput> = { moveX: 0, moveZ: 0 };
  private readonly hashes = new Map<number, number>();
  private attached: {
    readonly element: HTMLElement;
    readonly art: SurvivorsArt;
    readonly controller: InputController<keyof typeof MOVE_AXES>;
    view: GameView<World>;
    frame: number;
  } | null = null;

  constructor(options: CoopClientOptions) {
    this.options = options;
  }

  subscribe(listener: (event: CoopEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Opens a room as its host, playing `heroId`. */
  host(content: GameContent, heroId: string): void {
    this.reset(content, heroId);
    const room =
      this.options.rooms?.host() ?? hostRoom(this.options.signalling);
    this.openRoom(room);
  }

  /** Joins the room with join code `code`, playing `heroId`. */
  join(content: GameContent, code: string, heroId: string): void {
    this.reset(content, heroId);
    const room =
      this.options.rooms?.join(code) ?? joinRoom(this.options.signalling, code);
    this.openRoom(room);
  }

  /** Changes the local player's hero in the lobby. */
  chooseHero(heroId: string): void {
    this.heroId = heroId;
    const { room } = this;
    if (room === null || this.session !== null) {
      return;
    }
    if (room.role === "host") {
      this.setHero(room.self ?? room.host, heroId);
    } else {
      this.sendToHost({ type: "hero", heroId });
    }
  }

  /**
   * Host: starts the run with everyone linked, once there are at least two players and each
   * has a hero. The worker confirms, then each guest is told the players and their heroes.
   */
  start(): void {
    if (!this.canStart()) {
      return;
    }
    this.room!.start();
  }

  /** Whether `start` would start: host, in the lobby, at least two players, every hero picked. */
  canStart(): boolean {
    return (
      this.room?.role === "host" &&
      this.room.status === "open" &&
      this.roster.length >= 2 &&
      this.roster.every((player) => player.heroId !== "")
    );
  }

  /** Picks choice `index` of the local hero's offer `offer`, as step input. */
  pickUpgrade(offer: number, index: number): void {
    this.pick = { offer, index };
  }

  /** Holds the run paused for everyone while this player's hero is playing, as step input. */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** Leaves the lobby or the run. The others see this player stop sending (ADR-0012's drop-out). */
  leave(): void {
    this.reset(null, "");
  }

  /**
   * Draws the run into `element` with `art` (the app's sprite sheet) on every animation frame,
   * and reads input from it.
   */
  attach(element: HTMLElement, art: SurvivorsArt): () => void {
    this.detach();
    const controller = new InputController(element, { axes: MOVE_AXES });
    const attached = {
      element,
      art,
      controller,
      view: this.makeView(element, art),
      frame: 0,
    };
    const frame = (timeMs: number) => {
      attached.frame = requestAnimationFrame(frame);
      // Tick here too: when drawing keeps the main thread busy, the timer's messages wait, and a
      // tick per frame keeps input flowing. Ticks go by the clock, so an extra one only runs
      // sooner. A hidden tab gets no frames: the worker's ticks alone step it, and nothing draws.
      this.tick();
      attached.view.render(this.session?.state ?? null, timeMs / 1000);
    };
    attached.frame = requestAnimationFrame(frame);
    this.attached = attached;
    return () => {
      if (this.attached === attached) {
        this.detach();
      }
    };
  }

  /** For tests and debugging: the run's step, its stop error and its recent state hashes by step. */
  debug(): {
    readonly stepIndex: number;
    readonly error: string | null;
    readonly hashes: Readonly<Record<number, number>>;
  } {
    return {
      stepIndex: this.session?.stepIndex ?? 0,
      error: this.session?.error?.message ?? null,
      hashes: Object.fromEntries(this.hashes),
    };
  }

  private detach() {
    const { attached } = this;
    if (attached === null) {
      return;
    }
    cancelAnimationFrame(attached.frame);
    attached.controller.dispose();
    attached.view.dispose();
    this.attached = null;
  }

  private emit(event: CoopEvent) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private reset(content: GameContent | null, heroId: string) {
    this.stopTicker();
    this.session?.dispose();
    this.session = null;
    this.stopRoom?.();
    this.stopRoom = null;
    this.room?.close();
    this.room = null;
    this.content = content;
    this.heroId = heroId;
    this.roster = [];
    this.slot = 0;
    this.players = [];
    this.failed = false;
    this.ended = false;
    this.waitingKey = "";
    this.waitingSinceMs = null;
    this.pick = null;
    this.paused = false;
    this.hashes.clear();
    this.rebuildView();
  }

  private fail(message: string) {
    if (this.failed) {
      return;
    }
    this.failed = true;
    this.stopTicker();
    // The view keeps drawing the run as it stopped.
    this.stopRoom?.();
    this.stopRoom = null;
    this.room?.close();
    this.emit({ type: "failed", message });
  }

  private stopTicker() {
    this.stopTicking?.();
    this.stopTicking = null;
  }

  private openRoom(room: SignallingRoom) {
    this.room = room;
    this.stopRoom = room.subscribe((event) => this.onRoom(room, event));
  }

  private onRoom(room: SignallingRoom, event: RoomEvent) {
    switch (event.type) {
      case "welcome": {
        this.roster =
          room.role === "host" ? [{ id: event.self, heroId: this.heroId }] : [];
        this.emitLobby();
        return;
      }
      case "peer-connected": {
        event.link.messages.listen((text) =>
          this.onLobbyMessage(event.link, text)
        );
        if (room.role === "host") {
          this.roster.push({ id: event.peer, heroId: "" });
          this.shareLobby();
        } else {
          this.sendToHost({ type: "hero", heroId: this.heroId });
        }
        return;
      }
      case "peer-left": {
        this.roster = this.roster.filter((player) => player.id !== event.peer);
        this.shareLobby();
        return;
      }
      case "started": {
        if (room.role === "host") {
          this.beginAsHost(room);
        }
        return;
      }
      case "failed": {
        if (this.session === null) {
          this.fail(event.message);
        }
      }
    }
  }

  private onLobbyMessage(link: PeerLink, text: string) {
    const message = parseLobbyMessage(text);
    const { room } = this;
    if (message === undefined || room === null || this.session !== null) {
      return;
    }
    if (room.role === "host") {
      if (message.type === "hero") {
        this.setHero(link.peer, message.heroId);
      }
      return;
    }
    if (message.type === "lobby") {
      this.roster = [...message.players];
      this.emitLobby();
    } else if (message.type === "start") {
      this.beginAsGuest(room, message.players, message.heroIds);
    }
  }

  private setHero(peer: string, heroId: string) {
    this.roster = this.roster.map((player) =>
      player.id === peer ? { id: peer, heroId } : player
    );
    this.shareLobby();
  }

  /** Host: tells every guest the lobby, and the app. */
  private shareLobby() {
    const { room } = this;
    if (room?.role === "host") {
      const text = encodeLobbyMessage({ type: "lobby", players: this.roster });
      for (const link of room.links()) {
        link.messages.send(text);
      }
    }
    this.emitLobby();
  }

  private sendToHost(message: LobbyMessage) {
    const link = this.room
      ?.links()
      .find((candidate) => candidate.peer === this.room!.host);
    link?.messages.send(encodeLobbyMessage(message));
  }

  private emitLobby() {
    const { room } = this;
    if (room === null) {
      return;
    }
    this.emit({
      type: "lobby",
      role: room.role,
      code: room.code ?? "",
      self: room.self ?? "",
      players: this.roster,
    });
  }

  /** Host: the worker confirmed the start. Everyone linked plays, in lobby order. */
  private beginAsHost(room: SignallingRoom) {
    const linked = new Set(room.links().map((link) => link.peer));
    const fallback = this.content!.heroes[0]!.id;
    const players = this.roster.filter(
      (player) => player.id === room.self || linked.has(player.id)
    );
    const ids = players.map((player) => player.id);
    const heroIds = players.map((player) => player.heroId || fallback);
    const text = encodeLobbyMessage({ type: "start", players: ids, heroIds });
    for (const link of room.links()) {
      link.messages.send(text);
    }
    const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
    this.begin(room, ids, heroIds, (options) =>
      hostLockstep({ ...options, peers: ids.slice(1), seed }, now())
    );
  }

  private beginAsGuest(
    room: SignallingRoom,
    players: readonly string[],
    heroIds: readonly string[]
  ) {
    if (!players.includes(room.self ?? "")) {
      this.fail("The run started without you.");
      return;
    }
    this.begin(room, players, heroIds, (options) =>
      joinLockstep({ ...options, host: room.host }, now())
    );
  }

  private begin(
    room: SignallingRoom,
    players: readonly string[],
    heroIds: readonly string[],
    open: (options: SessionOptions) => LockstepSession<World, SurvivorsEvent>
  ) {
    const self = room.self ?? room.host;
    const content = this.content!;
    this.players = players;
    this.slot = players.indexOf(self);
    this.rebuildView();
    const session = open({
      simulation: survivorsSimulation,
      config: { content, heroIds },
      contentHash: contentHash(content),
      transport: linksTransport(self, room.links()),
      local: this.localInput(),
      codec: schemaCodec(HeroInput),
      combine: combineHeroInputs(players),
      hash: (world) => this.recordHash(world),
      inputDelay: this.options.inputDelay ?? 4,
      hashEvery: this.options.hashEvery ?? 60,
    });
    this.session = session;
    session.subscribe((event) => this.onGameEvent(event));
    this.emit({
      type: "started",
      slot: this.slot,
      players: players.map(playerName),
    });
    const ticker = this.options.ticker ?? workerTicker({ everyMs: TICK_MS });
    this.stopTicking = ticker(() => this.tick());
  }

  private tick() {
    const { session } = this;
    if (session === null || this.failed) {
      return;
    }
    const nowMs = now();
    session.tick(nowMs);
    if (session.error !== null) {
      if (this.ended) {
        // The others left the ended run: stop quietly, keeping its summary on screen.
        this.stopTicker();
      } else {
        this.fail(stopMessage(session.error));
      }
      return;
    }
    if (this.ended) {
      // Nothing is left to wait on or choose.
      return;
    }
    if (session.waitingFor.length === 0) {
      this.waitingSinceMs = null;
    } else {
      this.waitingSinceMs ??= nowMs;
    }
    const waitingFor =
      this.waitingSinceMs !== null &&
      nowMs - this.waitingSinceMs >= WAITING_SHOWN_MS
        ? session.waitingFor.map(playerName)
        : [];
    const world = session.state;
    const choosing =
      world !== null && isChoosing(world)
        ? world.heroes
            .filter((hero) => hero.offer !== null && hero.slot !== this.slot)
            .map((hero) => playerName(this.players[hero.slot] ?? ""))
        : [];
    const key = `${waitingFor.join(",")}|${choosing.join(",")}`;
    if (key !== this.waitingKey) {
      this.waitingKey = key;
      this.emit({ type: "waiting", waitingFor, choosing });
    }
  }

  private onGameEvent(event: SurvivorsEvent) {
    switch (event.type) {
      case "hud": {
        this.emit(event);
        return;
      }
      case "levelUp": {
        if (event.hero === this.slot) {
          this.emit({
            type: "levelUp",
            offer: event.offer,
            choices: event.choices,
          });
        }
        return;
      }
      case "runEnded": {
        this.ended = true;
        const summary = event.summaries[this.slot];
        if (summary !== undefined) {
          this.emit({ type: "runEnded", summary });
        }
      }
    }
  }

  private recordHash(world: World): number {
    const hash = hashWorld(world);
    this.hashes.set(this.session?.stepIndex ?? 0, hash);
    if (this.hashes.size > KEPT_HASHES) {
      this.hashes.delete(this.hashes.keys().next().value!);
    }
    return hash;
  }

  /** The local player's input: the attached device, the pending pick and the pause. One object, refilled. */
  private localInput(): StepInput<HeroInput> {
    const { input } = this;
    return {
      read: () => {
        const controller = this.attached?.controller;
        input.moveX = controller ? controller.axis("moveX") : 0;
        input.moveZ = controller ? controller.axis("moveY") : 0;
        const world = this.session?.state ?? null;
        const { pick } = this;
        if (
          pick !== null &&
          world !== null &&
          (world.offerSeq !== pick.offer ||
            world.heroes[this.slot]?.offer === null)
        ) {
          // Its offer closed: the pick was applied, or the offer ended without it.
          this.pick = null;
        }
        if (this.pick === null) {
          delete input.pick;
        } else {
          input.pick = this.pick;
        }
        if (this.paused) {
          input.paused = true;
        } else {
          delete input.paused;
        }
        return input;
      },
      endFrame: () => this.attached?.controller.endFrame(),
    };
  }

  /** Draws from the local hero's point of view: a new view when the slot is known. */
  private rebuildView() {
    const { attached } = this;
    if (attached !== null) {
      attached.view.dispose();
      attached.view = this.makeView(attached.element, attached.art);
    }
  }

  /** The drawing view, and the sound view beside it, both for the local hero. */
  private makeView(element: HTMLElement, art: SurvivorsArt): GameView<World> {
    const localHero = this.slot;
    const view = new SurvivorsView(element, art, { localHero });
    const { sound } = this.options;
    return sound === undefined
      ? view
      : combineViews<World>(
          view,
          new SurvivorsSoundView({ ...sound, localHero })
        );
  }
}
