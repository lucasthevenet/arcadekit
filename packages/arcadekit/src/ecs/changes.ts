/**
 * Change logs: what happened to a component, in the order it happened, for the
 * queries that watch it, with each reader's place in it.
 *
 * No Effect dependency.
 */
import { INDEX_MASK } from "./component";
import type { ComponentDef, Entity } from "./component";
import { corrupt } from "./snapshot";
import type { World } from "./world";

/**
 * A kind of change to a component that a world logs: `"changed"` for a write,
 * `"added"` or `"removed"`. A change query visits the entities of the first
 * two, and `World.removed` reads the third.
 *
 * @category Models
 */
export type ChangeKind = "changed" | "added" | "removed";

/** A reader's place in a change log. @internal */
export interface ChangeCursor {
  /** Sequence number of the first entry the reader has yet to visit. */
  at: number;
  /** The reader's identity, as a save records it. */
  readonly key: string;
  /** Who reads: the start of `key`, which a view follows with its query. */
  readonly reader: string;
  /**
   * True until the reader's first visit, which covers everything that has the
   * component, since the log only knows what happened after it started.
   */
  fresh: boolean;
  /** False for a reader loaded from a save that no one has requested yet. */
  claimed: boolean;
}

/**
 * One component's changes of one kind, as `World.saveChanges` returns them
 * and a save holds them.
 *
 * @category Models
 */
export interface SavedChanges {
  /** The component's name. */
  readonly component: string;
  /** The kind of change. */
  readonly kind: ChangeKind;
  /**
   * What some reader has yet to visit, oldest first: entity indexes for
   * `changed` and `added`, entity ids for `removed`.
   */
  readonly entries: readonly number[];
  /** For each reader, how many of the entries it has visited. */
  readonly readers: Readonly<Record<string, number>>;
}

/**
 * What happened to one component, in the order it happened, for the queries
 * that watch it: which entities had it written, or gained it, or lost it.
 *
 * Every reader has a place in the log and visits what was logged since its
 * last visit, so each reader sees each change once however often it runs.
 * Entries every reader has visited are forgotten.
 *
 * A `changed` or `added` log holds entity indexes, at most one for each
 * entity that no reader has visited yet: `noted` says, per entity, whether
 * it has one. A `removed` log holds entity ids, one per removal.
 * @internal
 */
export class ChangeLog {
  /** Entity indexes, or entity ids for a `removed` log, which are wider. */
  private entries: Uint32Array | Float64Array;
  /** The position in `entries` of the entry numbered `base`. */
  private first = 0;
  /** Sequence number of the oldest entry kept. */
  base = 0;
  /** One past the sequence number of the newest entry. */
  end = 0;
  /**
   * For each entity index, 1 when the entity has an entry no reader has
   * visited, so it doesn't need logging again. Those are the entries from
   * `floor` on.
   */
  noted: Uint8Array;
  /**
   * Where the log ended the last time a reader visited. A reader visits up to
   * the end, so entries before this have been visited by someone.
   */
  private floor = 0;
  readonly cursors: ChangeCursor[] = [];
  /** Where the log ended when the current transaction began. */
  txEnd = 0;
  /**
   * Once the world has captured a moment, the sequence number from which the
   * entries may be of changes since the last capture: they are kept as a
   * reader's would be, for the world to take at the next capture or rewind.
   */
  kept: number | undefined;

  constructor(
    readonly def: ComponentDef,
    readonly kind: ChangeKind,
    private readonly world: World
  ) {
    // As long as the world's own records, and grown with them, so that a
    // read is never past its end: a read past the end of a typed array
    // makes every later read at that place in the code slower.
    this.noted = new Uint8Array(
      kind === "removed" ? 0 : world._recTable.length
    );
    this.entries = this.room(64);
  }

  /** Allocates an array for this many entries, of the type this log holds. */
  private room(size: number): Uint32Array | Float64Array {
    return this.kind === "removed"
      ? new Float64Array(size)
      : new Uint32Array(size);
  }

  /** Records that the entity at `index` changed, unless a pending entry already says so. */
  note(index: number): void {
    if (this.noted[index] === 1) {
      return;
    }
    this.push(index);
    this.noted[index] = 1;
  }

  /** Makes room for the flags of `size` entities. */
  grow(size: number): void {
    if (this.kind !== "removed" && size > this.noted.length) {
      const noted = new Uint8Array(size);
      noted.set(this.noted);
      this.noted = noted;
    }
  }

  /** Records rows `[start, end)` of a table's entities, or of a sparse set's members. */
  noteRows(
    entities: Uint32Array | Float64Array,
    start: number,
    end: number
  ): void {
    // Room for all of them first, so that the loop is two reads, a
    // comparison and, for a row not noted yet, two writes.
    while (
      this.first + (this.end - this.base) + (end - start) >
      this.entries.length
    ) {
      this.makeRoom();
    }
    const { entries, noted } = this;
    let tail = this.first + (this.end - this.base);
    const before = tail;
    for (let row = start; row < end; row++) {
      const index = entities[row]! & INDEX_MASK;
      if (noted[index] === 1) {
        continue;
      }
      entries[tail++] = index;
      noted[index] = 1;
    }
    this.end += tail - before;
  }

  /** Appends an entry regardless of what the log holds: an entity id, for a removal. */
  push(value: number): void {
    let tail = this.first + (this.end - this.base);
    if (tail === this.entries.length) {
      tail = this.makeRoom();
    }
    this.entries[tail] = value;
    this.end++;
  }

  /** Makes room for one more entry and returns its position. */
  private makeRoom(): number {
    // A reader that has not run for a long time keeps everything logged
    // since. Before the log outgrows the world, entities logged more than
    // once are brought down to once. Not in a transaction, whose rollback
    // counts on the entries staying where they are.
    if (
      this.kind !== "removed" &&
      !this.world._recording &&
      this.end - this.base > 2 * this.world._slots + 1024
    ) {
      this.compact();
    }
    const size = this.end - this.base;
    if (size > this.entries.length >> 1 || this.first === 0) {
      const entries = this.room(this.entries.length * 2);
      entries.set(this.entries.subarray(this.first, this.first + size));
      this.entries = entries;
    } else {
      this.entries.copyWithin(0, this.first, this.first + size);
    }
    this.first = 0;
    return size;
  }

  /**
   * Keeps the newest entry of every entity and drops the rest. Each reader
   * still visits exactly the entities it had yet to visit: an entity with an
   * entry at or after a reader's position has its newest one there.
   */
  private compact(): void {
    const { cursors, entries, first } = this;
    const size = this.end - this.base;
    const seen = new Uint8Array(this.world._slots);
    // Readers from the one furthest on: each new place is the end less the
    // entries kept at or past the old one. The floor moves as a reader's
    // place does.
    const floor = { at: this.floor };
    const held = { at: this.kept ?? this.end };
    const byPlace = [...cursors, floor, held].toSorted((a, b) => b.at - a.at);
    const places: number[] = [];
    let next = 0;
    let kept = 0;
    let write = first + size;
    for (let read = first + size - 1; read >= first; read--) {
      const sequence = this.base + (read - first);
      while (next < byPlace.length && byPlace[next]!.at > sequence) {
        places[next++] = this.end - kept;
      }
      const index = entries[read]!;
      if (seen[index] === 1) {
        continue;
      }
      seen[index] = 1;
      entries[--write] = index;
      kept++;
    }
    while (next < byPlace.length) {
      places[next++] = this.end - kept;
    }
    for (let i = 0; i < byPlace.length; i++) {
      byPlace[i]!.at = places[i]!;
    }
    this.first = write;
    this.base = this.end - kept;
    // An entity that is noted has one entry past the floor, its newest,
    // which was kept: `noted` stands as it is.
    this.floor = floor.at;
    if (this.kept !== undefined) {
      this.kept = held.at;
    }
    this.moved();
  }

  /**
   * Returns the reader identified by `key`: the one a save restored, at its
   * position, or a new one that starts by visiting everything.
   */
  cursor(key: string, fresh = true): ChangeCursor {
    for (const cursor of this.cursors) {
      if (cursor.key === key) {
        if (cursor.claimed) {
          throw new Error(
            `Two readers of what ${this.kind === "removed" ? "lost" : this.kind} "${this.def.name}" are both known as ${JSON.stringify(key)}.`
          );
        }
        cursor.claimed = true;
        return cursor;
      }
    }
    const cursor = {
      at: this.end,
      key,
      reader: readerOf(key),
      fresh,
      claimed: true,
    };
    this.cursors.push(cursor);
    return cursor;
  }

  /**
   * Moves every cursor of `reader` that has visited to the end, as a visit
   * would: what was logged so far is no longer waiting for it.
   */
  skip(reader: string): void {
    let moved = false;
    for (const cursor of this.cursors) {
      if (cursor.reader === reader && !cursor.fresh && cursor.at !== this.end) {
        this.world._reading(cursor);
        cursor.at = this.end;
        moved = true;
      }
    }
    if (moved) {
      this.world._read(this);
    }
  }

  /** Returns a copy of the entries from sequence number `from` on. */
  since(from: number): Uint32Array | Float64Array {
    return this.entries.slice(
      this.first + (Math.max(from, this.base) - this.base),
      this.first + (this.end - this.base)
    );
  }

  /**
   * Keeps what changes from now on, at a capture. An entity noted since the
   * last visit has no new entry when it changes again: its entry is kept.
   */
  captured(): void {
    this.kept =
      this.kind === "removed" ? this.end : Math.max(this.floor, this.base);
    this.moved();
  }

  /** Copies the entries from sequence number `from` on into `into` at `offset`. */
  copy(from: number, into: Uint32Array | Float64Array, offset: number): void {
    const start = this.first + (Math.max(from, this.base) - this.base);
    into.set(
      this.entries.subarray(start, this.first + (this.end - this.base)),
      offset
    );
  }

  /** Returns how many entries a reader at `from` has yet to visit. */
  waiting(from: number): number {
    return this.end - Math.max(from, this.base);
  }

  /**
   * Call when a reader has visited up to the end. The entities logged since the
   * last visit have now been visited by someone, so the next write of each is
   * logged again.
   */
  visited(): void {
    if (this.kind !== "removed") {
      const { entries, noted } = this;
      const to = this.first + (this.end - this.base);
      for (
        let at = this.first + (Math.max(this.floor, this.base) - this.base);
        at < to;
        at++
      ) {
        noted[entries[at]!] = 0;
      }
    }
    this.floor = this.end;
    this.moved();
  }

  /** Drops the entries every reader has visited. */
  moved(): void {
    // Not in a transaction: a rollback puts readers back where they were,
    // and they need the entries they had visited to be there still.
    if (this.world._recording) {
      return;
    }
    let min = this.kept ?? this.end;
    for (const cursor of this.cursors) {
      if (cursor.at < min) {
        min = cursor.at;
      }
    }
    if (min > this.base) {
      this.first += min - this.base;
      this.base = min;
    }
    if (this.base === this.end) {
      this.first = 0;
    }
  }

  /** Drops every entry made since the transaction began. */
  rollback(): void {
    const kept = this.first + (this.txEnd - this.base);
    if (this.kind !== "removed") {
      for (let at = this.first + (this.end - this.base) - 1; at >= kept; at--) {
        // Its entity is logged afresh the next time it is written.
        this.noted[this.entries[at]!] = 0;
      }
    }
    this.end = this.txEnd;
    // A visit inside the transaction went to an end that is gone.
    if (this.floor > this.end) {
      this.floor = this.end;
    }
    // A reader that was new in the transaction started at an end that is gone.
    for (const cursor of this.cursors) {
      if (cursor.at > this.end) {
        cursor.at = this.end;
      }
    }
  }

  /** Returns what the readers `keep` accepts have yet to visit, for a save. */
  save(keep: (key: string) => boolean): SavedChanges | undefined {
    const readers: Record<string, number> = {};
    let from = this.end;
    let any = false;
    for (const cursor of this.cursors) {
      if (!cursor.fresh && keep(cursor.key)) {
        any = true;
        from = Math.min(from, Math.max(cursor.at, this.base));
      }
    }
    if (!any) {
      return undefined;
    }
    for (const cursor of this.cursors) {
      if (!cursor.fresh && keep(cursor.key)) {
        readers[cursor.key] = Math.max(cursor.at, this.base) - from;
      }
    }
    const start = this.first + (from - this.base);
    return {
      component: this.def.name,
      kind: this.kind,
      entries: Array.from(
        this.entries.subarray(start, this.first + (this.end - this.base))
      ),
      readers,
    };
  }

  /** Loads what a save held. The log must be new, with nothing logged in it yet. */
  restore(saved: SavedChanges): void {
    const { entries } = saved;
    const limit =
      this.kind === "removed" ? Number.MAX_SAFE_INTEGER + 1 : this.world._slots;
    this.entries = this.room(Math.max(64, entries.length * 2));
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (!Number.isInteger(entry) || entry < 0 || entry >= limit) {
        throw corrupt(
          `the changes it holds for "${this.def.name}" name an entity that cannot be`
        );
      }
      this.entries[i] = entry;
    }
    this.end = entries.length;
    if (this.kept !== undefined) {
      this.kept = this.end;
    }
    for (const [key, visited] of Object.entries(saved.readers)) {
      if (!Number.isInteger(visited) || visited < 0 || visited > this.end) {
        throw corrupt(
          `a reader of the changes to "${this.def.name}" is further than they go`
        );
      }
      this.cursors.push({
        at: visited,
        key,
        reader: readerOf(key),
        fresh: false,
        claimed: false,
      });
    }
    this.moved();
  }
}

/**
 * A reader of the entities that lost one component, by `remove` or by being
 * despawned. `World.removed` returns one. Each `read` returns the removals
 * since the last, oldest first, so the reader sees each removal once.
 *
 * **Gotchas**
 *
 * A reader obtained before `World.restore` throws when it is read. Obtain it
 * again, as a system does every tick.
 *
 * @category Models
 */
export class RemovedReader {
  private readonly restored: number;

  /** @internal */
  constructor(
    private readonly world: World,
    private readonly log: ChangeLog,
    private readonly cursor: ChangeCursor
  ) {
    this.restored = world._restored;
  }

  /**
   * Returns the ids of the entities that lost the component since the last
   * call. An id whose entity was despawned refers to no entity. An id whose
   * component was only removed still refers to its entity, unless the entity
   * was despawned since.
   */
  read(): Entity[] {
    if (this.restored !== this.world._restored) {
      throw new Error(
        "A reader of removed components was used after its world was restored from a snapshot. Ask for it again: world.removed(component), or yield* the query."
      );
    }
    const { cursor, log } = this;
    const count = log.waiting(cursor.at);
    if (count === 0) {
      return [];
    }
    const ids = new Float64Array(count);
    log.copy(cursor.at, ids, 0);
    this.world._reading(cursor);
    cursor.at = log.end;
    this.world._read(log);
    return Array.from(ids) as Entity[];
  }
}

/** Who a cursor's key belongs to: a view's key goes on with its query. */
const readerOf = (key: string): string => key.split("\n", 1)[0]!;
