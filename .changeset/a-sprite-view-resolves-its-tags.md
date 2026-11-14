---
"arcadekit": minor
---

`arcadekit/render-three` gains `SpriteSheet.resolveTags`, `Gait`, batches that grow and `MeshInstances` with a matrix and declared attributes; the new entry `arcadekit/render-three/testing` has `TestSpriteSheet`, `DrawnSprites` and two PNG checks (0.7.0's names: see the changeset that gives render-three Effect's module shape). **Breaking**: `InstancedSprites.set` and `commit` are `push` and `end`, `snap` is one of three words, and `MeshInstances` takes `{ capacity }`.

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

Both genres use every part. Survivors' view resolves its tags once when it is made and once per run for the tags its content names, pushes into batches it makes once, keeps a `Gait` for each hero, and draws its aura rings through `MeshInstances` with two declared attributes, its shader unchanged. Push-puzzle's view draws from `Art.tags`, slides its boxes and its player in a batch that rounds to screen pixels, and walks its player with a `Gait`. Their tests read `DrawnSprites.read`, and their apps' tests check the shipped sheets with `Png.size` and `Png.framesWithSoftAlpha`.

**Breaking**

- `InstancedSprites.set(index, x, z, frame, flipX?)` and `commit(count)` are gone. Write `InstancedSprites.begin(sprites)`, then `const index = InstancedSprites.push(sprites, x, z, frame, flipX?)` for each sprite, then `InstancedSprites.end(sprites)`.
- `InstancedSprites.Options`'s `capacity` is optional, and is the room a batch starts with, not the most it draws. `capacity` on a batch grows.
- `snap` takes one of three words where it took a boolean: `true` was `"sprite"`, and `false` is `"none"`. A view that rounded positions to screen pixels itself and passed `false` passes `"screen"` and pushes them as they are.
- `new MeshInstances(geometry, material, capacity)` becomes `MeshInstances.make(geometry, material, { capacity })`.
- A sprite batch's uniform `uSnap` is `uSnapUnit`, the world units a position is rounded to. A test that read a batch's attributes or uniforms reads `DrawnSprites.read(batch)`.
- Not in the published package: `@arcadekit/push-puzzle/browser` exports `Art.tags`, each name with its tags, in place of the list `PUSH_PUZZLE_SPRITE_TAGS`, and `@arcadekit/survivors/browser` exports `Art.tags(content)`, for `SpriteSheet.resolveTags(data, Art.tags(content)).missing`, in place of `missingSpriteTags(sheet, content)`. A push-puzzle tag missing with all its fallbacks draws frame 0 where it drew nothing.

No recorded hash moved: only drawing changed.
