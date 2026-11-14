# arcadekit

Versions up to 0.2.3 were published as the nine `@arcadekit/*` packages (core, input, content, save, audio, render-three, runtime, net and foldkit); their entries are merged here.

## 0.7.0

### Minor Changes

- [#97](https://github.com/lucasthevenet/arcadekit/pull/97) [`7f5c65d`](https://github.com/lucasthevenet/arcadekit/commit/7f5c65d962103bf26bad9e26ecc388f56a633117) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `EntityPool.add` and `EntityPool.addWithId` give a slot whose fields are all 0. `arcadekit/core` gains `StateHash`, the FNV-1a both action games hash their state with, and `EntityPool.visit`. **Breaking**: a slot from `add` no longer holds the values of the entity that had it before. (The names are 0.7.0's: see the changeset that gives core Effect's module shape.)

  Two things every game wrote around a pool are the pool's own. A slot came back holding what its last entity left, so each spawn wrote every field, zeros included, and a field added to a layout later was one forgotten write away from carrying a dead entity's value into a new one. And around the list of numbers its state hash covers, each game wrote the same fold and the same walk over a pool's live fields. Both are plain code in `arcadekit/core`, with no Effect and no clock: `add` runs in a step and allocates nothing, and a hash is taken by a host or a test between steps, never by the rules.

  - **`EntityPool.add` and `EntityPool.addWithId`.** Every field of the slot they reserve is 0: after a `remove`, after a `clear` and on the slot's first use. It costs one write per field for each entity added, and nothing in a step that adds none. A spawn writes only the fields that start at something else.
  - **`StateHash`.** FNV-1a, 32 bits, over each number's eight bytes as a float64, so a change in any bit shows. A NaN is the exception: every NaN has the same digest, since an engine may hold one in any of its bit patterns and no rule can tell them apart. `StateHash.add(hash, value)` folds one number in and allocates nothing; a game's list that takes an `add` is given a function that calls it, made once. `StateHash.digest(hash)` gives an unsigned 32-bit integer, `0x811c9dc5` with nothing folded in, and `StateHash.reset(hash)` starts again from there. `add` and `reset` return the state hash.
  - **`EntityPool.visit(pool, f)`.** Calls `f` with the pool's `count`, then with each field's live values, one field at a time in the layout's order, and allocates nothing. It does not visit an identified pool's ids: they follow from the order of its adds and removes.

  The game still lists its numbers, in its order: the kit never looks inside a state, and what only a view reads is left out by not being listed.

  ```ts
  import { EntityPool, StateHash } from "arcadekit/core";

  const cars = EntityPool.make(8, {
    x: Float32Array,
    speed: Float32Array,
    lap: Uint8Array,
  });
  const race = { time: 0, metres: 0, cars };

  // Before: every field at every add, zeros included.
  //   cars.fields.x[i] = 4; cars.fields.speed[i] = 0; cars.fields.lap[i] = 0;
  const i = EntityPool.add(cars);
  if (i !== -1) {
    cars.fields.x[i] = 4;
  }

  // Before: an FNV-1a of the game's own, and its loop over Object.values(pool.fields).
  const hash = StateHash.make();
  const add = (value: number): void => {
    StateHash.add(hash, value);
  };
  const hashRace = (): number => {
    StateHash.reset(hash).pipe(
      StateHash.add(race.time),
      StateHash.add(race.metres)
    );
    EntityPool.visit(race.cars, add);
    return StateHash.digest(hash);
  };
  ```

  A view that keeps something per entity keys it on an identified pool's `EntityPool.idOf`, never on the index, which moves when another entity is removed. Survivors' enemies and gems are identified pools for that: its view takes each one's animation phase from its id, where it guessed which entity was which from where each was the frame before.

  **Breaking**

  - A slot from `EntityPool.add` or `EntityPool.addWithId` holds 0 in every field, where it held what the slot's last entity left. Code that read a field of a new entity before writing it reads 0. No signature changes, and every export is new.
  - A game that wrote every field at every `add` records the same hashes as before, as survivors does: an identified pool hashes as a pool does, since an id is in no field, and `StateHash` and `EntityPool.visit` are the fold and the walk each game wrote, moved. One thing differs: a game's own hasher folded a NaN as whichever bits the engine held it in, so two equal states could have two hashes. A hash recorded over a state that holds a NaN may move; one over a state with none does not.

- [#97](https://github.com/lucasthevenet/arcadekit/pull/97) [`9246aad`](https://github.com/lucasthevenet/arcadekit/commit/9246aadfe705859c6107e90c993eed74d1255d75) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `arcadekit/render-three` gains `SpriteSheet.resolveTags`, `Gait`, batches that grow and `MeshInstances` with a matrix and declared attributes; the new entry `arcadekit/render-three/testing` has `TestSpriteSheet`, `DrawnSprites` and two PNG checks (0.7.0's names: see the changeset that gives render-three Effect's module shape). **Breaking**: `InstancedSprites.set` and `commit` are `push` and `end`, `snap` is one of three words, and `MeshInstances` takes `{ capacity }`.

  Each sprite view wrote the same four things around `InstancedSprites`: a tag lookup with fallbacks, a batch remade when it was too small with a cursor of the view's own, a linger so a walking character does not flicker to idle, and a test that read the batch's shader attributes. And `MeshInstances` took no value for a view's own shader, so a view built its own buffers beside it. All of it is the kit's now, as a view's plain code: no Effect, and no buffer allocated in a frame once a batch has its size. `end` still costs the three small records Three.js keeps of what to upload, as `commit` did.

  - **`SpriteSheet.resolveTags(data, wanted)`.** A view names what it draws once, each name with its tag or the tags to try in order (an `undefined` is skipped). It gives `tags`, with a `SpriteSheet.Tag` under every name: the first choice the sheet has, or a tag named `""` that shows frame 0. And `missing`: every choice tried and not found, once each, in the order tried. A call that misses warns once on the console, naming the sheet's image and each missing tag. The same warning names a name given no tag to try (an empty list, or `undefined`s alone), which draws frame 0 and is in no `missing`.
  - **`InstancedSprites`: `begin`, `push`, `end`.** `InstancedSprites.push(sprites, x, z, frame, flipX?)` adds a sprite and returns its index for the other setters, and `end` shows the sprites pushed since `begin` and uploads them. `capacity` is the room a batch is made with, 64 unless told, and a frame that pushes more doubles it: the `mesh` and its material stay, and the geometry is replaced and the old one freed. A batch filled once keeps showing its last `end`. `count` is the sprites pushed since `begin`. A `capacity` that is no finite number throws a `RangeError`, where it made a batch that drew nothing.
  - **`snap`** is `"sprite"` (the default: whole sprite pixels), `"screen"` (whole screen pixels of the pixel camera that draws the batch, for what slides between two cells) or `"none"`. The rounding is the shader's in all three: a view no longer rounds a position itself. A batch says which it was made with, as `snap`, so a view's test can hold it.
  - **`Gait`.** Whether one character a view draws is walking, from the positions it is shown at: `Gait.update(gait, x, z, time)` once per frame drawn, then `moving`, true from a change of position until `linger` seconds after the last one, and `since`, the time of the update that last changed it. `Gait.reset(gait)` forgets the position, for a new run. It has no facing.
  - **`MeshInstances`.** `MeshInstances.setMatrix(instances, index, matrix)` gives an instance any transform, and `set` stays as the short form. `attributes` declares floats per instance by the name the material's shader reads each under, `MeshInstances.setAttribute(instances, index, name, x, y?, z?, w?)` writes them, and `commit` uploads them. A name that was not declared is a type error, and a throw. The attributes go on the geometry the instances are given and `dispose` takes them off, so making instances throws for a name the geometry already has (`position`, or what other instances over it declared) and for `instanceMatrix` and `instanceColor`, which Three.js reads first.
  - **`arcadekit/render-three/testing`**, a new entry that only tests import. `TestSpriteSheet.fromTags(tags)` is a sheet with the tags a test names, each with its number of 16 px frames, and no image. `DrawnSprites.read(batch)` is every sprite a batch shows, as pushed and set, with the tag that holds its frame. `Png.size(png)` and `Png.framesWithSoftAlpha(png, data, blended?)` check the PNG a game ships: its size, and the frames with a pixel neither clear nor opaque. The entry runs in Node and imports `node:zlib`.

  ```ts
  import { Gait, InstancedSprites, SpriteSheet } from "arcadekit/render-three";

  const TAGS = {
    slime: ["slime/move", "enemy/move"],
    walk: ["hero/walk", "hero/idle"],
    idle: ["hero/idle", "hero/walk"],
  } as const;

  export const makeDraw = (sheet: SpriteSheet.SpriteSheet) => {
    // Before: `sheet.data.tags.get(name)` for each tag, a fallback and a guard for each.
    const { tags } = SpriteSheet.resolveTags(sheet.data, TAGS);
    // Before: `{ capacity }`, worked out for the run, and a batch made again when it was short.
    const sprites = InstancedSprites.make(sheet);
    const gait = Gait.make();

    return (
      enemies: { count: number; x: Float32Array; z: Float32Array },
      hero: { x: number; z: number },
      time: number
    ) => {
      // Before: `sprites.set(i, x, z, frame)` at an index the view counted, then
      // `sprites.commit(count)`.
      InstancedSprites.begin(sprites);
      const slime = SpriteSheet.frameAt(sheet.data, tags.slime, time);
      for (let i = 0; i < enemies.count; i++) {
        InstancedSprites.push(sprites, enemies.x[i]!, enemies.z[i]!, slime);
      }
      // Before: when the hero last moved and where it was, kept by the view.
      Gait.update(gait, hero.x, hero.z, time);
      const tag = gait.moving ? tags.walk : tags.idle;
      const body = InstancedSprites.push(
        sprites,
        hero.x,
        hero.z,
        SpriteSheet.frameAt(sheet.data, tag, time - gait.since)
      );
      InstancedSprites.setLayer(sprites, body, 1);
      InstancedSprites.end(sprites);
    };
  };
  ```

  Both genres use every part. Survivors' view resolves its tags once when it is made and once per run for the tags its content names, pushes into batches it makes once, keeps a `Gait` for each hero, and draws its aura rings through `MeshInstances` with two declared attributes, its shader unchanged. Push-puzzle's view draws from `PUSH_PUZZLE_TAGS`, slides its boxes and its player in a batch that rounds to screen pixels, and walks its player with a `Gait`. Their tests read `DrawnSprites.read`, and their apps' tests check the shipped sheets with `Png.size` and `Png.framesWithSoftAlpha`.

  **Breaking**

  - `InstancedSprites.set(index, x, z, frame, flipX?)` and `commit(count)` are gone. Write `InstancedSprites.begin(sprites)`, then `const index = InstancedSprites.push(sprites, x, z, frame, flipX?)` for each sprite, then `InstancedSprites.end(sprites)`.
  - `InstancedSprites.Options`'s `capacity` is optional, and is the room a batch starts with, not the most it draws. `capacity` on a batch grows.
  - `snap` takes one of three words where it took a boolean: `true` was `"sprite"`, and `false` is `"none"`. A view that rounded positions to screen pixels itself and passed `false` passes `"screen"` and pushes them as they are.
  - `new MeshInstances(geometry, material, capacity)` becomes `MeshInstances.make(geometry, material, { capacity })`.
  - A sprite batch's uniform `uSnap` is `uSnapUnit`, the world units a position is rounded to. A test that read a batch's attributes or uniforms reads `DrawnSprites.read(batch)`.
  - Not in the published package: `@arcadekit/push-puzzle/browser` exports `PUSH_PUZZLE_TAGS`, each name with its tags, in place of the list `PUSH_PUZZLE_SPRITE_TAGS`, and `@arcadekit/survivors/browser` exports `wantedTags(content)`, for `SpriteSheet.resolveTags(data, wantedTags(content)).missing`, in place of `missingSpriteTags(sheet, content)`. A push-puzzle tag missing with all its fallbacks draws frame 0 where it drew nothing.

  No recorded hash moved: only drawing changed.

- [#97](https://github.com/lucasthevenet/arcadekit/pull/97) [`7a3dce6`](https://github.com/lucasthevenet/arcadekit/commit/7a3dce64c0de56c8a092619da66184a70462a8d7) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `arcadekit/core` gains exact math (`ExactMath`), 2D helpers (`Point2`), `ExactMath.hashCell`, timers (`Timer.countDown`, `Timer.takeWhole`), tweens (`Tween.progress` and four eases) and `Rng.pickDistinct`. (The names are 0.7.0's: see the changeset that gives core Effect's module shape.)

  A step may use only exact arithmetic, and core gave it `clamp` alone, so each game wrote the same small functions. They are the kit's now: plain functions a step may call, with no Effect, no clock and no allocation.

  - **Exact math.** `ExactMath.hypot2`, `sin`, `cos` and `powInt`, the replacements for `Math.hypot`, `Math.sin`, `Math.cos` and `**` that give the same bits in every engine, moved from the survivors genre as they were. `ExactMath.lerp(from, to, t)` is `from + (to - from) * t`.
  - **2D helpers.** `Point2.clampLength(point, x, y, max)` writes (x, y) into `point`, shortened to `max` if longer, and returns the length it had. `Point2.moveToward(point, x, y, targetX, targetY, maxStep)` writes the place at most `maxStep` toward a target, and the target itself once it is that near. Both write into a `Point2` the caller made once and owns: there is no vector class.
  - **`ExactMath.hashCell(col, row)`.** A well-spread unsigned 32-bit integer from two whole numbers, for a tile's variant: take `% count` of it, or divide it by 2^32.
  - **Timers.** `Timer.countDown(value, by)` is `Math.max(0, value - by)`: a timer is a number in the state, ready at 0 and armed by writing its length. `Timer.takeWhole(amount)` is the whole units in a budget, for a rate turned into whole spawns.
  - **Tweens.** `Tween.progress(now, startedAt, duration)` goes from 0 to 1, and `Tween.easeIn`, `easeOut`, `easeOutCubic` and `smoothstep` shape it. A tween is a value a view computes each frame, so no object holds one.
  - **`Rng.pickDistinct(rng, items, count)`.** Moves `count` items drawn without repeats to the front of `items`, in place, and returns how many. It draws once for each item it picks. `items` is an array or a typed array: a `readonly` list is a type error, since the pick reorders it. A `count` that is not a whole number of 0 or more is a `RangeError`.

  ```ts
  import { Point2, Rng, Timer } from "arcadekit/core";

  const wish = Point2.make(0, 0);
  const state = { x: 0, hurtTimer: 0, spawnBudget: 0 };
  const dt = 1 / 60;

  // Before: const length = Math.sqrt(x * x + y * y); if (length > 1) { x /= length; y /= length; }
  Point2.clampLength(wish, 0.9, 0.8, 1);
  state.x += wish.x * 6 * dt;

  // Before: state.hurtTimer = Math.max(0, state.hurtTimer - dt);
  state.hurtTimer = Timer.countDown(state.hurtTimer, dt);

  // Before: while (state.spawnBudget >= 1) { state.spawnBudget -= 1; spawn(); }
  state.spawnBudget += 2.5 * dt;
  const due = Timer.takeWhole(state.spawnBudget);
  state.spawnBudget -= due;

  // Before: a partial Fisher-Yates shuffle written with Rng.int.
  const rng = Rng.make(7);
  const upgrades = ["boost", "magnet", "shield", "tyres"];
  const count = Rng.pickDistinct(rng, upgrades, 3);
  const offer = upgrades.slice(0, count);
  ```

  Every export is new. `Rng.pickDistinct` draws as a hand-written pick would: `j = i + Rng.int(rng, items.length - i)`, then a swap of `i` and `j`, for each item it picks.

- [#97](https://github.com/lucasthevenet/arcadekit/pull/97) [`f32b74f`](https://github.com/lucasthevenet/arcadekit/commit/f32b74f0661f22438bf09157ed5903c9ead23e5e) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `arcadekit/core` gains `Ring`, a fixed ring of records in typed arrays that a step pushes to, and `RingReader`, with which a view takes the records written since it last looked. Nothing breaks. (The names are 0.7.0's: see the changeset that gives core Effect's module shape.)

  A view needs to know what a step did: a hit and where it landed, a hole that was filled, an undo. An event is a rare fact for the app, and a cue counter is a count with no place or amount, so each game found its own way: a ring written by hand, a view that compared the state with last frame, a timer in the rules' state that only the view reads. The ring is the kit's now. Both modules are plain code, with no Effect, no clock and no allocation after they are made.

  - **`Ring.make(capacity, layout)`.** A fixed number of records stored as one typed array per field, as a pool's entities are. Record n, counted from 0, is in slot `n % capacity`, which `Ring.slotOf(ring, n)` gives: a new record overwrites the oldest. `Ring.push` reserves the next record's slot and returns it with every field 0. `Ring.pop` forgets the newest record and returns its slot, or -1 when none is held, and `Ring.clear` forgets them all. `written` counts the records pushed and not popped, and `length` those still held, `capacity` at most. A capacity that is not a whole number of 1 or more is a `RangeError`.
  - **`RingReader`.** How far one view has read one ring, made with `RingReader.make()`. `RingReader.take(reader, ring)` gives the number of the first record the reader has not taken, and takes every record up to `ring.written`. The first `take` of a ring gives `written`: a view shows what happens from now on. After that it gives where it stopped, or `written - capacity` if the ring has lapped it, and it starts again at `written` for another ring, after `RingReader.reset`, and when it finds `written` below what it took. It follows a ring whose `written` only grows: it is told of no `pop` or `clear`, so a ring the rules pop or clear is not followed. It writes nothing to the ring, so two views read one ring with a reader each.

  A ring is one of two things, and the game says which by what its rules do with it:

  - **A ring only views read** carries what a step did. The step pushes and never reads it back, so it cannot change what a run does, and the game's state hash leaves it out, as it leaves out its cue counters. It is lossy: a view that looks after more than `capacity` pushes has missed the oldest.
  - **A ring the rules pop or read** is state, like any other field, such as an undo history. A state hash covers it, and no reader follows it.

  ```ts
  import { Ring, RingReader } from "arcadekit/core";

  const hits = Ring.make(64, {
    x: Float32Array,
    z: Float32Array,
    amount: Uint16Array,
  });

  // In the step: one record for the hit.
  const hit = (x: number, z: number, amount: number) => {
    const i = Ring.push(hits);
    hits.fields.x[i] = x;
    hits.fields.z[i] = z;
    hits.fields.amount[i] = amount;
  };

  // In a view, on each frame: the hits since its last one.
  const seen = RingReader.make();
  const render = (show: (x: number, z: number, amount: number) => void) => {
    for (let n = RingReader.take(seen, hits); n < hits.written; n++) {
      const i = Ring.slotOf(hits, n);
      show(hits.fields.x[i]!, hits.fields.z[i]!, hits.fields.amount[i]!);
    }
  };
  ```

  Push-puzzle uses both kinds. Its undo history is a ring its rules pop, in place of one it wrote by hand, and its rules push what a turn did that the board no longer shows to a ring its view reads: a box that filled a hole, and an undo. The view no longer compares the board with last frame.

  Every export is new, and no recorded hash moved.

- [#97](https://github.com/lucasthevenet/arcadekit/pull/97) [`967fd33`](https://github.com/lucasthevenet/arcadekit/commit/967fd33f7151aa9bfa278f36811ec7bb71d286f9) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `arcadekit/core` gains `TileMap`, a grid of cells in typed arrays with `TileMap.neighbor` and `TileMap.flood` (0.7.0's names: see the changeset that gives core Effect's module shape); `arcadekit/render-three` gains `TileLayer`, which draws the cells on screen from a function of the cell, and `PixelCamera.groundOnScreen` (0.7.0's names: see the changeset that gives render-three Effect's module shape). Nothing breaks.

  Two games kept a grid of cells in typed arrays for their rules, and each wrote the same neighbour lookup and flood fill. Two views drew a floor of tiles around the camera, and each read the camera's edges, worked out which cells show and filled a sprite batch with them. Both are the kit's now, as plain code: no Effect, and nothing allocated in a step or in a frame.

  - **`TileMap.make(cols, rows, layout)`.** A level's static cells, stored as a pool's entities are: one typed array per field, `cells` long, with cell (col, row) at `row * cols + col`. `TileMap.cellAt(map, col, row)` gives the cell or -1 off the map, and `TileMap.colOf` and `TileMap.rowOf` give them back. `TileMap.neighbor(map, cell, side)` gives the cell on a `TileMap.Side` (`west`, `east`, `north`, `south`, numbered 0 to 3, north the row above), or -1 off the map, and the neighbour of a cell off the map is -1. `TileMap.flood(map, start, passes, reached)` marks `start` in `reached` with 1, then every cell joined to it by sides through cells `passes` accepts, and returns how many it marked. It does not enter a cell already marked, so two floods share a mask. The map keeps the queue a flood walks, so `TileMap.neighbor` and `TileMap.flood` allocate nothing and a step may call them. A number of columns or of rows that is not a whole number of 1 or more is a `RangeError`, and so is a `reached` mask shorter than the map.
  - **`PixelCamera.groundOnScreen(camera, out)`.** Writes the rectangle of ground the camera shows into a `Camera.MutableGroundBounds` the view keeps, and returns it as a `Camera.GroundBounds`. Call it after `follow` or `fit`.
  - **`TileLayer`.** A grid of cells drawn from a sheet's frames in one draw call. `TileLayer.draw(layer, seen, frameOf)` shows the cells that touch `seen`: cell (col, row) is the square of ground from (col, row) to (col + 1, row + 1), drawn at its centre with the frame `frameOf(col, row)` gives, and left empty for a negative one. It fills a batch of its own, which grows with the window, and fills it again only when `seen` touches other cells or after `TileLayer.invalidate(layer)`. `tint` multiplies every tile's colours, `count` is the tiles of the last fill, and `mesh` goes in the scene. Its options are a batch's `unitsPerPixel` and `layer`. It imports nothing of the rules: a game with a tile map reads it in `frameOf`.
  - **`DrawnSprites.read`** (`arcadekit/render-three/testing`) takes a `TileLayer` as well as a batch, and gives the tiles of its last fill.

  ```ts
  import { TileMap } from "arcadekit/core";
  import { PixelCamera, TileLayer } from "arcadekit/render-three";
  import type { Camera, SpriteSheet } from "arcadekit/render-three";

  const WALL = 1;
  const map = TileMap.make(16, 9, { tile: Uint8Array });
  const { tile } = map.fields;

  // In the rules. Before: the column and the row worked out from the cell, and four bounds.
  export const canMove = (cell: number, side: TileMap.Side): boolean => {
    const target = TileMap.neighbor(map, cell, side);
    return target !== -1 && tile[target] !== WALL;
  };

  // Before: a stack, a `reached` array and a loop over four offsets. The mask is cleared first:
  // a flood enters no cell already marked, so one from a cell an earlier flood marked marks none.
  const reached = new Uint8Array(map.cells);
  const open = (cell: number): boolean => tile[cell] !== WALL;
  export const roomFrom = (cell: number): number => {
    reached.fill(0);
    return TileMap.flood(map, cell, open, reached);
  };

  // In the view. Before: the camera's four edges, floored, a loop over the cells between them
  // and a compare with the window last filled.
  export const makeGround = (
    sheet: SpriteSheet.SpriteSheet,
    camera: PixelCamera.PixelCamera
  ) => {
    const ground = TileLayer.make(sheet);
    const seen: Camera.MutableGroundBounds = {
      minX: 0,
      maxX: 0,
      minZ: 0,
      maxZ: 0,
    };
    const frameOf = (col: number, row: number): number => {
      const cell = TileMap.cellAt(map, col, row);
      return cell === -1 ? -1 : tile[cell]!;
    };
    return {
      mesh: ground.mesh,
      draw: (x: number, z: number): void => {
        PixelCamera.follow(camera, x, z);
        TileLayer.draw(
          ground,
          PixelCamera.groundOnScreen(camera, seen),
          frameOf
        );
      },
    };
  };
  ```

  Both genres use them. Push-puzzle's level is a tile map: its rules ask `TileMap.neighbor` for the cell a move goes to, and its parser floods from the player to find what is outside the walls. Its view draws the board and the menu's floor with one `TileLayer`, dimmed for the menu with `tint`. Survivors' ground is a `TileLayer` that asks which of the arena's tiles a cell shows, and its dirt patches, which are no cells, are a small batch of their own.

  **Breaking**

  - Nothing in the published package: every export is new, and `DrawnSprites.read` takes what it took.
  - Not in the published package: `@arcadekit/push-puzzle`'s exported `Puzzle` has `map` in place of `cols`, `rows`, `tiles` and `goals` (`map.fields.tile` and `map.fields.goal`), and its view draws the board with its corner at the origin, a cell's centre at (col + 0.5, row + 0.5), where the board was centred on the origin. It lands on the same pixels: the camera fits the board where it now is.

  No recorded hash moved: survivors' rules are untouched, and push-puzzle's replay ends in the state it recorded.

- [#99](https://github.com/lucasthevenet/arcadekit/pull/99) [`d0985cb`](https://github.com/lucasthevenet/arcadekit/commit/d0985cb23a15d8a273c33b2a50fd038f7d9bf61f) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `arcadekit/core` is written as Effect's modules are: each of its modules is a namespace, with a data type named after it, its `make`, an `isX` guard, `pipe`, a printed form, and functions that take the value first and, given one argument less, return the function a `pipe` applies. **Breaking**: every export of `arcadekit/core` is renamed or reshaped.

  Core stays plain: a step calls it, so it gives the same bits on every peer and finishes in the call, and it runs no Effect. It imports `effect` only for its shape (`Pipeable`, `Inspectable`, `Predicate`, `dual`). The arithmetic is the same, in the same order: no state hash a game recorded moves, and survivors' replay and determinism hashes hold.

  ```ts
  import { EntityPool, Rng, StateHash } from "arcadekit/core";

  // Before: const rng = makeRng(42); const roll = rng.int(6);
  const rng = Rng.make(42);
  const roll = Rng.int(rng, 6);

  // Before: const enemies = createPool(300, { ... }); const i = enemies.add();
  const enemies = EntityPool.make(300, { x: Float32Array, hp: Float32Array });
  const i = EntityPool.add(enemies);
  enemies.fields.hp[i] = roll;

  // Before: new StateHasher().number(roll).digest(), and visitPool(enemies, hasher.number).
  const hash = StateHash.make().pipe(StateHash.add(roll));
  EntityPool.visit(enemies, (value) => {
    StateHash.add(hash, value);
  });
  const digest = StateHash.digest(hash);
  ```

  **Breaking**

  Every export of `arcadekit/core` before, and what a game writes now:

  | Before | Now |
  | --- | --- |
  | `createPool(capacity, layout)`, `Pool<L>` | `EntityPool.make(capacity, layout)`, `EntityPool.EntityPool<L>` |
  | `pool.add()`, `pool.remove(i)`, `pool.clear()` | `EntityPool.add(pool)`, `EntityPool.remove(pool, i)`, `EntityPool.clear(pool)` |
  | `createIdentifiedPool(capacity, layout)`, `IdentifiedPool<L>` | `EntityPool.makeIdentified(capacity, layout)`, `EntityPool.Identified<L>` |
  | `pool.idOf(i)`, `pool.indexOf(id)`, `pool.addWithId(id)` | `EntityPool.idOf(pool, i)`, `EntityPool.indexOf(pool, id)`, `EntityPool.addWithId(pool, id)` |
  | `PoolLayout`, `PoolFields<L>` | `Layout.Layout`, `Layout.Fields<L>` |
  | `visitPool(pool, visit)` | `EntityPool.visit(pool, f)` |
  | `createRing(capacity, layout)`, `Ring<L>` | `Ring.make(capacity, layout)`, `Ring.Ring<L>` |
  | `ring.push()`, `ring.pop()`, `ring.slotOf(n)`, `ring.clear()` | `Ring.push(ring)`, `Ring.pop(ring)`, `Ring.slotOf(ring, n)`, `Ring.clear(ring)` |
  | `new RingReader()`, `reader.take(ring)`, `reader.reset()` | `RingReader.make()`, `RingReader.take(reader, ring)`, `RingReader.reset(reader)` |
  | `createTileMap(cols, rows, layout)`, `TileMap<L>`, `Side` | `TileMap.make(cols, rows, layout)`, `TileMap.TileMap<L>`, `TileMap.Side` |
  | `map.cellAt(col, row)`, `map.colOf(cell)`, `map.rowOf(cell)`, `map.neighbor(cell, side)`, `map.flood(start, passes, reached)` | `TileMap.cellAt(map, col, row)`, `TileMap.colOf(map, cell)`, `TileMap.rowOf(map, cell)`, `TileMap.neighbor(map, cell, side)`, `TileMap.flood(map, start, passes, reached)` |
  | `new SpatialGrid(options)`, `SpatialGridOptions` | `SpatialGrid.make(options)`, `SpatialGrid.Options` |
  | `grid.build(xs, ys, count, radii?)`, `grid.query(…)`, `grid.within(…)`, `grid.nearest(…)` | `SpatialGrid.build(grid, xs, ys, count, radii?)`, `SpatialGrid.query(grid, …)`, `SpatialGrid.within(grid, …)`, `SpatialGrid.nearest(grid, …)` |
  | `new FixedStepClock(stepSeconds?, maxStepsPerFrame?)` | `FixedStepClock.make({ stepSeconds?, maxStepsPerFrame? })` |
  | `clock.advance(frameSeconds, step)`, `clock.reset()` | `FixedStepClock.advance(clock, frameSeconds, step)`, `FixedStepClock.reset(clock)` |
  | `makeRng(seed)`, `Rng` | `Rng.make(seed)`, `Rng.Rng` |
  | `rng.next()`, `rng.int(max)`, `rng.range(min, max)`, `rng.pickDistinct(items, count)` | `Rng.next(rng)`, `Rng.int(rng, max)`, `Rng.range(rng, min, max)`, `Rng.pickDistinct(rng, items, count)` |
  | `new EventBuffer<E>()`, `events.push(event)`, `events.drain()` | `EventBuffer.make<E>()`, `EventBuffer.push(events, event)`, `EventBuffer.drain(events)` |
  | `new StateHasher()`, `hasher.number(value)`, `hasher.digest()`, `hasher.reset()` | `StateHash.make()`, `StateHash.add(hash, value)`, `StateHash.digest(hash)`, `StateHash.reset(hash)` |
  | `clamp`, `lerp`, `hypot2`, `sin`, `cos`, `powInt`, `hashCell` | `ExactMath.clamp`, `ExactMath.lerp`, `ExactMath.hypot2`, `ExactMath.sin`, `ExactMath.cos`, `ExactMath.powInt`, `ExactMath.hashCell` |
  | `Point2`, a `{ x, y }` the caller writes | `Point2.Point2`, made with `Point2.make(x, y)` |
  | `clampLength(x, y, max, out)`, `moveToward(x, y, targetX, targetY, maxStep, out)` | `Point2.clampLength(out, x, y, max)`, `Point2.moveToward(out, x, y, targetX, targetY, maxStep)`: the point first |
  | `countDown`, `takeWhole` | `Timer.countDown`, `Timer.takeWhole` |
  | `progress`, `easeIn`, `easeOut`, `easeOutCubic`, `smoothstep` | `Tween.progress`, `Tween.easeIn`, `Tween.easeOut`, `Tween.easeOutCubic`, `Tween.smoothstep` |

  And what follows from the shape:

  - **No class and no closure is left**: a pool, a ring, a reader, a tile map, a grid, a clock, an `Rng`, an event buffer and a state hash are values made by their module's `make`, with their state in fields and their behaviour in the module's functions. A function that took one as a method's receiver takes it first.
  - **A value of a data type comes from its `make`.** An object written to look like one is not one: its guard says so, and its type refuses it. A `Point2` is `Point2.make(0, 0)`, where it was the literal `{ x: 0, y: 0 }`, and an `Rng` can't be written by hand.
  - **A list a state hash folds takes a function made once**: `(value) => StateHash.add(hash, value)` in place of `hasher.number`.
  - **Messages name the module's function**: `Ring.make needs a whole capacity of 1 or more`, `TileMap.make needs a whole number of columns and of rows`, `Rng.pickDistinct needs a whole count of 0 or more` and `ExactMath.powInt needs an integer exponent`, where they named `createRing`, `createTileMap`, `pickDistinct` and `powInt`. The other refusals are as they were.
  - **New**: `Layout`, a namespace for the types of a layout and its fields; each data type's guard (`EntityPool.isEntityPool`, `EntityPool.isIdentified`, `Ring.isRing`, `RingReader.isRingReader`, `TileMap.isTileMap`, `SpatialGrid.isSpatialGrid`, `FixedStepClock.isFixedStepClock`, `Rng.isRng`, `EventBuffer.isEventBuffer`, `StateHash.isStateHash`, `Point2.isPoint2`); `pipe` and a printed form on each; `Rng.Rng`'s `state` and `EventBuffer.EventBuffer`'s `pending`, readonly fields that were hidden in a closure or a private field.

  No other entry changes its exports. `RingReader.take` still takes anything with a ring's `capacity` and `written`.

- [#104](https://github.com/lucasthevenet/arcadekit/pull/104) [`74fc8e7`](https://github.com/lucasthevenet/arcadekit/commit/74fc8e706d179ecf092d0a1e85b63e59afd55e98) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `arcadekit/audio` is written as Effect's modules are. `CueTable` keeps its builder, and a genre declares a cue table as before, with `AudioSystem.SoundId` for each cue. What a game plays through is the namespace `AudioSystem`: `AudioSystem.AudioSystem` is the audio system's type, a value with a `TypeId`, and the key of the service an app provides, as Effect's `KeyValueStore` is a store's. The mixer behind the browser's is `AudioMixer`, the player's settings are `AudioSettings`, and the browser's audio system is `BrowserAudioSystem.layer` in `arcadekit/audio/browser`. **Breaking**: every export but `CueTable` and its types moved into a namespace, and `makeAudioMixer` and `makeBrowserAudio` are gone.

  A sound plays, loops, fades, ducks and is dropped as it was, and `load` decodes and fails as it did, with the same messages. What changed besides the names:

  - **A test makes an audio system with `AudioSystem.make`.** It takes the calls the test cares about, and each one it isn't given does nothing, where a test spread `silentAudio` into an object of its own. `AudioSystem.isAudioSystem` tells one from a look-alike.
  - **A mixer lives as long as its scope.** `AudioMixer.make` is scoped and stops every voice when its scope closes, where `mixer.dispose()` did; a mixer whose scope has closed can't be unlocked again. Its jitter comes from Effect's `Random`, read once when it is made, so `random` is no option: a test provides its own `Random`.
  - **Loads are traced** as `AudioSystem.load`, whichever audio system runs them.
  - **The browser's decode fails a response that isn't a success with an `AudioLoadError`** naming its status, rather than throwing inside the promise, and the browser's layer waits for its AudioContext to close when its scope closes.
  - **`AudioLoadError` is a `Schema.TaggedError`**, with the same tag and fields, so `Effect.catchTag("AudioLoadError", ...)` is as it was.

  ```ts
  import { AudioSettings, AudioSystem, CueTable } from "arcadekit/audio";
  import type { CueSoundsOf } from "arcadekit/audio";
  import { BrowserAudioSystem } from "arcadekit/audio/browser";
  import { Setting } from "arcadekit/save";
  import { Effect, Layer } from "effect";

  // Before: lap: SoundId
  export class RaceCueTable extends CueTable("RaceCueTable", {
    cues: { lap: AudioSystem.SoundId },
  }) {}

  // Before: (audio: AudioSystem, sounds: ...) => audio.play(sounds.lap)
  export const playLap = (
    audio: AudioSystem.AudioSystem,
    sounds: CueSoundsOf<typeof RaceCueTable>
  ): void => audio.play(sounds.lap);

  // Before: schema: AudioSettings, default: defaultAudioSettings
  export class RaceAudioSettings extends Setting("RaceAudioSettings", {
    storageKey: "my-studio/race/settings",
    schema: AudioSettings.AudioSettings,
    default: AudioSettings.defaults,
  }) {}

  // Before: applyAudioSettings(yield* Audio, settings), and Layer.provide(BrowserAudioLayer)
  export const applyStored = Effect.gen(function* () {
    const settings = yield* (yield* RaceAudioSettings).read;
    AudioSystem.applySettings(yield* AudioSystem.AudioSystem, settings);
  });

  // Before: { ...silentAudio, play: (id) => played.push(id) }, and Layer.succeed(Audio, audio)
  const played: string[] = [];
  export const recording = Layer.succeed(
    AudioSystem.AudioSystem,
    AudioSystem.make({ play: (id) => played.push(id) })
  );
  export const appAudio = BrowserAudioSystem.layer;
  ```

  **Breaking**

  Every export of `arcadekit/audio` and `arcadekit/audio/browser` before, and what a game writes now:

  | Before | Now |
  | --- | --- |
  | `Audio`, a service class keyed `arcadekit/audio/Audio` | `AudioSystem.AudioSystem`, keyed `arcadekit/audio/AudioSystem` (`uses: { audio: AudioSystem.AudioSystem }`, `yield* AudioSystem.AudioSystem`) |
  | `AudioSystem`, an interface | `AudioSystem.AudioSystem`, the same key's type, with a `TypeId` |
  | an object of a test's own as an audio system | `AudioSystem.make({ ... })`, which `AudioSystem.isAudioSystem` recognises |
  | `silentAudio` | `AudioSystem.silent` |
  | `SilentAudioLayer` | `AudioSystem.layerSilent` |
  | `applyAudioSettings(audio, settings)` | `AudioSystem.applySettings(audio, settings)`, or `audio.pipe(AudioSystem.applySettings(settings))` |
  | `AudioBus`, `SoundDef`, `SoundList` | `AudioSystem.Bus`, `AudioSystem.Sound`, `AudioSystem.SoundList` |
  | `SoundId` | `AudioSystem.SoundId` |
  | `AudioLoadError`, a `Data.TaggedError` | `AudioSystem.AudioLoadError`, a `Schema.TaggedError` with the same tag and fields |
  | `AudioSettings`, a Schema and its type | `AudioSettings.AudioSettings`, a Schema and its type |
  | `defaultAudioSettings` | `AudioSettings.defaults` |
  | `makeAudioMixer({ decode, random, duckedMusic })`, an `Effect<AudioMixer>` | `AudioMixer.make({ decode, duckedMusic })`, an `Effect<AudioMixer.AudioMixer, never, Scope>`; its jitter comes from Effect's `Random` |
  | `AudioMixer`, an `AudioSystem` with `unlock`, `setHidden` and `dispose` | `AudioMixer.AudioMixer`, whose `system` is its audio system; `AudioMixer.unlock(mixer, output)`, `AudioMixer.setHidden(mixer, hidden)`, and its scope in place of `dispose()` |
  | `AudioMixerOptions`, `AudioOutput`, `AudioGain`, `AudioVoice`, `AudioClip` | `AudioMixer.Options`, `AudioMixer.Output`, `AudioMixer.Gain`, `AudioMixer.Voice`, `AudioMixer.Clip` |
  | `makeBrowserAudio` (`arcadekit/audio/browser`) | gone: `BrowserAudioSystem.layer` is the browser's audio system |
  | `BrowserAudioLayer` (`arcadekit/audio/browser`) | `BrowserAudioSystem.layer` (`arcadekit/audio/browser`) |

  `CueTable`, `CueTableClass`, `CueTableDefinition`, `CueTableId`, `CueTableService`, `AnyCueTable`, `CueSounds` and `CueSoundsOf` keep their names, and so do a cue table's `kind`, `cueTableName`, `cues` and `layer`, and an audio system's `play`, `setLoop`, `playMusic`, `setVolume`, `setMuted`, `setDucked` and `load`.

- [#101](https://github.com/lucasthevenet/arcadekit/pull/101) [`c93ae44`](https://github.com/lucasthevenet/arcadekit/commit/c93ae443a50efd8cb1e5014881ac1199167e6b19) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `arcadekit/content` is written as Effect's modules are. `Content` and `Asset` keep their builders, and a game declares them as before. Where a content's files come from is the namespace `ContentSource`: a data type with a `TypeId`, its `make`, `fromRecord`, an `isContentSource` guard, `pipe`, a printed form, and `read`, which takes the source first and, given the file alone, returns the function a `pipe` applies. Its error, `ContentSource.ContentError`, is a `Schema.TaggedError`. The browser's source is `FetchContentSource.fromUrl` in `arcadekit/content/browser`. **Breaking**: every export but the two builders and their types is renamed or reshaped.

  A content loads and checks its files as it did: every file at once, then the Schema, then `validate`, with the same messages, and the first success kept for the app. What changed besides the names:

  - **A content source is a value, not a function.** Make one with `ContentSource.make(read)`, and read a file of one with `ContentSource.read(source, file)`. A function of a file's name is no longer a source, and a declaration's `layer` and `read` refuse one as a type error.
  - **A content error can keep what was thrown.** `ContentError` has an optional `cause` beside its `message`: a source that wraps a throw (a failed `fetch`, a parse) keeps it there. An app still catches it by its tag, `Effect.catchTag("ContentError", ...)`, which didn't change.
  - **The fetch source aborts what it no longer needs.** An interrupted read aborts its request, where before the request ran on. A response that isn't a success fails with `Could not load levels.json: HTTP 404` (it was `... : Error: HTTP 404`), and a body that isn't JSON with `Could not read levels.json as JSON: ...`. Each failure of a request keeps what `fetch` threw as its `cause`.
  - **Loads and reads are traced.** A trace shows each `load` as `<Name>.load` (`PushPuzzleContent.load`, `PushPuzzleSheet.load`), each reading of a content's files as `<Name>.read`, and each file a source reads as `ContentSource.read`. A failure from them carries those spans in its cause's annotations, so a test that compares a whole `Exit` with `Exit.fail(error)` now compares the cause's reasons, or the error itself (`Effect.flip`).
  - **A record source serves only its own keys.** `ContentSource.fromRecord({})` has no file named `"constructor"`, which `memorySource` found on the object's prototype.

  ```ts
  import { readFileSync } from "node:fs";

  import { ContentSource } from "arcadekit/content";
  import { FetchContentSource } from "arcadekit/content/browser";
  import { Effect } from "effect";

  import { RaceContent } from "./content";

  // In the app. Before: RaceContent.layer(fetchJsonSource("/content/"))
  export const contentLayer = RaceContent.layer(
    FetchContentSource.fromUrl("/content/")
  );

  // In a test. Before: const fileSource: ContentSource = (file) => Effect.try({ ... })
  const fileSource = ContentSource.make((file) =>
    Effect.try({
      try: () =>
        JSON.parse(readFileSync(new URL(file, import.meta.url), "utf-8")),
      // Before: new ContentError({ message: String(cause) })
      catch: (cause) =>
        new ContentSource.ContentError({ message: String(cause), cause }),
    })
  );
  export const shipped = RaceContent.read(fileSource);

  // Before: RaceContent.read(memorySource({ "tracks.json": [] }))
  export const empty = RaceContent.read(
    ContentSource.fromRecord({ "tracks.json": [] })
  );
  ```

  **Breaking**

  Every export of `arcadekit/content` and `arcadekit/content/browser` before, and what a game writes now:

  | Before | Now |
  | --- | --- |
  | `ContentSource`, a function `(file) => Effect<unknown, ContentError>` | `ContentSource.ContentSource`, a value made with `ContentSource.make((file) => ...)` |
  | calling a source, `source(file)` | `ContentSource.read(source, file)`, or `source.pipe(ContentSource.read(file))` |
  | `memorySource(files)` | `ContentSource.fromRecord(files)` |
  | `ContentError`, a `Data.TaggedError` with a `message` | `ContentSource.ContentError`, a `Schema.TaggedError` with a `message` and an optional `cause` |
  | `fetchJsonSource(baseUrl)` (`arcadekit/content/browser`) | `FetchContentSource.fromUrl(baseUrl)` (`arcadekit/content/browser`) |
  | `loadOnce(load, release)`, what `Content` and `Asset` are built on | Gone: a declaration's `layer` is the one way to keep a load's first success. Declare an `Asset` for anything an app loads once |

  And what follows from the shape: a source is not a function, so `ContentSource.isContentSource(value)` tells one apart. `Content`, `Asset`, `ContentClass`, `ContentDefinition`, `ContentId`, `ContentService`, `AssetClass`, `AssetId`, `AssetService` and `Loaded` keep their names; `ContentClass`'s `layer` and `read` take a `ContentSource.ContentSource`, and `ContentDefinition` is exported from the same file as `Content`.

- [#107](https://github.com/lucasthevenet/arcadekit/pull/107) [`097602b`](https://github.com/lucasthevenet/arcadekit/commit/097602b8f2a3c8f3a4faa7aeebf3f64447efffa3) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `arcadekit/foldkit` is written as Effect's modules are: its modules are four namespaces, `Viewport`, `EngineEntry`, `KeyPresses` and `ShortcutPresses`, each with a `make`, and every export has Effect's doc comment, with an example that runs. **Breaking**: every export of `arcadekit/foldkit` is renamed.

  What an app sees besides the names:

  - **The viewport and the engine entry work as they did.** `Viewport.make` renders the same `div.viewport`, whose Mount is still named `"GameViewport"`, so a Scene test resolves it as before. `EngineEntry.make` takes the same config (`engine`, `isViewportMounted`, `toMessage`, `onError`, required exactly when the engine can fail), attaches one engine at a time, and sends `onError`'s Message once. A viewport missing from the document still dies; its message now names `Viewport.make`.
  - **Key presses are Effect's own Stream of a DOM event.** `KeyPresses.make` and `ShortcutPresses.make` are `Stream.fromEventListener` on the window's `keydown`, and report the same presses: no auto-repeat, and for a shortcut no Ctrl, Cmd or Alt and no text field. The window is read when the Stream runs, so an app may make one as its module loads (`Subscription.persistentEntry(ShortcutPresses.make(["KeyM"], ...))`) where a test in Node has no window.
  - **`toMessage` is given the code as one of the keys listed.** `KeyPresses.make(["KeyR", "Escape"], (code) => ...)` types `code` as `"KeyR" | "Escape"`, so comparing it with a key that isn't listed is a type error.

  ```ts
  import {
    EngineEntry,
    KeyPresses,
    ShortcutPresses,
    Viewport,
  } from "arcadekit/foldkit";

  // Before: gameViewport(h, { mounted, unmounted })
  Viewport.make(h, { mounted, unmounted });

  // Before: engineEntry({ engine: RaceEngine, isViewportMounted, toMessage, onError })
  EngineEntry.make({
    engine: RaceEngine,
    isViewportMounted,
    toMessage,
    onError,
  });

  // Before: keyPresses(["KeyR"], toMessage) and shortcutPresses(["KeyM"], toMessage)
  KeyPresses.make(["KeyR"], toMessage);
  ShortcutPresses.make(["KeyM"], toMessage);
  ```

  **Breaking**

  Every export of `arcadekit/foldkit` before, and what an app writes now:

  | Before | Now |
  | --- | --- |
  | `gameViewport(h, messages)` | `Viewport.make(h, messages)` |
  | `GameViewportMessages<Message>` | `Viewport.Messages<Message>` |
  | `engineEntry(config)` | `EngineEntry.make(config)` |
  | `EngineEntryConfig<Model, Message, Event, R, E, A>` | `EngineEntry.Config<Model, Message, Event, R, E, A>` |
  | `AttachableEngine<Event, E>` | `EngineEntry.Attachable<Event, E>` |
  | what `engineEntry` returned, Foldkit's `Subscription.EntryWithoutKeepAlive<…>` | the same type, named `EngineEntry.EngineEntry<Model, Message, R>` |
  | `keyPresses(codes, toMessage)` | `KeyPresses.make(codes, toMessage)` |
  | `shortcutPresses(codes, toMessage)` | `ShortcutPresses.make(codes, toMessage)` |

- [#105](https://github.com/lucasthevenet/arcadekit/pull/105) [`78bed96`](https://github.com/lucasthevenet/arcadekit/commit/78bed9609226dbd3e6fd1ab607ec44f1df5be06f) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `arcadekit/game` is written as Effect's modules are, and every export of `arcadekit/game`, `arcadekit/game/browser`, `arcadekit/game/scenario` and `arcadekit/game/testing` has Effect's doc comment, with an example that runs. `Game.Event`, `Game.Command`, `Game.Rejection`, `Game.Simulation` and `Game.Engine` keep their builders, and a game declares its parts as before. **Breaking**: a loop is made with `Game.makeLoop`, the frames a test drives are the namespace `ManualFrames`, and the entry's three errors are `Schema.TaggedError`s.

  What changed besides the names:

  - **A loop is a host with a `TypeId`.** `Game.makeLoop(simulation)` makes a `Game.Loop`, with `pipe` and a printed form, and `Game.isLoop` tells one from a look-alike. Its methods (`start`, `send`, `setPaused`, `stop`, `subscribe`, `frame`) and its `state` and `stepIndex` are as they were, and so is every step it runs: no recorded hash moves.
  - **The running engine is a value with a `TypeId`.** What `yield* MyEngine` gives has `pipe` and a printed form, and `Game.isEngine` recognises it. Its Effects are traced under the declared name: `MyEngine.attach`, `MyEngine.start`, `MyEngine.send`, `MyEngine.listen`, `MyEngine.setPaused` and `MyEngine.stop`.
  - **The frame loop waits on each frame on its own.** `Game.frameLoop` asks for each frame with an `Effect.callback` that cancels it when interrupted, and is traced as `Game.frameLoop`. It still asks for the next frame in the call of the one that drew, so a test's `ManualFrames.runFrameAt` has run the whole frame when it returns. A failure of `attach` or of the frame loop carries the span in its cause: a test that compared the whole `Exit` with `Exit.fail(error)` compares the error instead (`Effect.flip`) or the cause's reasons.
  - **`AttachError`, `GameCrashed` and `CommandDropped` are `Schema.TaggedError`s**, with the fields they had. An app catches each by its tag, as before.
  - **The kernel under the loop is in the entry's `internal/`**, which no entry exports, as before.

  ```ts
  import * as Game from "arcadekit/game/browser";
  import { ManualFrames } from "arcadekit/game/testing";
  import { Layer } from "effect";

  // Before: const loop = new Game.Loop(Race);
  const loop = Game.makeLoop(Race);

  // Before: const frames = manualFrames();
  const frames = ManualFrames.make();
  const frameSource = Layer.succeed(Game.Frames, frames);

  // Before: frames.runFrameAt(16) and frames.waiting()
  ManualFrames.runFrameAt(frames, 16);
  ManualFrames.waiting(frames);
  ```

  **Breaking**

  Every export that changed, and what a game writes now. The others keep their names and types.

  | Before | Now |
  | --- | --- |
  | `new Game.Loop(simulation)` | `Game.makeLoop(simulation)` |
  | `Game.Loop<...>`, a class | `Game.Loop<...>`, an interface with a `TypeId`; `Game.isLoop` is new |
  | `Game.Engine<...>`, the running engine, an object of Effects | the same Effects, on a value with a `TypeId`; `Game.isEngine` is new |
  | `Game.AttachError`, `Game.GameCrashed`, `Game.CommandDropped`, `Data.TaggedError`s | the same names and fields, `Schema.TaggedError`s |
  | `manualFrames()` (`arcadekit/game/testing`) | `ManualFrames.make()` |
  | `ReturnType<typeof manualFrames>` | `ManualFrames.ManualFrames`; `ManualFrames.isManualFrames` is new |
  | `frames.runFrameAt(nowMs)` | `ManualFrames.runFrameAt(frames, nowMs)`, or `frames.pipe(ManualFrames.runFrameAt(nowMs))` |
  | `frames.waiting()` | `ManualFrames.waiting(frames)` |
  | `Scenario.ScenarioRunner<...>` | `Scenario.Runner<...>` |
  | `Scenario.ScenarioStep<Runner>` | `Scenario.Step<Runner>` |
  | `Scenario.ScenarioSteps<Runner>` | `Scenario.Steps<Runner>` |

  The changelog keeps the old names: read it through this table.

- [#100](https://github.com/lucasthevenet/arcadekit/pull/100) [`76011ba`](https://github.com/lucasthevenet/arcadekit/commit/76011ba6255e9e0d611d5181f4c985e4cbc0ac99) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `arcadekit/input` is written as Effect's modules are: its one module is the namespace `InputController`, with a data type named after it, its `make`, an `isInputController` guard, `pipe`, a printed form, and functions that take the controller first and, given the name alone, return the function a `pipe` applies. **Breaking**: every export of `arcadekit/input` is renamed or reshaped.

  A controller reads its devices as it did: the same keys, sticks, drags and swipes, the same deadzone, the same one press per step. Its reads stay plain, since a step reads its input inside the frame or tick that runs it, and it runs no Effect. It now imports `effect`, for its shape only (`Pipeable`, `Inspectable`, `Predicate`, `dual`). A name the bindings don't give is a type error on every read, as it was.

  ```ts
  import { InputController } from "arcadekit/input";

  export const raceInput = (surface: HTMLElement) => {
    // Before: new InputController(surface, { axes: MOVE_AXES, buttons: { ... } })
    const controller = InputController.make(surface, {
      axes: InputController.moveAxes,
      buttons: { dash: { keys: ["Space"] } },
    });
    const input = { moveX: 0, dash: false };
    return {
      read: () => {
        // Before: controller.axis("moveX"), controller.wasPressed("dash")
        input.moveX = InputController.axis(controller, "moveX");
        input.dash = InputController.wasPressed(controller, "dash");
        return input;
      },
      // Before: controller.consumePresses(), controller.endFrame(), controller.dispose()
      endStep: () => InputController.consumePresses(controller),
      endFrame: () => InputController.endFrame(controller),
      dispose: () => InputController.dispose(controller),
    };
  };
  ```

  **Breaking**

  Every export of `arcadekit/input` before, and what a game writes now:

  | Before | Now |
  | --- | --- |
  | `new InputController(surface, bindings)` | `InputController.make(surface, bindings)` |
  | `InputController<Axis, Button>`, the class as a type | `InputController.InputController<Axis, Button>`, an interface with a readonly `bindings` |
  | `controller.axis(name)` | `InputController.axis(controller, name)`, or `controller.pipe(InputController.axis(name))` |
  | `controller.isDown(name)`, `controller.wasPressed(name)` | `InputController.isDown(controller, name)`, `InputController.wasPressed(controller, name)` |
  | `controller.consumePresses()`, `controller.endFrame()`, `controller.dispose()` | `InputController.consumePresses(controller)`, `InputController.endFrame(controller)`, `InputController.dispose(controller)` |
  | `InputBindings<Axis, Button>` | `InputController.Bindings<Axis, Button>` |
  | `AxisBinding`, `ButtonBinding`, `SwipeDirection` | `InputController.AxisBinding`, `InputController.ButtonBinding`, `InputController.SwipeDirection` |
  | `MOVE_AXES` | `InputController.moveAxes` |

  And what follows from the shape: a controller is not an instance of a class, so `instanceof InputController` is `InputController.isInputController(value)`, and it has no methods but `pipe` and the printing ones (`toJSON`, `toString`).

- [#108](https://github.com/lucasthevenet/arcadekit/pull/108) [`1d6e65b`](https://github.com/lucasthevenet/arcadekit/commit/1d6e65bd0cb86601e7b35ead07209570300d67bb) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `arcadekit/net` is written as Effect's modules are, and every export of `arcadekit/net`, `arcadekit/net/browser`, `arcadekit/net/testing`, `arcadekit/net/signalling` and `arcadekit/net/worker` has Effect's doc comment, with an example that runs. Each entry's public file exports namespaces, and `Coop` keeps its builder: a game declares its Coop as before. **Breaking**: every other export is renamed into a namespace, the entry's errors are `Schema.TaggedError`s, and the test helpers, the in-memory network, a transport, a peer link and a signalling room are data types with a `TypeId`.

  What changed besides the names:

  - **The lockstep protocol is as it was.** A tick decides each step's input and runs the steps in the call that ticks it, on the time it is given, with its resends, its stall timers and its listeners inside it. A session's `tick`, `subscribe`, `send` and `dispose` are its methods, as `Game.Loop`'s are, on a value with a `TypeId`. No recorded hash moves.
  - **A scoped session's Effects are traced**, as `ScopedLockstepSession.run`, `.listen`, `.send`, and its constructors as `ScopedLockstepSession.host` and `.join`. So are a Co-op client's methods, under the declared name (`SumCoop.host`, `SumCoop.send`, `SumCoop.attach` …), a signalling room's constructors and a peer connector's `connect`. A failure's cause carries the span: compare the error (`Effect.flip`) or the cause's reasons, not a whole `Exit`.
  - **A co-op host draws its run's seed from Effect's `Random`**, as an engine's run does, where it read `crypto.getRandomValues`. Every guest gets the host's seed in its start message, as before.
  - **`LockstepError`, `RoomError` and `PeerLinkError` are `Schema.TaggedError`s**, with the fields they had. An app catches each by its tag, as before.
  - **A transport, a peer link, a signalling room, a peer connector, the Co-op rooms and a Co-op client are made with their module's `make`**, so a test's stand-in for one is `Transport.make({ self, send, listen })`, `PeerLink.make(...)`, `SignallingRoom.make(...)`, `PeerConnector.make({ connect })`, `CoopRooms.make({ host, join })` or `CoopClient.make(...)`, not an object literal.
  - **A test on fake timers provides `PageTimers.layer`** to each of its Effects, where it wrapped them in `onFakeTimers`: the same Clock and scheduler, as services.
  - **The signalling protocol is a module per type** (`ClientMessage`, `ServerMessage`, `Signal`, `PeerId`, `JoinCode`, `Room`), its constants camelCase.

  ```ts
  import {
    LockstepSession,
    MemoryNetwork,
    ScopedLockstepSession,
  } from "arcadekit/net";
  import {
    CoopRooms,
    RtcPeerConnector,
    RtcTransport,
    SignallingRoom,
  } from "arcadekit/net/browser";
  import {
    FakeCoopRooms,
    ManualTicker,
    PageTimers,
    TestGame,
  } from "arcadekit/net/testing";
  import { SignallingWorker } from "arcadekit/net/worker";
  import { Effect, Layer } from "effect";

  // Before: const network = createMemoryNetwork({ seed: 1 }); network.connect("host"); network.advance(4);
  const network = MemoryNetwork.make({ seed: 1 });
  const transport = MemoryNetwork.connect(network, "host");
  MemoryNetwork.advance(network, 4);

  // Before: hostLockstep(options, 0), joinLockstep(options, 0), hostLockstepScoped(options)
  //   LockstepSession.host(options, 0), LockstepSession.join(options, 0), ScopedLockstepSession.host(options)

  // Before: browserCoopRoomsLayer(() => ({ url, iceServers: DEFAULT_ICE_SERVERS }))
  const rooms = CoopRooms.layer(() => ({
    url: "wss://game.example.com",
    iceServers: RtcPeerConnector.defaultIceServers,
  }));

  // Before: const hub = fakeCoopRooms(); hub.layer; const timer = manualTicker(); timer.layer; timer.tick();
  const hub = FakeCoopRooms.make();
  const timer = ManualTicker.make();
  const testRooms = Layer.mergeAll(
    FakeCoopRooms.layer(hub),
    ManualTicker.layer(timer)
  );
  ManualTicker.tick(timer);

  // Before: Effect.runPromise(onFakeTimers(effect))
  const onPage = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(effect.pipe(Effect.provide(PageTimers.layer)));

  // Before: export class SignallingRoom extends signallingRoom() {}; export default signallingWorker({ ... });
  export class Room extends SignallingWorker.room() {}
  export default SignallingWorker.make({ rooms: "ROOMS", assets: "ASSETS" });
  ```

  **Breaking**

  Every export that changed, and what a game writes now. `Coop` and its types (`AnyCoop`, `CoopCases`, `CoopClass`, `CoopDefinition`, `CoopId`, `CoopService`, `RunCases`) keep their names and types.

  | Before | Now |
  | --- | --- |
  | `hostLockstep(options, nowMs)`, `joinLockstep(options, nowMs)` | `LockstepSession.host(options, nowMs)`, `LockstepSession.join(options, nowMs)` |
  | `LockstepSession<...>` | `LockstepSession.LockstepSession<...>`, with a `TypeId`; `LockstepSession.isLockstepSession` is new |
  | `LockstepOptions`, `HostOptions`, `JoinOptions`, `LockstepStatus` | `LockstepSession.Options`, `.HostOptions`, `.JoinOptions`, `.Status` |
  | `LockstepError`, a `Data.TaggedError`; `StopReason`, `RemovedWhy` | `LockstepSession.LockstepError`, a `Schema.TaggedError`; `LockstepSession.StopReason`, `.RemovedWhy` |
  | `hostLockstepScoped(options)`, `joinLockstepScoped(options)` | `ScopedLockstepSession.host(options)`, `ScopedLockstepSession.join(options)` |
  | `ScopedLockstepSession<...>` | `ScopedLockstepSession.ScopedLockstepSession<...>`, with a `TypeId`; `ScopedLockstepSession.isScopedLockstepSession` is new |
  | `Ticker` | `Ticker.Ticker` |
  | `createMemoryNetwork(options)`, `MemoryNetwork`, `MemoryNetworkOptions` | `MemoryNetwork.make(options)`, `MemoryNetwork.MemoryNetwork`, `MemoryNetwork.Options`; `MemoryNetwork.isMemoryNetwork` is new |
  | `network.connect(id)`, `network.advance(nowMs)`, `network.cutOff(id, cut)` | `MemoryNetwork.connect(network, id)`, `MemoryNetwork.advance(network, nowMs)`, `MemoryNetwork.cutOff(network, id, cut)` |
  | `Transport` (an interface a literal could be), `PeerId` | `Transport.Transport`, made with `Transport.make`; `Transport.PeerId`; `Transport.isTransport` is new |
  | `linksTransport(self, links)` | `RtcTransport.fromLinks(self, links)` |
  | `PeerLink`, `TextChannel` | `PeerLink.PeerLink`, made with `PeerLink.make`; `PeerLink.TextChannel`; `PeerLink.isPeerLink` is new |
  | `PeerLinkError`, a `Data.TaggedError` | `PeerConnector.PeerLinkError`, a `Schema.TaggedError` |
  | `PeerConnector` (a class), `PeerConnectorApi`, `PeerLinkOptions` | `PeerConnector.PeerConnector` (the key and the shape), made with `PeerConnector.make`; `PeerConnector.ConnectOptions`; `PeerConnector.isPeerConnector` is new |
  | `rtcPeerConnector(options)`, `RtcOptions`, `DEFAULT_ICE_SERVERS`, `PeerConnectionLike`, `IceCandidateLike`, `DataChannelLike` | `RtcPeerConnector.make(options)`, `RtcPeerConnector.Options`, `.defaultIceServers`, `.PeerConnectionLike`, `.IceCandidateLike`, `.DataChannelLike`; `RtcPeerConnector.layer` is new |
  | `hostRoom(options)`, `joinRoom(options, code)`, `browserRoomLayer(rtc)` | `SignallingRoom.host(options)`, `SignallingRoom.join(options, code)`, `SignallingRoom.layer(rtc)` |
  | `SignallingRoom`, `RoomOptions`, `RoomEvent`, `RoomServices` | `SignallingRoom.SignallingRoom`, made with `SignallingRoom.make`; `SignallingRoom.Options`, `.Event`, `.Services`; `SignallingRoom.isSignallingRoom` is new |
  | `RoomError`, a `Data.TaggedError`; `RoomFailure` | `SignallingRoom.RoomError`, a `Schema.TaggedError`; `SignallingRoom.RoomFailure` |
  | `CoopRooms` (a class), `Rooms`, `browserCoopRoomsLayer(options)` | `CoopRooms.CoopRooms` (the key and the shape), made with `CoopRooms.make`; `CoopRooms.layer(options)`; `CoopRooms.isCoopRooms` is new |
  | `CoopTicker` | `CoopTicker.CoopTicker` |
  | `CoopClient<...>`, `CoopDebug<State>` | `CoopClient.CoopClient<...>`, with a `TypeId`, made with `CoopClient.make`; `CoopClient.Debug<State>`; `CoopClient.isCoopClient` is new |
  | `LobbyChanged`, `RunStarted`, `WaitingChanged`, `SeatFailed`, `CoopEvent<Event>`, `RunEvent<Event>`, `SeatContext`, `LobbyPlayer`, `CoopFailure` | `CoopEvent.LobbyChanged`, `.RunStarted`, `.WaitingChanged`, `.SeatFailed`, `CoopEvent.CoopEvent<Event>`, `.RunEvent<Event>`, `.SeatContext`, `.LobbyPlayer`, `CoopEvent.Failure` |
  | `fakeCoopRooms()`, `FakeCoopRooms`, `FAKE_JOIN_CODE` | `FakeCoopRooms.make()`, `FakeCoopRooms.FakeCoopRooms`, `FakeCoopRooms.joinCode`; `FakeCoopRooms.isFakeCoopRooms` is new |
  | `hub.layer`, `hub.drop(peer)`, `hub.closeHost()` | `FakeCoopRooms.layer(hub)`, `FakeCoopRooms.drop(hub, peer)`, `FakeCoopRooms.closeHost(hub)` |
  | `manualTicker()`, `timer.layer`, `timer.tick()`, `timer.ticking()` | `ManualTicker.make()`, `ManualTicker.layer(timer)`, `ManualTicker.tick(timer)`, `ManualTicker.ticking(timer)`; `ManualTicker.isManualTicker` is new |
  | `onFakeTimers(effect)` | `effect.pipe(Effect.provide(PageTimers.layer))` |
  | `TestGame`, `Score`, `OfferOpened`, `RunEnded`, `NothingOwed`, `AnswerOffer`, `HoldPause` | `TestGame.TestGame`, `TestGame.Score`, `.OfferOpened`, `.RunEnded`, `.NothingOwed`, `.AnswerOffer`, `.HoldPause` |
  | `TestContent`, `TestConfig`, `TestInput`, `TestState`, `TestEvent`, `TestCommand`, `TestRefusals` | `TestGame.Content`, `.Config`, `.Input`, `.State`, `.Event`, `.Command`, `.Refusals` |
  | `testContent`, `hashTestState` | `TestGame.content`, `TestGame.hash` |
  | `PeerId`, `MAX_PEER_ID_LENGTH`, `HOST_ID` (`arcadekit/net/signalling`) | `PeerId.PeerId`, `PeerId.maxLength`, `PeerId.host` |
  | `JoinCode`, `JOIN_CODE_ALPHABET`, `JOIN_CODE_LENGTH`, `joinCodeFromBytes`, `normalizeJoinCode`, `joinCodeFromPath` | `JoinCode.JoinCode`, `JoinCode.alphabet`, `JoinCode.length`, `JoinCode.fromBytes`, `JoinCode.fromTyped`, `JoinCode.fromPath` |
  | `Signal`, `MAX_TOKEN_LENGTH` | `Signal.Signal`, `Signal.maxTokenLength` |
  | `ClientMessage`, `MAX_MESSAGE_LENGTH`, `parseClientMessage` | `ClientMessage.ClientMessage`, `ClientMessage.maxLength`, `ClientMessage.fromJson` |
  | `ServerMessage`, `ErrorReason`, `parseServerMessage` | `ServerMessage.ServerMessage`, `ServerMessage.ErrorReason`, `ServerMessage.fromJson` |
  | `DEFAULT_ROOM_SIZE`, `MAX_ROOM_SIZE`, `ROOM_TTL_MS` | `Room.defaultSize`, `Room.maxSize`, `Room.ttlMs` |
  | `signallingRoom(options)`, `SignallingRoomOptions`, `SignallingRoomClass` (`arcadekit/net/worker`) | `SignallingWorker.room(options)`, `SignallingWorker.RoomOptions`, `SignallingWorker.RoomClass` |
  | `signallingWorker(options)`, `SignallingWorkerOptions`, `SignallingWorkerEnv`, `SignallingWorker` | `SignallingWorker.make(options)`, `SignallingWorker.Options`, `SignallingWorker.Env`, `SignallingWorker.Handler` |

  The changelog keeps the old names: read it through this table.

- [#106](https://github.com/lucasthevenet/arcadekit/pull/106) [`fd518ae`](https://github.com/lucasthevenet/arcadekit/commit/fd518ae16160aa2a45762e47b0df7bf204125c6a) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `arcadekit/render-three` and `arcadekit/render-three/testing` are written as Effect's modules are. Each module is a namespace: `Stage`, `PixelCamera`, `Camera`, `SpriteSheet`, `InstancedSprites`, `TileLayer`, `Gait` and `MeshInstances`, and in the testing entry `TestSpriteSheet`, `DrawnSprites` and `Png`. A stage, a pixel camera, a sheet, a batch, a tile layer, a gait and mesh instances are values on a prototype, with a `TypeId`, an `isX` guard, `pipe` and a printed form, made with their module's `make` and changed by functions that take them first. **Breaking**: every export is renamed or reshaped, and a pixel stage's camera is no Three.js camera.

  Loading a sheet is an Effect, as it was, and drawing is plain, as it was: a view draws inside the frame the browser shows. What changed besides the names:

  - **A pixel camera holds the Three.js camera it places.** `PixelCamera.PixelCamera` is no `THREE.OrthographicCamera`: its `camera` field is, and only `PixelCamera`'s functions move it (`follow`, `fit`, `setViewHeight`, `setBufferSize`). `Camera.fit` and a Three.js `lookAt`, which undo its snapping, no longer take it. A stage made with `camera: "pixel"` renders with it, and its `viewHeight` is a field.
  - **Sprite loading is one module with the sheet.** `SpriteSheet.fromUrl` loads, `SpriteSheet.decode` decodes a sheet's JSON, and `SpriteSheet.dispose` frees a sheet, which was a closure on it: a game's asset writes `release: SpriteSheet.dispose`. The sheet's decoded JSON is `SpriteSheet.Data`, its frames and tags `SpriteSheet.Frame` and `SpriteSheet.Tag`.
  - **A response that isn't a success fails the load with a `SpriteSheetError`, not a throw caught as one.** Its message is as it was. A load is traced as `SpriteSheet.fromUrl`, and a decode as `SpriteSheet.decode`.
  - **An interrupted load closes the image it was decoding.** A decode can't be stopped, so the bitmap it makes after the load was interrupted is closed when it arrives; it was dropped open.
  - **`SpriteSheetError` is a `Schema.TaggedError`**, with the same tag, `file`, `message` and `cause`: `SpriteSheet.SpriteSheetError`. An app's `Effect.catchTag("SpriteSheetError", ...)` is as it was.
  - **A refusal names the function**: `InstancedSprites.make: a capacity of NaN is no number of sprites...`, `MeshInstances.make: the attribute "position"...`, `Png.framesWithSoftAlpha reads an 8-bit RGBA PNG...`.

  ```ts
  import { Asset } from "arcadekit/content";
  import {
    InstancedSprites,
    PixelCamera,
    SpriteSheet,
    Stage,
  } from "arcadekit/render-three";

  // Before: Asset<SpriteSheet, SpriteSheetError>, and `release: (sheet) => sheet.dispose()`.
  export class RaceSheet extends Asset<
    SpriteSheet.SpriteSheet,
    SpriteSheet.SpriteSheetError
  >()("RaceSheet", { release: SpriteSheet.dispose }) {}

  // Before: RaceSheet.layer(loadSpriteSheet("/sprites/race.json")).
  export const sheetLayer = RaceSheet.layer(
    SpriteSheet.fromUrl("/sprites/race.json")
  );

  export const drawCar = (
    container: HTMLElement,
    sheet: SpriteSheet.SpriteSheet
  ) => {
    // Before: new Stage(...) and new InstancedSprites(sheet).
    const stage = Stage.make(container, { camera: "pixel", pixelsPerUnit: 16 });
    const sprites = InstancedSprites.make(sheet);
    stage.scene.add(sprites.mesh);
    const { tags } = SpriteSheet.resolveTags(sheet.data, { car: "car/drive" });
    return (x: number, z: number, time: number) => {
      // Before: sprites.begin(), sprites.push(...), sprites.end(), stage.camera.follow(...)
      // and stage.render().
      InstancedSprites.begin(sprites);
      InstancedSprites.push(
        sprites,
        x,
        z,
        SpriteSheet.frameAt(sheet.data, tags.car, time)
      );
      InstancedSprites.end(sprites);
      PixelCamera.follow(stage.camera, x, z);
      Stage.render(stage);
    };
  };
  ```

  **Breaking**

  Every export of `arcadekit/render-three` and `arcadekit/render-three/testing` before, and what a game writes now. A function of a value takes it first, and with one argument less gives the function a `pipe` applies.

  | Before | Now |
  | --- | --- |
  | `new Stage(container, options)`, `Stage<K>`, `stage.render()`, `stage.dispose()` | `Stage.make(container, options)`, `Stage.Stage<K>`, `Stage.render(stage)`, `Stage.dispose(stage)`, and `Stage.isStage` |
  | `StageOptions<K>`, `StageCameraKind`, `StageCamera<K>` | `Stage.Options<K>`, `Stage.CameraKind`, `Stage.CameraOf<K>` |
  | `disposeObject`, `keepTexture`, `isKeptTexture` | `Stage.disposeObject`, `Stage.keepTexture`, `Stage.isKeptTexture` |
  | `new PixelCamera(options)`, `PixelCamera`, a `THREE.OrthographicCamera` | `PixelCamera.make(options)`, `PixelCamera.PixelCamera`, which holds the Three.js camera as `camera`, and `PixelCamera.isPixelCamera` |
  | `camera.follow(x, z)`, `fit(bounds, margin?)`, `setViewHeight(h)`, `setBufferSize(w, h)`, `groundOnScreen(out)` | `PixelCamera.follow(camera, x, z)`, `PixelCamera.fit(camera, bounds, margin?)` and so on |
  | `camera.position`, `camera.left` and the camera's other Three.js fields | `camera.camera.position`, `camera.camera.left` |
  | `camera instanceof PixelCamera`, `camera.isPixelCamera` | `PixelCamera.isPixelCamera(camera)` |
  | `PixelCameraOptions`, `pixelScale`, `fitPixelScale`, `snapToPixel`, `pixelFrustum` | `PixelCamera.Options`, `PixelCamera.pixelScale`, `PixelCamera.fitPixelScale`, `PixelCamera.snapToPixel`, `PixelCamera.pixelFrustum` |
  | `followTarget`, `orbitAround`, `fitCamera`, `FitCameraOptions` | `Camera.follow`, `Camera.orbit`, `Camera.fit`, `Camera.FitOptions` |
  | `GroundBounds`, `MutableGroundBounds` | `Camera.GroundBounds`, `Camera.MutableGroundBounds` |
  | `loadSpriteSheet(url)` | `SpriteSheet.fromUrl(url)` |
  | `makeSpriteSheet(data, image)`, `SpriteSheet` with a `dispose` field, `sheet.dispose()` | `SpriteSheet.make(data, image)`, `SpriteSheet.SpriteSheet` with no `dispose` field, `SpriteSheet.dispose(sheet)`, and `SpriteSheet.isSpriteSheet` |
  | `decodeSpriteSheet(file, json)` | `SpriteSheet.decode(file, json)` |
  | `SpriteSheetError`, a `Data.TaggedError` | `SpriteSheet.SpriteSheetError`, a `Schema.TaggedError` with the same tag and fields |
  | `SpriteSheetData`, `SpriteFrame`, `SpriteTag`, `SpriteTagDirection` | `SpriteSheet.Data`, `SpriteSheet.Frame`, `SpriteSheet.Tag`, `SpriteSheet.TagDirection` |
  | `WantedTags`, `ResolvedTags<W>`, `resolveTags(data, wanted)`, `frameAt(data, tag, seconds)` | `SpriteSheet.WantedTags`, `SpriteSheet.ResolvedTags<W>`, `SpriteSheet.resolveTags(data, wanted)`, `SpriteSheet.frameAt(data, tag, seconds)` |
  | `new InstancedSprites(sheet, options)`, `InstancedSprites`, `InstancedSpritesOptions`, `SpriteSnap` | `InstancedSprites.make(sheet, options)`, `InstancedSprites.InstancedSprites`, `InstancedSprites.Options`, `InstancedSprites.Snap`, and `InstancedSprites.isInstancedSprites` |
  | `sprites.begin()`, `push(x, z, frame, flipX?)`, `setTint`, `setAlpha`, `setFlash`, `setLift`, `setLayer`, `end()`, `dispose()` | `InstancedSprites.begin(sprites)`, `InstancedSprites.push(sprites, x, z, frame, flipX?)` and so on; `capacity` and `count` are fields |
  | `new TileLayer(sheet, options)`, `TileLayer`, `TileLayerOptions` | `TileLayer.make(sheet, options)`, `TileLayer.TileLayer`, `TileLayer.Options`, and `TileLayer.isTileLayer` |
  | `layer.draw(seen, frameOf)`, `invalidate()`, `dispose()` | `TileLayer.draw(layer, seen, frameOf)`, `TileLayer.invalidate(layer)`, `TileLayer.dispose(layer)` |
  | `new Gait(options)`, `gait.update(x, z, time)`, `gait.reset()` | `Gait.make(options)`, `Gait.update(gait, x, z, time)`, `Gait.reset(gait)`, `Gait.Gait` with `linger` a field, and `Gait.isGait` |
  | `new MeshInstances(geometry, material, options)`, `MeshInstances<A>`, `InstanceAttributes`, `MeshInstancesOptions<A>` | `MeshInstances.make(geometry, material, options)`, `MeshInstances.MeshInstances<A>` with `attributes` a field, `MeshInstances.Attributes`, `MeshInstances.Options<A>`, and `MeshInstances.isMeshInstances` |
  | `instances.set(...)`, `setMatrix`, `setColor`, `setAttribute`, `commit(count)`, `dispose()` | `MeshInstances.set(instances, ...)` and so on |
  | `testSheet(tags)` (`arcadekit/render-three/testing`) | `TestSpriteSheet.fromTags(tags)` |
  | `drawnSprites(shown)`, `DrawnSprite` | `DrawnSprites.read(shown)`, `DrawnSprites.DrawnSprite` |
  | `pngSize(png)`, `framesWithSoftAlpha(data, png, blended?)` | `Png.size(png)`, `Png.framesWithSoftAlpha(png, data, blended?)`: the PNG first |

  Not in the published package: push-puzzle's and survivors' views, their tests and both demos are moved, with no change to what they draw. A test that spied on a batch's or a layer's method spies on its module's function (`vi.spyOn(TileLayer, "invalidate")`).

  No recorded hash moved: no simulation file changed.

- [#103](https://github.com/lucasthevenet/arcadekit/pull/103) [`9dfecb5`](https://github.com/lucasthevenet/arcadekit/commit/9dfecb529fdb8179b1646e28985f529f5ca51a63) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `arcadekit/save` is written as Effect's modules are. `Save` and `Setting` keep their builders, and a game declares a setting as before. What their services give is the namespace `Stored`: `Stored.Stored`, a value with a `TypeId`, its `make`, an `isStored` guard, `pipe` and a printed form. The browser's storage is `BrowserSaveStorage.layer` in `arcadekit/save/browser`. **Breaking**: a save's definition has no `field`, its stored format changed, and `Stored` and `BrowserSaveStorage` are namespaces.

  A save and a setting read, write, merge, back up and log as they did, with the same messages. What changed besides the names:

  - **A save is stored as `{ "version": 1, "records": { ... } }`.** Its records sat under a field the game named (`levels`, `heroes`), which kept each app's stored format as it was. A save stored that way no longer decodes: it is copied to `<storageKey>/corrupt`, logged, and read as empty, as a corrupt save is. The storage keys and a setting's format are as they were.
  - **A declaration's writes run one at a time.** A write re-reads what is stored, merges and stores. Two writes of one save at once could both read the same stored save, and the second stored over the first's record; now the second waits for the first. Over localStorage and `KeyValueStore.layerMemory` nothing waited between the read and the store, so no app lost a record this way.
  - **Reads and writes are traced.** A trace shows each read as `<Name>.read` (`PushPuzzleSave.read`) and each write as `<Name>.write`, with the read a merge makes inside it.
  - **A stored value is data.** `Stored.isStored(value)` tells a save's or a setting's service from an object with a `read` and a `write`, and `Stored.make({ read, write })` makes one, for a test of an app's own code that wants the service with no storage under it.

  ```ts
  import { Save, Stored } from "arcadekit/save";
  import { BrowserSaveStorage } from "arcadekit/save/browser";
  import { Effect, Layer, Schema } from "effect";

  // Before: field: "tracks", and the save stored as { version: 1, tracks: { ... } }.
  export class RaceSave extends Save("RaceSave", {
    storageKey: "my-studio/race/save",
    record: Schema.Struct({ bestLap: Schema.Number }),
    mergeRecord: (a, b) => (a.bestLap <= b.bestLap ? a : b),
  }) {}

  // Before: Layer.provide(BrowserSaveStorage)
  export const saveLayer = RaceSave.layer.pipe(
    Layer.provide(BrowserSaveStorage.layer)
  );

  // Before: Layer.succeed(RaceSave, { read, write }), an object of the app's own.
  export const noStorage = Layer.succeed(
    RaceSave,
    Stored.make({ read: Effect.succeed({}), write: Effect.succeed })
  );
  ```

  **Breaking**

  Every export of `arcadekit/save` and `arcadekit/save/browser` before, and what a game writes now:

  | Before | Now |
  | --- | --- |
  | `Save("MySave", { storageKey, field, record, mergeRecord })` | `Save("MySave", { storageKey, record, mergeRecord })`: there is no `field` |
  | `SaveDefinition<S, Field>` | `SaveDefinition<S>` |
  | the stored save `{ "version": 1, "<field>": { ... } }` | `{ "version": 1, "records": { ... } }`; one stored the old way is backed up to `<storageKey>/corrupt` and read as empty |
  | `Stored<A>`, a type | `Stored.Stored<A>`, the interface of the namespace `Stored`, with a `TypeId` |
  | an object of the app's own as a save's or a setting's service | `Stored.make({ read, write })`, which `Stored.isStored` recognises |
  | `BrowserSaveStorage`, a Layer (`arcadekit/save/browser`) | `BrowserSaveStorage.layer` (`arcadekit/save/browser`) |

  `Save`, `SaveClass`, `SaveId`, `SaveService`, `Records`, `Setting`, `SettingClass`, `SettingDefinition`, `SettingId` and `SettingService` keep their names, and so do a class's `kind`, `saveName`, `settingName`, `definition`, `merge` and `layer`, and a service's `read` and `write`. Neither `read` nor `write` fails, as before.

- [#97](https://github.com/lucasthevenet/arcadekit/pull/97) [`a38f6b9`](https://github.com/lucasthevenet/arcadekit/commit/a38f6b93d85efbecc6ad94fa1b62bbe5ed023c86) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `SpatialGrid` answers with the test done: `SpatialGrid.build` takes radii, `SpatialGrid.within` gives the points whose circle overlaps a circle, and `SpatialGrid.nearest` the nearest point in range, past a `skip` mask. Nothing breaks but the names, which are 0.7.0's: see the changeset that gives core Effect's module shape.

  `query` gives the points of the cells a circle overlaps, so every caller finished it by hand: the length of the offset against the two radii, a radius padded by a guess at the widest point, and for the nearest point a loop with a tie rule of its own. The test, the pad and the tie rule decide what every lockstep peer computes, so the grid does them once. They are plain code a step calls, in `arcadekit/core`: no Effect, no clock, no allocation and no callback.

  - **`SpatialGrid.build(grid, xs, ys, count, radii?)`.** With `radii`, point i is a circle of radius `radii[i]`. The grid keeps the three arrays and reads them when asked, so a step builds once its points have moved and their radii are set, and asks before it moves or removes a point.
  - **`SpatialGrid.within(grid, x, y, radius, out)`.** Writes into `out` the index of every point whose circle overlaps the circle of `radius` at (x, y), and returns how many. The test is `ExactMath.hypot2(dx, dy) < radius + radii[i]`: strict, so two circles that only touch do not overlap, with 0 for a grid built without radii. It visits the cells of `radius` plus the build's widest radius, so a caller pads nothing. The points come in `query`'s order, and it stops when `out` is full.
  - **`SpatialGrid.nearest(grid, x, y, range, skip?)`.** The index of the point whose centre is nearest (x, y) and closer than `range`, or -1. A point at exactly `range` is out, a tie goes to the lower index, and a point `i` with `skip[i]` not 0 is passed over: the mask is the caller's, for the dead and for the targets it has taken.
  - **`SpatialGrid.query` is the broad phase**, unchanged: for a step that tests each pair itself, as one that pushes overlapping bodies apart does.

  ```ts
  import { ExactMath, SpatialGrid } from "arcadekit/core";

  const HERO_RADIUS = 0.5;
  const xs = new Float32Array(200);
  const zs = new Float32Array(200);
  const radii = new Float32Array(200);
  const dead = new Uint8Array(200);
  const found = new Int32Array(64);
  const grid = SpatialGrid.make({ halfSize: 30, cellSize: 2, capacity: 200 });
  const hero = { x: 0, z: 0, touches: 0 };
  const count = 0;

  // Before: a padded query, then the test, by hand.
  SpatialGrid.build(grid, xs, zs, count);
  const candidates = SpatialGrid.query(
    grid,
    hero.x,
    hero.z,
    HERO_RADIUS + 1,
    found
  );
  for (let k = 0; k < candidates; k++) {
    const i = found[k]!;
    if (
      ExactMath.hypot2(xs[i]! - hero.x, zs[i]! - hero.z) <
      HERO_RADIUS + radii[i]!
    ) {
      hero.touches += 1;
    }
  }

  // After: the grid has the radii, and what comes back overlaps.
  SpatialGrid.build(grid, xs, zs, count, radii);
  hero.touches += SpatialGrid.within(grid, hero.x, hero.z, HERO_RADIUS, found);

  // The nearest living point within 14, or -1.
  const target = SpatialGrid.nearest(grid, hero.x, hero.z, 14, dead);
  ```

  Two mistakes that gave a wrong answer in silence are refused, and one accident of `query` is gone. A step that builds its grid from a pool of the grid's capacity, before it asks, meets none of them:

  - `SpatialGrid.build` throws a `RangeError` for more points than the grid's `capacity`, where `query` gave indices that were never built and `within` and `nearest` would never return, and for fewer `radii` than points.
  - `SpatialGrid.nearest` throws a `RangeError` for a `skip` mask shorter than the build, which would pass over every point past its end.
  - A grid that was never built has no points. Before its first `build`, `query` filled `out` with index 0.

## 0.6.0

### Minor Changes

- [#76](https://github.com/lucasthevenet/arcadekit/pull/76) [`29de556`](https://github.com/lucasthevenet/arcadekit/commit/29de55669810fee724d1f1fdad092f47dd737e01) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A co-op host hears its run from the start. A host's run has started by the time `hostLockstep` returns, before anything can listen to the session, so what that start reported reached no listener: what the simulation's `create` reports, and the run's first sample. A `Coop`'s host seat heard `RunStarted` and then nothing until its first steps, where a guest's seat heard the start. A game whose `create` reports its first stage showed that stage's banner to the guests alone.

  A session now keeps what a host's start reported and tells it at its first tick, before the tick does anything else.

  - **The Co-op client.** The host's seat hears what `create` reports and then the first sample, after its `RunStarted`, as a guest's seat does: each once, in the same order. A `Coop` and its `match` need no change.
  - **`hostLockstep` and `hostLockstepScoped`.** `session.subscribe(listener)` before the session's first tick, or `yield* session.listen(onEvent)` before `session.run(...)`, hears the run from its start. A listener that comes later hears what comes after it, and nothing is told twice. The entry's README has it under "Listening to a run".
  - **Nothing else of a session changed.** The run still starts in `hostLockstep`: its state is there at once, and what starting throws is thrown there. What peers exchange, the step a command rides and when steps run are as they were.
  - **`arcadekit/net/testing`.** The test game's content takes `offerAtStart: true`: the run then starts on an offer that `create` reports, for a test of what a seat hears first. Left out, the game is as it was.

  **What a game written against 0.5.0 may have to change.** Nothing stops compiling. A host's listener hears more than it did, at its session's first tick: a test that lists everything a host's session or seat reported now has the start's events and its first sample in that list, and a workaround that gave a host the start's news another way now gives it twice.

- [#76](https://github.com/lucasthevenet/arcadekit/pull/76) [`29de556`](https://github.com/lucasthevenet/arcadekit/commit/29de55669810fee724d1f1fdad092f47dd737e01) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `arcadekit/net/testing` has `onFakeTimers(effect)`: what a test of a Co-op client on fake timers runs its Effects on. Nothing breaks: it only adds an export.

  In Node, Effect reads its time from `process.hrtime` and runs its fibers on `setImmediate`, and a test's fake timers reach neither. A run's clock would stand still while its ticker's faked timer ran on. So each such test carried about forty lines: a `Clock` on the page's timers and a scheduler on microtasks, as Foldkit's is in the browser. The kit's own client tests had them, and so had the survivors demo's and grimbonk's ([co-op-findings.md](https://github.com/lucasthevenet/arcadekit/blob/3691e2875c9f5317295fbb8d5add1e5543e39e8f/docs/co-op-findings.md), finding 2).

  `onFakeTimers` gives an Effect both, and changes nothing else of it: what it gives, fails with and needs.

  ```ts
  import { onFakeTimers } from "arcadekit/net/testing";
  import { Effect } from "effect";

  // Before: the test's own Clock and scheduler, about forty lines above this.
  const before = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(Clock.Clock, performanceClock),
        Effect.provideService(Scheduler.Scheduler, microtasks)
      )
    );

  // After
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(onFakeTimers(effect));
  ```

  - Wrap every Effect the test runs or forks, the one that builds the client's layer first: a client takes its Clock and its scheduler from the Effect that made it.
  - It fakes nothing itself and imports no test runner. Fake `performance` and `setTimeout`, and `setInterval` with `clearInterval` for a run on the default ticker; leave `queueMicrotask` real. The entry's README has it under "On fake timers".

### Patch Changes

- [#76](https://github.com/lucasthevenet/arcadekit/pull/76) [`29de556`](https://github.com/lucasthevenet/arcadekit/commit/29de55669810fee724d1f1fdad092f47dd737e01) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The docs now say what a listener has heard when a `send` completes. `Game.Engine`'s `send` said that its answer and the events of its step "arrive in no fixed order". That was wrong for a listener: the order is fixed, and a game may rely on it. No code changed, so nothing breaks: tests now hold the order.

  - **`engine.send`.** When it completes, the callback given to `engine.listen` has been called with everything the frame of the command's step reported: the events of each of that frame's steps, then its sample if one was due. So an Effect that listens and then sends knows, on the line after the send, what its command's step did, such as whether a pick opened another offer. It holds whether the rules took the command or refused it, and after a wait behind a pause.
  - **The one exception is a frame that throws before its listeners have heard it all**, as `attach` fails with `GameCrashed`. A command one of its steps had applied still gets the rules' answer. But if a step threw, what the frame had reported is discarded with its run and reaches no listener; and if a listener threw, the telling ended there: the listeners called before it heard that event, and none heard what came after. A render that throws comes after both, so the listeners heard its whole frame.
  - **A send that fails with `CommandDropped`** had no step to hear of. One that a new `start` dropped completes after the listener heard that run's start.
  - **A lockstep session's `send`, the scoped session's and the Co-op client's** have the same order, with no exception: a session's listeners are called inside the tick and its senders after it, and a tick that throws tells its senders `CommandDropped`. So no sender hears the rules' answer to a command whose step its listeners did not hear.
  - **The order is that of the two calls, not of Messages.** An app's Subscription makes a Message of each event and its Command another of the send's result, and the kit fixes no order between those in `update`. A Command that needs what its command's step reported listens itself, around its send.

  `Game.Loop`'s `subscribe` and `frame`, the entries' READMEs (`arcadekit/game`, `arcadekit/net`) and the glossary say the same.

## 0.5.0

### Minor Changes

- [#75](https://github.com/lucasthevenet/arcadekit/pull/75) [`fb8ff12`](https://github.com/lucasthevenet/arcadekit/commit/fb8ff12dc992c647dc803f3f3e37a14c3f344d0d) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A co-op player's decision is a command: a `Game.Command` of the game's simulation rides its sender's next step to every peer of a lockstep run, each peer's rules take or refuse it alike at that step, and only the sender hears which ([ADR-0020](https://github.com/lucasthevenet/arcadekit/blob/3691e2875c9f5317295fbb8d5add1e5543e39e8f/docs/adr/0020-a-game-is-declared.md)). It replaces the Co-op client's `answer` and `setPaused`, and the answer and the pause a game wrote into each step's input.

  **The wire changed.** What a player sends for one step was its encoded input, and is now a list: the input, or null while nothing is attached, then the commands sent for that step, four at most. `[{"moveX":0,"moveZ":1}]` is a step with no command. The messages, the acknowledgements and resends, the bounds, the hashes and the referee are as they were. A peer on this release can't play with a peer on the one before: each removes the other, or stops, on the first payload, with `badInput`.

  **New**

  - `LockstepSession.send(command, settled?)` (`arcadekit/net`) is `Game.Loop`'s `send` without the slot. The command rides the local player's payload for the next step the session schedules, so the host confirms it once, with that step, and every peer hands it to its loop with the sender's slot, before the step and before the step's leavers. `settled` is called on the sender's peer, once the session is out of the tick that ran the step, with `undefined`, the rejection or a `CommandDropped`. It returns a function that takes the command back while it has no step yet.
  - `ScopedLockstepSession.send(command)` and `CoopClient.send(command)` (`arcadekit/net/browser`) are that as an Effect, in the shape of `Game.Engine`'s `send`: it succeeds when this peer's rules took the command, fails with the rejection they refused it with, and fails with `CommandDropped` when they gave no answer. For the client that is `noRun` with no seat or in the lobby, and `runEnded` when the run stopped or the player left first.
  - Every send ends. A session that stops, is disposed or throws out of a tick tells the senders still waiting `CommandDropped` (`runEnded`), a send after that is answered at once, and a step the host confirms without what this peer sent for it answers those senders the same way, with no throw. A command sent while a guest's session is still `joining` waits, and rides the run's first steps.
  - At most four commands ride one player's step, checked where a payload is decoded: a fifth rides the sender's next step, in the order sent, and a peer that sends five in one step is removed as for any payload that doesn't decode.
  - `send` throws for a command that can't cross the network: a value JSON doesn't carry, such as a NaN in a `Schema.Number` field, which no peer could decode. Before a step it would have shown as its sender's bad input.
  - A session's `local` source may return null for a step, and the Co-op client's does while nothing is attached. The rules see null at that player's slot, as `Game.PlayerInputs` allows.
  - A player the host removes after it confirmed the step of that player's command is told `CommandDropped` (`runEnded`) though the peers still in the run applied the command: a send speaks for its own peer's rules.

  **Breaking**

  - `CoopClient.answer` and `CoopClient.setPaused` are gone: send a command of the game's simulation with `CoopClient.send`. The kit knows nothing of pausing any more: a game with a co-op pause declares a command for it.

    ```ts
    // Before
    const before = Effect.gen(function* () {
      yield* coop.answer({ offer, index });
      yield* coop.setPaused(true);
    });

    // After: the game declares both, and its `apply` handlers take or refuse them
    class ChooseUpgrade extends Game.Command(
      "ChooseUpgrade",
      { offer: Schema.Int, index: Schema.Int },
      { rejects: [OfferClosed] }
    ) {}
    class HoldPause extends Game.Command(
      "HoldPause",
      { held: Schema.Boolean },
      { rejects: [NotPlaying] }
    ) {}

    const after = Effect.gen(function* () {
      yield* coop
        .send(new ChooseUpgrade({ offer, index }))
        .pipe(
          Effect.catchTag(["OfferClosed", "CommandDropped"], () => Effect.void)
        );
      yield* coop.send(new HoldPause({ held: true })).pipe(
        // The rules hold no pause for this player: stop showing the run as paused. Keep the way
        // to leave the run on screen, if the pause screen is where it is.
        Effect.catchTag(["NotPlaying", "CommandDropped"], () => showRunPlaysOn)
      );
    });
    ```

  - `CoopRules.localInput` and `CoopRules.settled` are gone, and `CoopTypes` has no `Answer`. The bag names the simulation's commands and their rejections in its place, which type the client's `send`:

    ```ts
    interface MyCoop extends CoopTypes {
      // Config, State, Event, PlayerInput, LocalEvent, Content: as before
      readonly Command: Game.CommandOf<typeof MyGame>;
      readonly Refusals: Game.RefusalsOf<
        readonly [typeof ChooseUpgrade, typeof HoldPause]
      >;
    }
    ```

    The one-player input Schema holds what a device holds and nothing else: take the answer and the pause out of it, and out of `step`. A pause becomes state a command sets once, where a step read it from every step's input: decide in the rules what lets go of it (a player leaving, a hero going down) and what refuses it (a hero that is not playing, a run that is over).

  - A step's commands are applied before the step, so before the players in its `leaving`. Rules that handled leaving first and then the answers in a step's input see the other order when a command and a removal share a step. Check that both orders give the same state, or decide which is right, with a scenario.
  - A step's input is null for a player whose peer has nothing attached, where the game's `localInput` made an input for it: `players[slot]` was already `PlayerInput | null`.
  - `LockstepSession` and `ScopedLockstepSession` are `<State, Event, Command, Refusals>`, and `CoopRules.simulation` is typed with the bag's `Command` and `Refusals`.
  - `arcadekit/net/testing`: the test game's input is `{ add }`. Its answer is the command `AnswerOffer`, refused with `NothingOwed`, and its pause the command `HoldPause`; `TestCommand` is their union. `TestAnswer` is gone, `TestState` has `held`, and `testCoopRules` has no `localInput` and no `settled`.

- [#73](https://github.com/lucasthevenet/arcadekit/pull/73) [`3ad14cc`](https://github.com/lucasthevenet/arcadekit/commit/3ad14cc7a6d420012a56e1238c4232661c0ab7e9) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A game is declared: one named class per part, hosted by a Layer or a loop ([ADR-0020](https://github.com/lucasthevenet/arcadekit/blob/3691e2875c9f5317295fbb8d5add1e5543e39e8f/docs/adr/0020-a-game-is-declared.md)).

  **New entries**

  - `arcadekit/game`: `Game.Event` and `Game.Command` (Schema classes for what a run reports and what a player decides), `Game.Rejection` (why the rules may refuse a command), `Game.Simulation` (the DOM-free rules: `input`, `events`, `commands`, `create`, `step`, `apply`, `sample`) and `Game.Loop`, which steps one anywhere. A command sent to a run is applied at the start of its next step, so a run changes only at a step. Its `apply` handler takes it or returns one of the rejections the command declares (`rejects`), and the sender is told which. A `step` or an `apply` handler that returns anything else is a type error, and the loop refuses it.
  - `arcadekit/game/browser`: the same, plus `Game.Engine`: a simulation with the `view` and `input` that draw it and read its input, and what they are made from (`uses`, Effects run on each attach). The class is the engine service's key and its `layer` provides it. `engine.send(command)` completes when the rules have answered: it fails with the command's rejection if they refused it, and with `CommandDropped` if it never reached them. `Game.Frames` replaces the frame clock in a test. The sender goes on after the frame of the command's step, so it may start or stop a run. `Game.EngineOf<typeof MySimulation>` names the running engine. `Game.frameLoop(frames, frame)` is the loop an engine and the Co-op client draw on, for anything else an app draws on animation frames.
  - `arcadekit/game/scenario`: scenarios that check a simulation: `Scenario.given`, `step`, `send`, `reported`, `refused`, `sampled`, `state`.

  **New in `arcadekit/content`**

  - `Content(name, { schema, files, validate })` and `Asset<A, E>()(name, { release })`: content and loaded-once assets as classes that key their own service (`.layer`, `.load`; `Content` also has `.read` for tests). `loadOnce` is what both are built on.

  **Breaking**

  - `arcadekit/foldkit`'s `engineEntry` no longer infers the app's Message type from `toMessage` and `onError`: it comes from `Subscription.make`. A call outside one names its type parameters. A `toMessage` that returns something that isn't a Message is now reported on `toMessage`.

- [#75](https://github.com/lucasthevenet/arcadekit/pull/75) [`6228fb7`](https://github.com/lucasthevenet/arcadekit/commit/6228fb7c29e803f8de7ea8cc0818ce22cf0ae8b4) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A save, a setting and a cue table are declarations. `class MySave extends Save("MySave", { storageKey, field, record, mergeRecord }) {}` and `class MyAudioSettings extends Setting("MyAudioSettings", { storageKey, schema, default }) {}` (`arcadekit/save`): each class is the key of its service, `layer` provides it over a `KeyValueStore`, and the service is a `Stored`, `read` and `write`. `class MyCueTable extends CueTable("MyCueTable", { cues: { hit: SoundId } }) {}` (`arcadekit/audio`): the class is the key of the app's sounds, which `MyCueTable.layer(sounds)` checks and provides. Each builder's types are exported with it: `SaveClass`, `SaveId` and `SaveService`; `SettingClass`, `SettingDefinition`, `SettingId` and `SettingService`; `CueTableClass`, `CueTableDefinition`, `CueTableId`, `CueTableService`, `CueSounds` and `AnyCueTable`. The stored formats and the storage keys are unchanged.

  **Breaking**

  - `arcadekit/save`: `makeSaveStore`, `SaveStore` and `mergeRecords` are gone. Declare a `Save`: its definition's `key` is `storageKey`; `load` is `read` and `merge(records)` is `write(records)`, which still merges into what is stored, both reached with `yield* MySave`; `mergeRecords(mergeRecord)` is the class's `MySave.merge`. `SaveDefinition` is generic over the record's Schema, and a `field` named `version` is refused.
  - `arcadekit/audio`: `makeAudioSettingsStore` and `AudioSettingsStore` are gone, and the entry no longer reads storage. Declare a `Setting` with `schema: AudioSettings` and `default: defaultAudioSettings`; `load` is `read` and `save(settings)` is `write(settings)`, which gives back what it wrote. `AudioSettings`, `defaultAudioSettings` and `applyAudioSettings` stay.
  - The log lines name the declaration, where they said `The save ...` and `The audio settings ...`: `Save "MySave" can't be read. ...`, `Setting "MyAudioSettings" can't be written.`
  - A genre's cue table is a `CueTable`. `@arcadekit/push-puzzle/browser` has `PushPuzzleCueTable` in place of `PushPuzzleCueSounds` and the type `PushPuzzleSounds`, and `@arcadekit/survivors/browser` has `SurvivorsCueTable` in place of `SurvivorsCueSounds` and `SurvivorsSounds`. An app gives its sounds with `PushPuzzleCueTable.layer(sounds)` in place of `Layer.succeed(PushPuzzleCueSounds, sounds)`, and names their type `CueSoundsOf<typeof PushPuzzleCueTable>`. `layer` throws when the sounds don't fit the cues, as the app's module loads, where a cue the app left out was silent.

- [#75](https://github.com/lucasthevenet/arcadekit/pull/75) [`a98eb7f`](https://github.com/lucasthevenet/arcadekit/commit/a98eb7fc0fd8ce70c759f98f222dd1673c81a4c7) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Co-op is a declaration: `Coop` (`arcadekit/net/browser`), made from the game's `Game.Engine` ([ADR-0021](https://github.com/lucasthevenet/arcadekit/blob/3691e2875c9f5317295fbb8d5add1e5543e39e8f/docs/adr/0021-co-op-is-declared-from-the-games-engine.md)). It replaces `CoopRules`, the `CoopTypes` bag, `CoopGame` and `makeCoopClient`. Nothing changed on the wire, in the lockstep session or in how a command travels.

  **What a co-op game writes differently**

  ```ts
  // Before: a bag of types by hand, a rules object, a game value with a second presentation,
  // and a client made by the app.
  interface SurvivorsCoop extends CoopTypes {
    readonly Config: SurvivorsConfig;
    readonly State: World;
    // ...six more
  }
  const survivorsCoopRules: CoopRules<SurvivorsCoop> = {
    simulation: Survivors,
    hash: hashWorld,
    picks: (content) => content.heroes.map((hero) => hero.id),
    config: (content, heroIds) => ({ content, heroIds }),
    choosing: (world, slot) => world.heroes[slot]?.offer != null,
    localEvent: (event, slot) => /* a second event vocabulary */ null,
    runEnded: (event) => event._tag === "RunEnded",
  };
  const coopClient = makeCoopClient(
    { ...survivorsCoopRules, content, presentation },
    { rooms: browserCoopRooms({ url, iceServers }) }
  );

  // After: one declaration, over the engine the game already has. Every type is inferred.
  export class SurvivorsCoop extends Coop("SurvivorsCoop", {
    engine: SurvivorsEngine,
    input: heroDevice,
    content: SurvivorsContent.load,
    picks: (content) => content.heroes.map((hero) => hero.id),
    config: (content, heroIds) => ({ content, heroIds }),
    maxPlayers: MAX_HEROES,
    hash: hashWorld,
    ends: [RunEnded],
  }) {}

  // The client is the service `SurvivorsCoop`, provided by SurvivorsCoop.layer over
  // browserCoopRoomsLayer(() => ({ url, iceServers }))
  const hostRoom = (heroId: string) =>
    Effect.gen(function* () {
      const coop = yield* SurvivorsCoop;
      yield* coop.host(heroId);
    });
  ```

  - **`engine`** gives the simulation, what the view is made from (`uses`) and the view: the browser half is declared once. **`input`** is one player's input source, made as the engine's is, with what the engine uses.
  - **`ends: [RunEnded]`** replaces the `runEnded` predicate.
  - **`localEvent` is gone.** A seat hears the run's events as the rules reported them, each with the local player, and the app says which are its own in the class's `match`.
  - **`choosing` is gone**, and so is the `choosing` list of the waiting event. Who a run waits on to decide is the game's to say, in its sample (a flag for each player in a HUD), and the app reads it there.
  - **The class is the key of the Co-op client** (`yield* SurvivorsCoop`), and `SurvivorsCoop.layer` provides it. What every peer must agree on is on the class as plain functions (`SurvivorsCoop.definition.hash`, `picks`, `config`), for a test in Node.
  - **It is refused when declared**, by type and then by a throw as the module loads: an engine whose simulation's `input` was not declared with `Game.PlayerInputs`, an `ends` entry the simulation doesn't report (its sample included), and a `maxPlayers` no room can have.

  **What an app writes differently**

  ```ts
  // Before
  toMessage: (event) => {
    switch (event.type) {
      case "lobby":
        return Message.GotCoopLobby({
          role: event.role /* ...five more fields */,
        });
      case "run":
        return runMessage(event.event);
      // ...
    }
  };

  // After: one match for everything a seat reports. The run's cases have their own place, and
  // each is given the local player.
  toMessage: SurvivorsCoop.match({
    LobbyChanged: (lobby) => Message.GotCoopLobby({ lobby }),
    RunStarted: ({ slot, names }) => Message.GotCoopStarted({ slot, names }),
    WaitingChanged: ({ waitingFor }) => Message.GotCoopWaiting({ waitingFor }),
    SeatFailed: ({ message }) => Message.GotCoopFailed({ error: message }),
    run: {
      Hud: (hud) => Message.GotHud({ hud }),
      LeveledUp: ({ hero, offer, choices }, { local }) =>
        hero === local.slot
          ? Message.GotCoopLevelUp({ offer, choices })
          : undefined,
      HeroLeft: () => undefined,
      RunEnded: ({ summaries }, { local }) => {
        const summary = summaries[local.slot];
        return summary === undefined
          ? undefined
          : Message.GotCoopRunEnded({ summary });
      },
    },
  });
  ```

  - **The client's own events are Schema classes**, told by `_tag`: `LobbyChanged`, `RunStarted`, `WaitingChanged` and `SeatFailed`, where `CoopEvent` had `type: "lobby" | "started" | "waiting" | "failed"`. An app puts one in a Message or its Model as it is. A run's event comes as `{ _tag: "RunEvent", event, local }`, where it was `{ type: "run", event }` with what the game's `localEvent` made. `local` is the local player of the seat that heard it, one object for that seat's run, so an event an app keeps still says whose it was after the player has left or taken another seat.
  - **`match` covers everything a seat reports, and nothing else.** A missing case is a type error. A case for an event that doesn't exist, such as one left behind by a renamed event or a run's case written beside the client's own, compiles; `match` refuses it when it is called, as the app's module loads, and says where the case goes.
  - **The rooms are a service**, `CoopRooms`, with a Layer for each implementation: `browserCoopRoomsLayer(() => ({ url, iceServers }))`, which replaces `browserCoopRooms(options)` and reads its options when the layer is built, and `fakeCoopRooms().layer`. **The ticker is a reference**, `CoopTicker`, whose default is the worker's timer; a test provides `manualTicker().layer`. The frame clock is the engine's `Game.Frames`. `CoopClientOptions` is gone.

  **`Game.Engine`** (`arcadekit/game/browser`)

  - **`view` is told the local player**: `view(container, uses, { local })`, and it reads `local.slot` when it draws. The engine seats its one player at slot 0 and a `Coop` at the slot the lobby gave, so one view follows the local player in both. A view that takes two arguments compiles as before. `LocalPlayer` moved here from `arcadekit/net/browser`, with `ViewContext`.
  - **`input` is unchanged**: the whole step's input, so an engine can still fill several slots.
  - **`EngineClass` is typed by what the engine uses** (`EngineClass<Name, Config, State, Input, Event, Command, U, Refusals>`, where it had the error and the services of those as two parameters), and has the engine's `definition`, which a `Coop` reads.

  **`Game.Simulation`** (`arcadekit/game`)

  - **`match` refuses a case for an event the simulation doesn't report**, when it is called, as a `Coop`'s does. The types let an extra case through (one left behind by a renamed event), and it would never run. A case a cast left out is refused then too, where it was refused when its event came.

  **The Co-op client**

  - `CoopClient<State, Event, Command, E, Refusals>` has five type parameters, as `Game.Engine`'s service has, where it had the type bag. Its methods are the same.
  - On attach it makes the view first, then the input source, as an engine does. It made the input first.
  - It calls nothing of the game's between steps but the local player's input source.
  - `WaitingChanged` names a player only once the run has stood at one step for 300 ms. A peer whose run began more than the input delay before another's has a step due for the whole run while it steps at full rate, and its client named the other player all that time ("Waiting for Guest 1…" over a run that played).

  **`arcadekit/net/testing`**

  - `fakeCoopRooms()` has a `layer`, and so has `manualTicker()`.
  - The entry makes no Co-op client any more: `testCoopRules`, `testCoopGame`, `testPresentation`, the `TestCoop` bag and `TestLocalEvent` are gone, with nothing in their place. A test makes a client as an app does, from a `Coop`'s `layer`: provide it with `fakeCoopRooms().layer`, `manualTicker().layer` and `manualFrames()` as `Game.Frames`. That is your own game's `Coop`, or one declared over the test game, which stays: `TestGame` with its events and commands, `testContent` and `hashTestState`. Its sample `Score` says who still owes the open offer an answer (`owes`).

  **Removed**

  - `arcadekit/net`: `CoopRules`, `CoopTypes`.
  - `arcadekit/net/browser`: `makeCoopClient`, `CoopGame`, `CoopPresentation`, `CoopClientOptions`, `browserCoopRooms`, the `CoopRooms` interface (now the service; its shape is `Rooms`), `LocalPlayer` (now in `arcadekit/game/browser`).

- [#75](https://github.com/lucasthevenet/arcadekit/pull/75) [`d869690`](https://github.com/lucasthevenet/arcadekit/commit/d86969069eda5d11b8bc08a6e747a228c8627bfa) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A game's content loads through its `Content` declaration, and in no other way.

  **Breaking**

  `arcadekit/content` no longer exports `loadContent` or `LoadContentOptions`. `loadContent({ ...definition, source })` was the same call as a declared content's `read(source)`, so there were two ways to read and check a game's files once. What to write:

  ```ts
  export class MyContent extends Content("MyContent", {
    schema: MyGameContent,
    files: { levels: "levels.json" },
  }) {}

  // Before: loadContent({ schema: MyGameContent, files: { levels: "levels.json" }, source })
  const checked = MyContent.read(source);
  ```

  `read` keeps nothing, which suits a test of a game's real content files: it runs the checks the game runs. An app loads with `MyContent.load`, over `MyContent.layer(source)`, which keeps the first success.

  **Fixed**

  - A handler in `apply` takes the state `create` returns wherever it is written, with `create` the first of the handlers. Written directly under a `create` with an unannotated parameter (`create: (config: Config, { seed }) => ...`), it had a state of type `unknown`, and only another handler between the two (a `step`, a `sample`) hid that. `Game.CommandHandlers` is keyed by the commands' tags as before, and now reads them from the list without renaming the keys, which is what lets TypeScript type a handler before the state is settled. It also changes a definition that compiled: an `apply` written above a `create` written in place can now leave the whole simulation's state `unknown`, sometimes with no error, as a `step` there always could. Write `create` before `step`, `apply` and `sample`: this repository's lint reports the order (`declaration/create-first`).
  - A handler in `apply` with no command declared for it is refused: it was never called, and nothing said so. In a simulation that declares no command it is now a type error on the handler's line: `apply` is typed there by `Game.NoHandlers`, a new exported type. One the types let through (a cast, handlers held in a variable) makes `Game.Simulation` throw when declared: ``Simulation "Jar" has apply.Empty but declares no command "Empty". List the command's class in `commands`, or remove the handler.``

  **Changed**

  - Attaching an engine or a Co-op client that is already attached still dies, and the defect now names the declaration and says what to do: `Engine "MyEngine" is already attached to an element. An engine draws into one element at a time: interrupt the first attach, which detaches it, before attaching again.` A `Coop`'s says the same of its Co-op client.
  - `Game.Simulation`'s doc comment says what it refuses when declared and shows a loop that steps one, and `Game.Engine`'s example is push-puzzle's engine as it is written, with its cue table in `uses`.

- [#75](https://github.com/lucasthevenet/arcadekit/pull/75) [`599e518`](https://github.com/lucasthevenet/arcadekit/commit/599e518b01fc748b79b9e49e31e6d5cf1fdbfe99) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - A lockstep run hosts a declared simulation: `hostLockstep`, `joinLockstep`, their scoped forms and the Co-op client step a `Game.Simulation` class through `Game.Loop`, as `Game.Engine` does ([ADR-0020](https://github.com/lucasthevenet/arcadekit/blob/3691e2875c9f5317295fbb8d5add1e5543e39e8f/docs/adr/0020-a-game-is-declared.md)). A simulation several players can play declares its step input with `Game.PlayerInputs`, and the session takes from it what a game used to pass as `codec` and `combine`.

  The messages, their bounds, the hashes and the referee are the same. What one player's payload is changed with commands, in the same release: see the changeset on a command riding a lockstep step.

  **New in `arcadekit/game`** (and `arcadekit/game/browser`)

  - `Game.PlayerInputs(OnePlayersInput)`: the step input of a simulation several players can play, as a Schema made from the Schema of one player's input. `players[slot]` is one player's input or null, and `leaving` the slots removed at this step. It is a marked Schema: `.annotate()` and `.check()` keep the mark, and a struct with the same two fields written by hand doesn't have it.
  - `Game.PlayerInputs<PlayerInput>`, the type, and `Game.soloInput`, which fills it for one player, move here from `arcadekit/runtime`. A value needs no mark: `{ players: [input], leaving: [] }` is one.
  - `Game.PlayersSimulation` is what a host that seats several players asks for: a simulation whose step input was declared with `Game.PlayerInputs`. Any other is a type error that names `Game.PlayerInputs` where the host infers the step input from the simulation it is handed (`hostLockstep`, `Game.playerInputSchema`). Where the step input's type is named, as in `CoopRules`, the types can't tell a struct written by hand from the declared input. `Game.playerInputSchema(simulation)` gives such a host the one-player Schema, and throws for whatever got past the types. `Game.PlayerInputOf<Input>` is one player's input of a step input, and `Game.PlayerInputsSchema<P>` the type `Game.PlayerInputs` returns.
  - `Game.Loop`: an input source's `read(step)` may call `loop.send`. A command sent there is applied in that same step, before `step`.

  **Breaking**

  - `hostLockstep`, `joinLockstep`, `hostLockstepScoped` and `joinLockstepScoped` take `simulation: MySimulation`, a `Game.Simulation` class whose `input` is a `Game.PlayerInputs`, where they took a `GameSimulation` object. The `codec` and `combine` options are gone: each player's input crosses the network as the one-player Schema encodes it, and the session puts each at its slot. `local` reads one player's input, as before. A simulation with any other step input is refused: a throw with nothing left listening, and before it a type error on `simulation` when the call infers its types from the simulation. `LockstepOptions`, `HostOptions` and `JoinOptions` are now `<Config, State, Input, Event, Command, Refusals>`, with `Input` the simulation's step input; a call that names no type arguments is unaffected.

    ```ts
    // Before
    const simulation: GameSimulation<
      Config,
      World,
      PlayerInputs<HeroInput>,
      Event
    > = {
      create: (config, seed) => createWorld(config, seed),
      step,
      drainEvents: (world) => world.events.drain(),
    };
    hostLockstep(
      {
        simulation,
        codec: schemaCodec(HeroInput),
        combine: combinePlayerInputs(players),
        // config, contentHash, transport, local, hash, inputDelay, hashEvery, peers, seed
      },
      nowMs
    );

    // After
    class MyGame extends Game.Simulation("MyGame", {
      input: Game.PlayerInputs(HeroInput),
      events: [RunEnded],
      create: createWorld,
      step,
    }) {}
    hostLockstep(
      {
        simulation: MyGame,
        // config, contentHash, transport, local, hash, inputDelay, hashEvery, peers, seed
      },
      nowMs
    );
    ```

  - `joinLockstep` and `joinLockstepScoped` take `players`: the run's player order as the lobby agreed it, the host first, then the `peers` the host passes. It is the list a guest passed to `combinePlayerInputs`. A guest must be told it: the host's start message lists who is still in the run when it is sent, so a guest that first hears it after a player was removed would otherwise seat the players that are left at other slots than the host does. The Co-op client passes its lobby's order.

    ```ts
    joinLockstep(
      {
        simulation: MyGame,
        host: "host",
        players: ["host", "guest-1", "guest-2"],
        // config, contentHash, transport, local, hash, inputDelay, hashEvery
      },
      nowMs
    );
    ```

  - `CoopRules.simulation` is that declared class, and `CoopRules.codec` is gone. `choosing`, `localEvent`, `runEnded`, `CoopGame` and the client's events are unchanged; `settled`, `localInput` and the client's `answer` and `setPaused` go with commands, in the same release. `makeCoopClient` now throws where it is called for a game whose simulation's step input is not a `Game.PlayerInputs`. That throw is the only refusal there: `CoopRules` names the step input's type, so a struct written by hand with `players` and `leaving` compiles.
  - `arcadekit/net` no longer exports `InputCodec`, `jsonCodec`, `schemaCodec`, `combinePlayerInputs`, `ConfirmedStep` or `PlayerStepInput`: no option takes them any more.
  - `arcadekit/runtime` no longer exports `PlayerInputs` or `soloInput`: import `arcadekit/game`, as `Game.PlayerInputs` and `Game.soloInput`.
  - A host's own input that doesn't survive the wire still stops it with `badInput`, and a local input source that returns a value the one-player Schema refuses to encode still makes the tick throw, as it did with `schemaCodec`. A game that passed `jsonCodec` got neither check.
  - `arcadekit/net/testing`: the test game is declared. `testSimulation` is replaced by the class `TestGame`, its events are the classes `Score`, `OfferOpened` and `RunEnded` (they were `{ type: "score" | "offer" | "ended" }` objects), `TestEvent` is their union, and `TestState` has no `events`. `testCoopRules` has no `codec`. What the Co-op client reports of a run (`TestLocalEvent`) is unchanged. Its answer and its pause are commands: see the changeset on a command riding a lockstep step.

- [#75](https://github.com/lucasthevenet/arcadekit/pull/75) [`281a4cd`](https://github.com/lucasthevenet/arcadekit/commit/281a4cd57dfe24595bb159df83727975ccb42858) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The engine loader and the content loader are gone. A game's engine, its assets and its content are declarations ([ADR-0020](https://github.com/lucasthevenet/arcadekit/blob/3691e2875c9f5317295fbb8d5add1e5543e39e8f/docs/adr/0020-a-game-is-declared.md)), and no game used the loaders any more.

  **Breaking**

  `arcadekit/runtime/browser` no longer exports `makeEngineLoader`, `EngineLoader`, `LoadedEngine` or `engineOf`, and `arcadekit/content` no longer exports `makeContentLoader` or `ContentLoader`. What to write in place of each, as `@arcadekit/push-puzzle` does in [`src/browser/game.ts`](https://github.com/lucasthevenet/arcadekit/blob/main/packages/push-puzzle/src/browser/game.ts) and [`src/content.ts`](https://github.com/lucasthevenet/arcadekit/blob/main/packages/push-puzzle/src/content.ts):

  - `makeEngineLoader({ assets, game, release })`: declare what it loaded as an `Asset` (`arcadekit/content`), with its `release`, and the engine as a `Game.Engine` (`arcadekit/game/browser`) over the game's `Game.Simulation`, with the asset's load in `uses`. The app gives the asset's layer the load it passed as `assets`. The engine exists before its assets: each attach loads them, or takes what is already loaded.

    ```ts
    export class MySheet extends Asset<SpriteSheet, SpriteSheetError>()(
      "MySheet",
      { release: (sheet) => sheet.dispose() }
    ) {}

    export class MyEngine extends Game.Engine("MyEngine", {
      simulation: MyGame,
      uses: { sheet: MySheet.load },
      view: (container, { sheet }) => new MyView(container, sheet),
      input: myInput,
    }) {}

    // The app provides both. Building the layers loads nothing.
    const resources = Layer.mergeAll(
      MyEngine.layer,
      MySheet.layer(loadSpriteSheet("/sprites/my-game.json"))
    );
    ```

    Its `frames` option is the `Game.Frames` reference: `Layer.succeed(Game.Frames, manualFrames())`.

  - `EngineLoader`: the class `Game.Engine` returns is the engine service's key, and its `layer` provides the service. A genre writes no service and no layer maker for it.
  - `LoadedEngine`: `yield* MyEngine` is the engine, and `yield* MySheet.load` the asset.
  - `engineOf(MyEngine)`: `MyEngine` itself, in `engineEntry({ engine: MyEngine, ... })` and in a Command (`yield* MyEngine`). Reaching the engine loads nothing and can't fail. A sheet that can't be loaded is `attach`'s failure, which `engineEntry`'s `onError` gets, and the app's loading screen runs the same `MySheet.load` to show it and retry.
  - `makeContentLoader({ schema, files, validate, source })`: declare the content with `Content`, and give its layer the source.

    ```ts
    export class MyContent extends Content("MyContent", {
      schema: MyGameContent,
      files: { levels: "levels.json" },
    }) {}

    // The app says where the files are. Building the layer reads nothing.
    MyContent.layer(fetchJsonSource("/content/"));
    ```

    `MyContent.load` is the loader's `load`: it keeps the first success, and a failed load can be run again.

  - `ContentLoader<A>`: the class `Content` returns is the content service's key, so `MyContent` is the requirement and `MyContent.load` the load. The shape of the service is `Loaded<A, ContentError>`.

  `loadContent` is no longer exported either: `MyContent.read(source)` is that call, for a test of a game's real content files.

- [#75](https://github.com/lucasthevenet/arcadekit/pull/75) [`219e8be`](https://github.com/lucasthevenet/arcadekit/commit/219e8beedf590ffe5cedeb55397e25395a2d4a26) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The older contract is gone, and with it the `runtime` entries. A game is its declarations ([ADR-0020](https://github.com/lucasthevenet/arcadekit/blob/3691e2875c9f5317295fbb8d5add1e5543e39e8f/docs/adr/0020-a-game-is-declared.md)): no game in the repository was on the older contract any more, and nothing of it is kept as a compatibility layer. What `arcadekit/runtime` had that a declared game still uses is `arcadekit/game`'s, under the same names. Nothing changed in how a run steps: the kernel under `Game.Loop` steps with the same lines, and no recorded hash moved.

  **Breaking**

  `arcadekit/runtime`, `arcadekit/runtime/browser` and `arcadekit/runtime/testing` are no longer entries of the package, which has nineteen. `arcadekit/game/testing` is new.

  Each name they exported, and what to import or write in its place ([the `arcadekit/game` page](https://github.com/lucasthevenet/arcadekit/blob/main/packages/arcadekit/src/game/README.md) has each section):

  | From `arcadekit/runtime` | Now |
  | --- | --- |
  | `StepInput`, `InputSource` | `arcadekit/game` (and `arcadekit/game/browser`): `Game.StepInput`, `Game.InputSource` |
  | `FrameBudget` | `arcadekit/game`: `Game.FrameBudget` |
  | `PlayerInputs`, `soloInput` | `arcadekit/game`: `Game.PlayerInputs`, `Game.soloInput` ("Several players") |
  | `GameSimulation` | Gone: declare the game's rules with `Game.Simulation` ("The rules"). `create` takes `(config, { seed, report })`, `step` takes `(state, input, { dt, step, report })`, an event is a `Game.Event` class reported with `report` where there was `drainEvents`, and `sample` names its event and takes `every: "100 millis"` where there was `everyMs: 100` |
  | `GameLoop` | Gone from the entries: step a declared simulation with `Game.Loop` ("How a frame becomes steps"). `new Game.Loop(MyGame)` has the same `start`, `frame`, `setPaused`, `stop`, `subscribe`, `state` and `stepIndex`. It has no `modify`: send a `Game.Command`, which the loop applies at the start of the next step ("Refusing a command") |

  | From `arcadekit/runtime/browser` | Now |
  | --- | --- |
  | `AttachError`, `GameCrashed` | `arcadekit/game/browser`: `Game.AttachError`, `Game.GameCrashed`. The classes and their tags are the same, so an app's `Effect.catchTag("GameCrashed", ...)` and its `onError` are unchanged |
  | `FrameSource`, `animationFrames` | `arcadekit/game/browser`: `Game.FrameSource`, `Game.animationFrames` |
  | `GameView` | `arcadekit/game/browser`: `Game.View` |
  | `combineViews` | `arcadekit/game/browser`: `Game.combineViews` |
  | `StepInput`, `InputSource` | `arcadekit/game/browser`: `Game.StepInput`, `Game.InputSource` |
  | `GameDefinition`, `GamePresentation` | Gone: declare the game's browser half with `Game.Engine` ("In the browser"). `createView` is `view` and `createInput` is `input`, each given what the engine `uses` |
  | `makeGameEngine`, `GameEngine` | Gone: `class MyEngine extends Game.Engine("MyEngine", { simulation, uses, view, input }) {}`. The class is the engine service's key and `MyEngine.layer` provides it, so a genre writes no service and no layer for it; `Game.EngineOf<typeof MyGame>` names the running engine. `engine.modify` is `engine.send(command)`, which waits for the rules' answer. A send needs a step: it waits while the engine is paused or not attached, where `modify` changed the state at once, so a screen that paused the engine before a pick now leaves the run stepping and freezes the game in its rules ("Refusing a command"). `engine.start(config)` takes a seed too (`{ seed }`), and `makeGameEngine`'s `frames` option is the `Game.Frames` reference |
  | `attachError` | Gone: `new Game.AttachError({ message, cause })` |
  | `GameSimulation` | Gone: see above |
  | `makeEngineLoader`, `EngineLoader`, `LoadedEngine`, `engineOf` | Gone: an `Asset` and a `Game.Engine` (the loaders' own entry in this changelog has each) |

  | From `arcadekit/runtime/testing` | Now |
  | --- | --- |
  | `manualFrames` | `arcadekit/game/testing` ("Testing an engine"). Provide it as the engine's frames: `Layer.succeed(Game.Frames, manualFrames())` |

  A game that imported only the names in the first rows of each table changes its import paths and nothing else. Before:

  ```ts
  import type { StepInput } from "arcadekit/runtime";
  import { combineViews } from "arcadekit/runtime/browser";
  import type { GameView, InputSource } from "arcadekit/runtime/browser";
  import { manualFrames } from "arcadekit/runtime/testing";
  ```

  After, as `Game.StepInput`, `Game.combineViews`, `Game.View` and `Game.InputSource`:

  ```ts
  import * as Game from "arcadekit/game/browser";
  import { manualFrames } from "arcadekit/game/testing";
  ```

  A game still built with `makeGameEngine` declares itself, as `@arcadekit/push-puzzle` does in [`src/simulation.ts`](https://github.com/lucasthevenet/arcadekit/blob/main/packages/push-puzzle/src/simulation.ts) and [`src/browser/game.ts`](https://github.com/lucasthevenet/arcadekit/blob/main/packages/push-puzzle/src/browser/game.ts):

  ```ts
  // Before
  const simulation: GameSimulation<Config, State, Input, Event> = {
    create: (config, seed) => createState(config, seed),
    step: (state, input, dt) => stepState(state, input, dt),
    drainEvents: (state) => state.events.drain(),
    sample: { everyMs: 100, read: (state) => ({ type: "hud", hp: state.hp }) },
  };
  const engine = makeGameEngine({ ...simulation, createInput, createView });
  const pick = (index: number) =>
    engine.modify((state) => choose(state, index));

  // After
  export class Hud extends Game.Event("Hud", { hp: Schema.Number }) {}
  export class Choose extends Game.Command("Choose", { index: Schema.Int }) {}

  export class MyGame extends Game.Simulation("MyGame", {
    input: Input,
    commands: [Choose],
    create: (config: Config, { seed }) => createState(config, seed),
    step: (state, input, { dt }) => {
      stepState(state, input, dt);
    },
    apply: {
      Choose: (state, { index }) => {
        choose(state, index);
      },
    },
    sample: {
      event: Hud,
      every: "100 millis",
      read: (state) => ({ hp: state.hp }),
    },
  }) {}

  export class MyEngine extends Game.Engine("MyEngine", {
    simulation: MyGame,
    view: createView,
    input: createInput,
  }) {}

  // The engine is the service `MyEngine`, provided by MyEngine.layer.
  const pick = (index: number) =>
    Effect.gen(function* () {
      const engine = yield* MyEngine;
      yield* engine.send(new Choose({ index }));
    });
  ```

  **Unchanged**

  - A run's step order, its fixed clock, the 0.25 s clamp and the five steps a frame may run: `Game.Loop` steps on the same kernel, whose stepping lines moved into `arcadekit/game` as they were. No entry exports it.
  - `arcadekit/foldkit`'s `engineEntry` and `gameViewport`, `arcadekit/net`'s lockstep session and its wire, and the `Coop` declaration.

## 0.4.1

### Patch Changes

- [#71](https://github.com/lucasthevenet/arcadekit/pull/71) [`214b8c6`](https://github.com/lucasthevenet/arcadekit/commit/214b8c6d1f2660ada68a91a4f38a3ae35f0db621) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The package's `homepage` is [arcadekit.dev](https://arcadekit.dev), the docs site, which has a page for each entry. The README links to it. No code changed.

## 0.4.0

### Minor Changes

- [#69](https://github.com/lucasthevenet/arcadekit/pull/69) [`1758082`](https://github.com/lucasthevenet/arcadekit/commit/1758082f621e4a7145b5e90c6844dd94fedaa5e1) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The kit owns the Co-op client: one player's side of a co-op game, from the lobby to the run. It was the survivors demo's own code, which every game with co-op had to copy. A game now supplies its genre half, and its app keeps the lobby screens (ADR-0019).

  ```ts
  import { browserCoopRooms, makeCoopClient } from "arcadekit/net/browser";

  const play = Effect.gen(function* () {
    const coop = yield* makeCoopClient(myCoopGame, {
      rooms: browserCoopRooms({ url: "wss://game.example.com", iceServers }),
    });
    yield* coop.listen((event) => {
      // lobby, started, run, waiting, failed
    });
    yield* coop.host("knight");
    return yield* coop.attach(element);
  }).pipe(Effect.scoped);
  ```

  **`arcadekit/net`** (DOM-free) gains a Co-op game's lockstep parts:

  - `CoopRules<G>` and the `CoopTypes` bag `G` a game declares once (`Config`, `State`, `Event`, `PlayerInput`, `Answer`, `LocalEvent`, `Content`). The rules hold the `simulation`, whose step input is `PlayerInputs<PlayerInput>`, with `codec`, `hash`, `picks`, `config`, the optional `maxPlayers` and `lockstep: { inputDelay, hashEvery }` (defaults `DEFAULT_ROOM_SIZE`, 4 and 60), and what the local player's seat needs: `localInput`, `settled`, `choosing`, `localEvent` and `runEnded`. The client combines the players' inputs with `combinePlayerInputs`, so the rules have no `combine`.

  The lobby's messages and state, and the content hash peers compare at the start, are behind the client, not exports. Content must be JSON data, and its hash is sensitive to key order.

  **`arcadekit/net/browser`** gains the client:

  - `makeCoopClient(game, { rooms, ticker?, frames? })`, a scoped Effect, and its `CoopClient`: `host(pick)`, `join(code, pick)`, `choose(pick)`, `start`, `answer(answer)`, `setPaused(paused)`, `leave`, `attach(element)`, `listen(onEvent)` and `debug()`. The commands return at once, except `leave`, which returns once the seat has closed; a new seat says nothing until every seat before it has. `attach` and `listen` have the shapes of `arcadekit/foldkit`'s `AttachableEngine`, so `engineEntry` takes the client as it is. `attach` fails with `AttachError`, `GameCrashed` or the game's `LoadError`, and a failed attach leaves the seat.
  - `CoopGame<G, LoadError>`: the rules plus `content`, an Effect run once per host or join, and `presentation`, an Effect run once per attach that gives a `CoopPresentation` (`createInput`, `createView`). The view gets a live `LocalPlayer` (`slot`, `names`) and reads it when it renders.
  - `CoopEvent`: `lobby` (role, code, self, `LobbyPlayer`s, `maxPlayers`, `canStart`), `started` (slot, names), `run` (what the game's `localEvent` makes of a run's event), `waiting` (who stepping waits on, who is choosing) and `failed`, with the kit's English `message` and a `CoopFailure` reason an app can re-word: `content`, `room`, `leftOut`, `unknownPick`, `tooManyPlayers`, `hostLost`, `desync`, `contentMismatch`, `removed`, `badInput` or `bug`. Player names ("Host", "Guest 2") are the kit's too.
  - `CoopRooms` and `browserCoopRooms({ url, iceServers })`. The kit reads no environment: the app passes the signalling worker's URL and its STUN servers.
  - `CoopClientOptions` and `CoopDebug` are the types of the client's options and of `debug()`. Unless given a `ticker`, the client times each run in a dedicated Web Worker, which a hidden tab doesn't throttle.

  **New entry `arcadekit/net/testing`**, for tests only: `fakeCoopRooms()` (the signalling worker and WebRTC in memory, with `drop(peer)`, `closeHost()`, its `code` and a `log`; `FAKE_JOIN_CODE` is the code), `manualTicker()` (a ticker the test drives) and `testCoopGame(options?)`, a small Co-op game with lobby picks, an offer to answer, a pause and an end. Its parts are exported too, so a test can vary the game: `testCoopRules`, `testSimulation`, `testPresentation`, `testContent`, `hashTestState` and the `Test*` types. It needs only `effect`. Frames come from `manualFrames()` in `arcadekit/runtime/testing`.

  Behaviour is ADR-0012's, as the demo's client had it: no late join, the drop rule, a host star. Three things are new for a game that used the demo's client as its model:

  - At the start the host replaces an empty or unknown lobby pick with the game's first, and a guest that receives a pick its own content lacks fails with `unknownPick` instead of starting.
  - The game's `maxPlayers` bounds a run, not the room's size. The host starts the first `maxPlayers` players in lobby order, so a guest that links as the host starts can be left out (`leftOut`), and a guest refuses a start with more players than its own game takes (`tooManyPlayers`: only a host on another build sends one).
  - The lobby's messages on the wire are `pick`, `lobby` (players with `pick`) and `start` (players, picks). Peers on different builds can't share a lobby.

  Per-step and per-frame code is plain, with no Effect: the game's `settled`, `choosing` and the function `localInput` returns run between steps and must not allocate. The package has eighteen entries. `net/testing` is in the `net` group, so it adds no arrow between entries.

  Nothing breaks for the existing entries: every change is a new export or a new entry, and no export was removed or changed.

- [#68](https://github.com/lucasthevenet/arcadekit/pull/68) [`5e672c3`](https://github.com/lucasthevenet/arcadekit/commit/5e672c3f60c754f7c0c12562beb9c25ff32c1fc6) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The kit owns the step input of a game with several players, and how lockstep fills it. Each game used to carry its own copy of the same type and two helpers.

  - `arcadekit/runtime` exports `PlayerInputs<PlayerInput>`: `players[slot]` is one player's input for the step, or null when that player has none, and `leaving` lists the slots that leave the run at this step, in ascending order. A slot is a player's place in the run's player order, host first in lockstep. A game uses it as its `GameSimulation`'s `Input`.
  - `arcadekit/runtime` exports `soloInput(source)`: a `StepInput<PlayerInputs<PlayerInput>>` from one player's `StepInput<PlayerInput>`, at slot 0, with nobody leaving. `endStep` and `endFrame` reach the source.
  - `arcadekit/net` exports `combinePlayerInputs(players)`: a lockstep session's `combine` for such a game. `players` is the run's player order, host first; it returns a function from a `ConfirmedStep<PlayerInput>` to `PlayerInputs<PlayerInput>`.

  All three are plain code, with no Effect. `soloInput` and `combinePlayerInputs` refill one object, so a step allocates nothing.

  Nothing breaks for the existing entries: these are new exports, no export changed, and it adds no arrow between entries (`net` already imports `runtime`).

- [#66](https://github.com/lucasthevenet/arcadekit/pull/66) [`93c0d67`](https://github.com/lucasthevenet/arcadekit/commit/93c0d67d44d4914c9294663b299522f5be4dc7e9) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - New entry `arcadekit/net/worker`: the signalling worker, for Cloudflare. It was the survivors demo's own code, which every game with co-op had to copy. An app's Worker is now a few lines:

  ```ts
  import { signallingRoom, signallingWorker } from "arcadekit/net/worker";

  export class SignallingRoom extends signallingRoom({ roomSize: 4 }) {}

  export default signallingWorker({ rooms: "ROOMS", assets: "ASSETS" });
  ```

  - `signallingRoom(options?)` returns the Durable Object class of one join code's room, for the app to extend and export under the name its binding declares. `signallingWorker({ rooms, assets })` returns the Worker's `fetch` handler, given the names of the app's two bindings. The app still declares its Worker, bindings and routes itself (the demo's `alchemy.run.ts`).
  - The room size is a setting of the worker: `roomSize`, a whole number from 2 to `MAX_ROOM_SIZE` (16), and `DEFAULT_ROOM_SIZE` (4) if left out. `signallingRoom` throws a `RangeError` for any other size when the Worker's module loads; it never changes it to another one. A lockstep run's own limit on the wire is separate and unchanged.
  - The worker behaves as the demo's did (ADR-0012). Its Effect service key is `arcadekit/net/worker/RoomConnections`.
  - `@cloudflare/workers-types` (^5) is a new optional peer, for this entry's types. The entry imports `cloudflare:workers`, so it runs only on Cloudflare; typecheck a Worker that uses it with Workers types, no DOM `lib`, and `skipLibCheck` (Effect's own type files name DOM types).
  - It adds no arrow between entries: the worker is in the `net` group, which lint checks as one entry, and imports only `net/signalling`'s protocol. Within the group, only the worker's own typecheck (Workers types, no DOM) keeps it apart from `arcadekit/net/browser`.

  **Breaking:**

  - `arcadekit/net/signalling` exports `DEFAULT_ROOM_SIZE` (4) and `MAX_ROOM_SIZE` (16) in place of `MAX_PLAYERS` (4). Use `DEFAULT_ROOM_SIZE` where you used `MAX_PLAYERS`, unless your worker sets another room size.
  - `parseServerMessage` accepts a `welcome` that lists up to `MAX_ROOM_SIZE - 1` peers (it was 3). The bound follows the renamed constant: the worker's `welcome` still lists at most the host, at any room size.

  No other entry changes.

## 0.3.0

### Minor Changes

- [#64](https://github.com/lucasthevenet/arcadekit/pull/64) [`f426e1a`](https://github.com/lucasthevenet/arcadekit/commit/f426e1ae6c295cb71df49953fa168b6e88deba32) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The kit is one package. `arcadekit` replaces the nine `@arcadekit/*` packages (`core`, `input`, `content`, `save`, `audio`, `render-three`, `runtime`, `net`, `foldkit`), which get no further release (ADR-0018).

  **Breaking:**

  - Replace the `@arcadekit/*` dependencies with `arcadekit`, and change each import from `@arcadekit/<entry>` to `arcadekit/<entry>`: `@arcadekit/runtime/browser` is `arcadekit/runtime/browser`. The sixteen entries and what each exports are unchanged. The package has no root export.
  - `effect` is the one required peer dependency. `three`, `@types/three`, `foldkit` and `@effect/platform-browser` are optional peers: install the ones the entries you import need.
  - The Effect service keys follow the name: `@arcadekit/audio/Audio` is `arcadekit/audio/Audio`, and `@arcadekit/net/PeerConnector` is `arcadekit/net/PeerConnector`.

## 0.2.3

### Patch Changes

- [#62](https://github.com/lucasthevenet/arcadekit/pull/62) [`ec25311`](https://github.com/lucasthevenet/arcadekit/commit/ec25311c214f6a9fd367a73565b62d10b30217bb) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `Stage.dispose()` releases its WebGL context (`forceContextLoss`). It used to leave the context alive until the canvas was collected, so a game that makes stages one after another (a view per attach) piled them up. Chrome keeps 16 a page and then kills the oldest, which can be a live stage's, and a page that keeps losing them can be refused new ones ("Error creating WebGL context").

## 0.2.2

### Patch Changes

- [#60](https://github.com/lucasthevenet/arcadekit/pull/60) [`5558bd9`](https://github.com/lucasthevenet/arcadekit/commit/5558bd93cfc12f3e4ebbb76d33e224b6b6b6035e) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `InputController` drags and swipes again on iPhone Safari. It has no pointer lock and leaves `document.pointerLockElement` undefined, which the check for a locked pointer read as locked, so every press was ignored.

## 0.2.1

### Patch Changes

- [#58](https://github.com/lucasthevenet/arcadekit/pull/58) [`9e2651a`](https://github.com/lucasthevenet/arcadekit/commit/9e2651a50ea9de9c41e0f94c96adcc826430d082) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `InputController` ignores pointer presses while the document has a pointer lock, such as a game's mouse look on the same surface. It used to call `setPointerCapture`, which throws `InvalidStateError` while the pointer is locked, so every click during mouse look threw from its listener. A locked pointer stays put on screen, so it can't drag or swipe anyway; drags and swipes work again once the lock is released.

## 0.2.0

### Minor Changes

- [#52](https://github.com/lucasthevenet/arcadekit/pull/52) [`faebbf6`](https://github.com/lucasthevenet/arcadekit/commit/faebbf67e4237cce060a6727dae620400a8657f2) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The mixer keeps its decoded files in Effect's `Cache`, so the library no longer runs an Effect of its own to share a decode. `load` behaves as before: a file is decoded once, even when two loads of it overlap, and a file that failed is tried again by the next load.

  Breaking:

  - `makeAudioMixer(options)` returns `Effect<AudioMixer>` (was `AudioMixer`). Yield it inside your program, or run it where your program starts (`Effect.runSync(makeAudioMixer(options))` in a test).
  - `makeBrowserAudio` in `@arcadekit/audio/browser` is `Effect<AudioMixer, never, Scope>` (was a function returning `{ audio, dispose }`). Closing its scope does what `dispose` did: it removes its listeners, stops its sounds and closes the AudioContext. `BrowserAudioLayer` is unchanged.

- [#51](https://github.com/lucasthevenet/arcadekit/pull/51) [`f46fda2`](https://github.com/lucasthevenet/arcadekit/commit/f46fda2ce4865cfd3c6d53b872d4e31e6d190801) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - `GameEngine.attach` now fails with a typed `AttachError` (exported from `@arcadekit/runtime/browser`, with the thrown `cause`) when `createView` or `createInput` throws, such as Three.js finding no WebGL, instead of dying. Its new type, `(element) => Effect<never, AttachError | GameCrashed>`, is in the frame loop entry. Nothing is left attached: a view made before `createInput` threw is disposed, and a throwing `dispose` still disposes the view and lets the engine attach again. `makeEngineLoader` now frees the assets of a load whose `game` throws.

  `engineEntry` hands an attach failure to `onError`, so the app gets a Message instead of a blank viewport. `EngineEntryConfig` takes a sixth type parameter, `A`, for what `attach` fails with, and `onError` receives `E | A`.

  `AudioSystem.load` now decodes a file once when two loads of it overlap.

  Breaking:

  - `engineEntry` with a `GameEngine` (or `engineOf(loader)`) now requires `onError`, which also receives `AttachError`. An entry for a plain `GameEngine` that had no `onError` must add one.
  - `EngineEntryConfig<Model, Message, Event, R, E>` is now `EngineEntryConfig<Model, Message, Event, R, E, A>`; `engine` is `Effect<AttachableEngine<Event, A>, E, R>`.

- [#52](https://github.com/lucasthevenet/arcadekit/pull/52) [`faebbf6`](https://github.com/lucasthevenet/arcadekit/commit/faebbf67e4237cce060a6727dae620400a8657f2) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The browser frame loop is an Effect now. `GameEngine.attach(element)` makes the view and the input source, then runs the frame loop itself for as long as it stays attached: each frame waits for the next animation frame, steps the run, then draws, all in one go. A frame whose step, render or event listener throws is the last one: the run ends, the loop asks for no more frames, the view and input source are disposed, and `attach` fails with the new `GameCrashed` (exported from `@arcadekit/runtime/browser`, with the thrown `cause`). Before, the loop kept running after a throw and nothing on the Effect side was told. The first frame no longer steps by a negative time when `requestAnimationFrame`'s time is before attach.

  `engineEntry` runs `attach` instead of waiting forever after it, so a crash reaches `onError` as a Message, sent once, like a failed attach.

  Breaking:

  - `GameEngine.attach` is `(element) => Effect<never, AttachError | GameCrashed>` (was `Effect<void, never, Scope>`). It runs until interrupted instead of returning once attached, and it needs no `Scope`. Interrupt it to detach. It fails with `AttachError` when `createView` or `createInput` throws, and with `GameCrashed` when a frame throws. It never succeeds, so run it last: start the run, then `return yield* engine.attach(element)`. Its failures reach only what waits on it: a forked `attach` that nothing joins (`Effect.forkScoped(engine.attach(element))` alone) loses them silently, so join its fiber (`Fiber.join`) or race the rest of the program against it (`Effect.raceFirst(rest, engine.attach(element))`).
  - A crash ends the run, as `stop` does: attached again, the engine draws no run until the app starts a new one. Before, the run stayed live after a throw, and the next frame ran the step that threw again.
  - `AttachableEngine<Event, E>.attach` is `(element) => Effect<never, E>` (was `Effect<void, E, Scope>`): it runs until interrupted, and fails with `E` if it can't attach or stops on its own. An engine that draws on its own timer ends its `attach` with `Effect.never`, scoped.
  - `onError` in `engineEntry` for a `GameEngine` (or `engineOf(loader)`) also receives `GameCrashed`.
  - `GameDriver` is removed from `@arcadekit/runtime/browser`. Use `makeGameEngine` to step and draw in the browser, or `GameLoop` to step without drawing.

- [#55](https://github.com/lucasthevenet/arcadekit/pull/55) [`f7a8e30`](https://github.com/lucasthevenet/arcadekit/commit/f7a8e3080caba32b1c7f0662d752830881db3501) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The browser's signalling client is an Effect program. `hostRoom(options)` and `joinRoom(options, code)` are scoped Effects that succeed once the signalling server welcomes the peer, so the room's `code` and `self` are always known. The scope owns the socket until the start, and every peer connection and link after it: closing it is leaving, and a room that fails has already closed what it opened. `room.events` is a `Stream` of what happens after the welcome, which ends with `started` and fails with the room's `RoomError`; events wait until they are read, and leaving interrupts a reader that is still reading. `browserRoomLayer(rtc)` provides what a room needs in a browser: the new `PeerConnector` service (`rtcPeerConnector`, over WebRTC) and `Socket.WebSocketConstructor` from `effect/socket`. Tests provide fakes of both and drive the timeouts with a `TestClock`. Also new: `PeerConnectorApi`, `PeerLinkOptions`, `PeerConnectionLike`, `IceCandidateLike`, `DataChannelLike` and `RoomServices` (`PeerConnector | Socket.WebSocketConstructor`).

  Fixes:

  - A room whose socket opens but whose welcome never comes fails with `no-welcome` after `welcomeTimeout` (10 seconds by default), instead of connecting forever.
  - A server message the client can't read fails the room with `bad-server-message` (a server on another version of the protocol), instead of being dropped.
  - A data channel that can't be made no longer leaks its `RTCPeerConnection`: each part of a link has its own release in the link's scope.
  - A connection that fails after its link opened now ends the link (`link.closed`). Before the start, a host then drops that guest, and a guest's room fails.
  - `TextChannel.onClose` on a channel that has already closed calls its handler at once, once.

  Breaking:

  - `hostRoom` and `joinRoom` return `Effect<SignallingRoom, RoomError, Scope | PeerConnector | Socket.WebSocketConstructor>` (were plain functions returning a room at once). They take `RoomOptions` (`url`, `openTimeout`, `welcomeTimeout`), which replaces `SignallingOptions`: `rtc`, `connectPeer` and `openSocket` are gone. Provide `browserRoomLayer(rtc)` instead, or fakes of its two services.
  - `SignallingRoom` lost `status`, `subscribe` and `close`. It gained `events: Stream<RoomEvent, RoomError>`, and `start` is now `Effect<void>` (was `() => void`). `code` and `self` are `string` (were `string | undefined`). Close the room's scope to leave.
  - `RoomEvent` lost `welcome` (the acquire succeeds instead) and `failed` (the room fails with a `RoomError` instead). `RoomStatus`, `SignallingSocket` and `SignallingSocketHandlers` are removed.
  - `RoomFailure` gained `no-welcome` and `bad-server-message`. Failures are `RoomError` (with `reason`, `message` and the socket's `cause`), exported with the new `PeerLinkError`.
  - The `ConnectPeer` seam (`ConnectPeer`, `ConnectPeerOptions`, `PeerConnecting`) became the `PeerConnector` service, whose `connect(options)` is `Effect<PeerLink, PeerLinkError, Scope>` and reads the peer's signals from a `Queue`. The socket seam became `Socket.WebSocketConstructor`.
  - `PeerLink.close` is removed: the scope `connect` ran in owns the link. `PeerLink.closed` is new, an `Effect<void>` that succeeds once the link has closed: a channel closed, the connection failed, or the scope closed.
  - `RtcOptions.timeoutMs` became `openTimeout` (a `Duration.Input`, still 20 seconds by default). `RtcOptions.makeConnection` is new, for tests.
  - `TextChannel.onClose` now fires on a channel that has already closed, at once, inside the `onClose` call.

  Nothing else changes: `linksTransport`, the signalling protocol and the lockstep session are as they were.

- [#53](https://github.com/lucasthevenet/arcadekit/pull/53) [`f1942ba`](https://github.com/lucasthevenet/arcadekit/commit/f1942ba33d3c3bd91cb531c9d8686d7f88f0a66f) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Lockstep sessions have an Effect shell. `hostLockstepScoped(options)` and `joinLockstepScoped(options)` take the same options as `hostLockstep` and `joinLockstep` and return `Effect<ScopedLockstepSession, never, Scope>`: closing the scope stops the session listening to its transport, and the session's time is Effect's `Clock` (its monotonic time, so a `TestClock` drives it in tests). `session.run(ticker?)` ticks it until it stops, then fails with its `LockstepError`, instead of the caller polling `session.error` after each tick; interrupting it stops the ticking. After a desync it fails a second after the stop, its ticks resending the desync until then (the transport may lose it), so every peer stops with the same desync. A run left going after its scope closes dies on its next tick. Without a ticker it ticks every 4 ms of the Clock. A `Ticker` (exported) is `(onTick) => stop`, such as a dedicated worker's timer; each tick is a plain call, done before `onTick` returns, with no Effect run per tick, and the run ends once the `onTick` it stops in has returned. `session.listen(onEvent)` hears the run's events while its scope is open, each call with a listener of its own.

  `hostLockstep` no longer leaks its transport listener when starting throws (a simulation whose `create` throws, an input source whose `read` throws): it stops listening, then rethrows.

  Nothing breaks: the plain sessions, their options and the wire format are unchanged.

- [#51](https://github.com/lucasthevenet/arcadekit/pull/51) [`f46fda2`](https://github.com/lucasthevenet/arcadekit/commit/f46fda2ce4865cfd3c6d53b872d4e31e6d190801) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - Lockstep sessions check what arrives on the wire, so a peer on other code, or a forged message, can no longer freeze a run.

  - Every lockstep message is decoded with an Effect Schema (integer steps, at most 64 inputs, steps or hashes per message, at most 16 players). A message that doesn't decode is dropped, and the rest of what arrived is still handled.
  - The host decodes each peer's input when it arrives and keeps at most 64 steps of it ahead of the last confirmed step. A peer whose input doesn't decode is removed from the run; a peer that can't decode a step from the host stops with a `badInput` error.

  Breaking:

  - `InputCodec.decode` returns `Result<Input, string>` (from `effect`'s `Result`) instead of returning the input or throwing. `jsonCodec` and `schemaCodec` follow; a custom codec must return `Result.succeed(input)` or `Result.fail(why)`.
  - `StopReason` has a new `badInput` kind (`player`, `step`, `issue`), and the `removed` kind has a `why` (`"stalled"` or `"badInput"`, exported as `RemovedWhy`). A `switch` over `reason.kind` needs the new case.
  - `hostLockstep` throws a `RangeError` for more than 16 players.
  - The wire format changed: the `removed` message carries `why`, and senders send at most 64 hashes per message. Peers on this version and an older one can't play together.

- [#54](https://github.com/lucasthevenet/arcadekit/pull/54) [`7c2b526`](https://github.com/lucasthevenet/arcadekit/commit/7c2b526ac444df4606e7afca12dc059b32c119a0) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The signalling protocol (`@arcadekit/net/signalling`) is now Effect Schemas, and its parsers bound what they read.

  - Each message is a Schema, exported under its type's name: `PeerId`, `Signal`, `ClientMessage`, `ServerMessage` and `ErrorReason` (a `Schema.Literals`, so `ErrorReason.literals` lists every reason), plus a new `JoinCode`. The types are the Schemas' types, with the same shapes and the same wire format as before. `parseClientMessage` and `parseServerMessage` still return the message or `undefined`.
  - New `MAX_PEER_ID_LENGTH` (32) and `MAX_TOKEN_LENGTH` (256) are the bounds of a peer id and of an `sdpMid` or ICE username fragment, beside `MAX_MESSAGE_LENGTH` (16 KB) and `MAX_PLAYERS`.
  - `normalizeJoinCode` checks a code with `JoinCode`.

  Breaking:

  - `@arcadekit/net/signalling` now imports `effect` at runtime (it was dependency-free). `effect` is already the package's peer dependency. Its Schemas are built when it loads, so importing anything from it, even a constant or a join-code helper, bundles Effect Schema: about 77 KB minified and 25 KB gzipped (a bundler that inlines constants may still leave it out for a numeric one such as `MAX_PLAYERS`).
  - The parsers refuse messages they used to accept: a peer id over `MAX_PEER_ID_LENGTH` characters, an `sdpMid` or ICE username fragment over `MAX_TOKEN_LENGTH`, an SDP or candidate line over `MAX_MESSAGE_LENGTH`, an `sdpMLineIndex` outside 0 to 65535, and a `welcome` whose `code` isn't a join code or that lists more than `MAX_PLAYERS - 1` peers. A signalling server must send messages within these bounds: `hostRoom` and `joinRoom` ignore a server message they can't decode, so a `welcome` outside them leaves the room `connecting` with no error.

### Patch Changes

- [#51](https://github.com/lucasthevenet/arcadekit/pull/51) [`f46fda2`](https://github.com/lucasthevenet/arcadekit/commit/f46fda2ce4865cfd3c6d53b872d4e31e6d190801) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - The host no longer ends a lockstep run on a peer's word. Before, any peer could stop the run for everyone by sending a desync message with any step and hashes. Now a peer's desync claim counts only as that peer's own hash for the step: the run stops only when the host's own hash for that step differs. A claim about the host's hash, or one with no hash for the sender, is ignored. The host also ignores a peer's hash for a step that isn't a hash step or that no peer can have reached yet, so those don't pile up.

## 0.1.0

### Minor Changes

- [#48](https://github.com/lucasthevenet/arcadekit/pull/48) [`36fedda`](https://github.com/lucasthevenet/arcadekit/commit/36feddaaf0af8bc3218d7b8127b0b2f6505f54aa) Thanks [@lucasthevenet](https://github.com/lucasthevenet)! - First release.
