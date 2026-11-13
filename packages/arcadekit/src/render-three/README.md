# arcadekit/render-three

Three.js drawing for arcadekit games. `Stage` is a renderer, scene and camera that fill an element and resize with it; its `"pixel"` camera (`PixelCamera`) looks straight down and keeps sprite pixels whole. `loadSpriteSheet` loads an Aseprite sheet (PNG and JSON) as an Effect, `resolveTags` picks each tag a view draws, with its fallbacks, `InstancedSprites` draws many sprites from one sheet in one draw call and grows when a frame needs more room, `TileLayer` draws a grid of cells from the same sheet, only the cells the camera shows, `frameAt` picks a tag's frame at a time, and `Gait` says whether a character a view draws is walking. `MeshInstances` draws one mesh many times, each copy with a matrix, a color and the attributes its view declares. `arcadekit/render-three/testing` has what a view's tests need, and only tests import it.

An entry of the [`arcadekit`](../../README.md) package. Needs the DOM and WebGL.

## Install

```bash
pnpm add arcadekit three effect
pnpm add -D @types/three
```

Peer dependencies: `effect` (~4.1), and `three` (^0.187, an optional peer of the package that this entry needs). `@types/three` (^0.187, also optional) gives Three.js its types.

## Example

A view that draws a hero and every enemy, each with its tag's animation, following the hero (a cut-down version of the genres' views). The app loads the sheet and owns it ([below](#a-sheet-is-an-asset)): the view never frees it.

```ts
import {
  Gait,
  InstancedSprites,
  Stage,
  frameAt,
  resolveTags,
} from "arcadekit/render-three";
import type { ResolvedTags, SpriteSheet } from "arcadekit/render-three";

interface World {
  readonly heroX: number;
  readonly heroZ: number;
  readonly enemies: {
    readonly count: number;
    readonly x: Float32Array;
    readonly z: Float32Array;
  };
}

/** Each name the view draws with its tag, or the tags to try in order. */
export const WORLD_TAGS = {
  slime: "slime/move",
  heroWalk: ["hero/walk", "hero/idle"],
  heroIdle: ["hero/idle", "hero/walk"],
} as const;

export class WorldView {
  private readonly stage: Stage<"pixel">;
  private readonly sprites: InstancedSprites;
  private readonly sheet: SpriteSheet;
  private readonly tags: ResolvedTags<typeof WORLD_TAGS>["tags"];
  private readonly gait = new Gait();

  constructor(container: HTMLElement, sheet: SpriteSheet) {
    this.sheet = sheet;
    // Picked once: each tag is the first of its choices the sheet has.
    this.tags = resolveTags(sheet.data, WORLD_TAGS).tags;
    this.stage = new Stage(container, {
      camera: "pixel",
      pixelsPerUnit: 16,
      background: "#17151f",
    });
    // Room for 64 sprites to start with: a frame that pushes more doubles it.
    this.sprites = new InstancedSprites(sheet, { unitsPerPixel: 1 / 16 });
    this.stage.scene.add(this.sprites.mesh);
  }

  render(world: World | null, timeSeconds: number): void {
    if (world !== null) {
      const { gait, sprites, tags } = this;
      const { data } = this.sheet;
      sprites.begin();
      const slime = frameAt(data, tags.slime, timeSeconds);
      for (let i = 0; i < world.enemies.count; i++) {
        sprites.push(world.enemies.x[i]!, world.enemies.z[i]!, slime);
      }
      // The hero walks while its position changes, and a moment after.
      gait.update(world.heroX, world.heroZ, timeSeconds);
      const tag = gait.moving ? tags.heroWalk : tags.heroIdle;
      const hero = sprites.push(
        world.heroX,
        world.heroZ,
        frameAt(data, tag, timeSeconds - gait.since)
      );
      // Over the enemies, whatever their positions.
      sprites.setLayer(hero, 1);
      sprites.end();
      this.stage.camera.follow(world.heroX, world.heroZ);
    }
    this.stage.render();
  }

  dispose(): void {
    // Frees everything in the scene except the sheet's texture, which the app frees.
    this.stage.dispose();
  }
}
```

## Tags

A view names what it draws once, in one object: each name with its tag, or the tags to try in order. `resolveTags(sheet.data, wanted)` gives `tags`, with a `SpriteTag` under every name: the first of its choices the sheet has, or a tag named `""` that shows frame 0 when it has none. So a view never tests for a missing tag, and a sheet that lacks one draws something. An `undefined` among the choices is skipped, for a content entry that may name no sprite of its own: `[def.sprite, "enemy/move"]`.

It also gives `missing`: every choice tried and not found, once each, in the order tried. A choice after the one found is not tried. A call that misses warns once on the console, naming the sheet's image and each missing tag, and a game's test checks its sheet with the same object: `expect(resolveTags(data, WORLD_TAGS).missing).toStrictEqual([])`.

A name given no tag to try, an empty list or one of `undefined`s alone, draws frame 0 as well. The same warning names it, and `missing` does not: no tag was tried, so no sheet could have it. Give such a name a last choice that every sheet of the game has, as `"enemy/move"` is in `[def.sprite, "enemy/move"]`.

Call it when the view is made, or once per run for tags that come from the run's content, never per frame: it allocates.

## A batch of sprites

Each frame a view calls `begin`, then `push(x, z, frame, flipX?)` for every sprite it draws, then `end`, which shows them and uploads them. `push` gives the sprite's index for the other setters (`setTint`, `setAlpha`, `setFlash`, `setLift`, `setLayer`) and starts its look plain, so nothing of the sprite that had the index last frame is left. A batch filled once, such as a ground that only changes when the camera moves, keeps showing its last `end`.

A batch has room for `capacity` sprites (64 unless told) and doubles it when a frame pushes more: its `mesh` and material stay, and its geometry is replaced. So a view makes each batch once, with no count of its own and no size to work out. Once a batch has its size a frame allocates no buffer: `push` and the setters write into the ones it has, and `end` costs the three small records Three.js keeps of what to upload. A `capacity` that is no finite number throws a `RangeError`.

`snap` says what a sprite's position is rounded to, in the shader:

| `snap` | Rounds to | For |
| --- | --- | --- |
| `"sprite"`, the default | whole sprite pixels | everything on one grid with the ground, so the art never shimmers |
| `"screen"` | whole screen pixels of the `PixelCamera` that draws it | what slides between two cells: a screen pixel is finer than a sprite pixel at any pixel scale above 1. Drawn by any other camera, it rounds to sprite pixels |
| `"none"` | nothing | positions as pushed |

A batch says which it was made with, as `snap`.

## A tile layer

A floor of tiles is a grid of cells, and a view draws only the ones on screen. A `TileLayer` does it in one draw call: each frame the view gives `draw` the rectangle of ground its camera shows and a function that says which frame a cell shows. `PixelCamera.groundOnScreen(out)` writes that rectangle into an object the view keeps, after `follow` or `fit`.

Cell (col, row) is the square of ground from (col, row) to (col + 1, row + 1), and its tile is drawn at its centre. `frameOf(col, row)` gives a frame's index, as `frameAt` does, or a negative number for a cell with no tile. The layer imports nothing of the rules: a game whose level is a [tile map](../core/README.md#a-tile-map) reads it in that function, where `cellAt` gives -1 for a cell off the map, and a game whose ground is a rule of the cell alone, such as an arena's wall, works the frame out there.

```ts
import type { TileMap } from "arcadekit/core";
import { Stage, TileLayer, resolveTags } from "arcadekit/render-three";
import type {
  MutableGroundBounds,
  ResolvedTags,
  SpriteSheet,
} from "arcadekit/render-three";

/** The track as the rules hold it. */
const TRACK_LAYOUT = {
  /** 1 where a cell is road, and 0 where it is grass. */
  tile: Uint8Array,
};
type Track = TileMap<typeof TRACK_LAYOUT>;

interface Race {
  readonly track: Track;
  readonly carX: number;
  readonly carZ: number;
}

const TRACK_TAGS = { grass: "track/grass", road: "track/road" } as const;

export class TrackView {
  private readonly stage: Stage<"pixel">;
  private readonly ground: TileLayer;
  private readonly tags: ResolvedTags<typeof TRACK_TAGS>["tags"];
  /** The ground the camera shows: one object, filled each frame. */
  private readonly seen: MutableGroundBounds = {
    minX: 0,
    maxX: 0,
    minZ: 0,
    maxZ: 0,
  };
  /** The track being drawn. */
  private track: Track | null = null;

  /**
   * Which frame a cell shows, or -1 for none. Kept as a field: an arrow written in the call
   * to `draw` would be a new closure on every frame.
   */
  private readonly frameOf = (col: number, row: number): number => {
    const { tags, track } = this;
    if (track === null) {
      return -1;
    }
    const cell = track.cellAt(col, row);
    // Off the track: no tile, and the stage's background shows.
    if (cell === -1) {
      return -1;
    }
    return track.fields.tile[cell] === 1 ? tags.road.from : tags.grass.from;
  };

  constructor(container: HTMLElement, sheet: SpriteSheet) {
    this.tags = resolveTags(sheet.data, TRACK_TAGS).tags;
    this.stage = new Stage(container, {
      camera: "pixel",
      pixelsPerUnit: 16,
      background: "#17151f",
    });
    // 16 px frames, one to a cell, under everything else.
    this.ground = new TileLayer(sheet);
    this.stage.scene.add(this.ground.mesh);
  }

  render(race: Race | null): void {
    if (race !== null) {
      const { camera } = this.stage;
      if (this.track !== race.track) {
        // Another run's track: what `frameOf` gives has changed.
        this.track = race.track;
        this.ground.invalidate();
      }
      camera.follow(race.carX, race.carZ);
      this.ground.draw(camera.groundOnScreen(this.seen), this.frameOf);
    }
    this.stage.render();
  }

  dispose(): void {
    // Frees the layer with the rest of the scene, and never the sheet's texture.
    this.stage.dispose();
  }
}
```

- **A fill asks `frameOf` once for each cell that touches the rectangle**, row by row, and pushes a tile for each frame that is not negative into a batch of the layer's own, which grows with the window. A cell that shares only an edge with the rectangle is left out.
- **It fills only when the rectangle touches other cells than at the last fill**: when an edge of it crosses into another cell. A camera whose edges stay within the same cells costs the layer nothing, and its batch keeps showing its last fill. A rectangle that is not a whole number of cells wide has edges that cross at different places, so a camera moving one cell east can fill twice on the way.
- **`invalidate()` makes the next `draw` fill again**, for when what `frameOf` gives has changed: another level, a tile the rules changed, an animated tile's next frame, or another function handed to `draw`. The layer is told of none of them, and compares no functions. A board small enough to fill on every frame, as push-puzzle's is, calls it before each `draw`.
- **`tint` multiplies every tile's colours**, as a batch's `setTint` does one sprite's: a dimmed floor behind a menu. It is white when the layer is made, and a change shows from the next fill, so `invalidate` after it.
- **`count` is the tiles the last fill drew**, and `mesh` is what goes in the scene. The options are a batch's `unitsPerPixel` (1/16 unless told: a 16 px frame fills a cell) and `layer` (0 unless told), and a layer rounds to sprite pixels, as the ground of every other batch does.
- **What is no cell is no tile.** Something larger than a cell or between two, such as a patch of dirt three cells wide, goes in an `InstancedSprites` of its own in a layer above.

## Walking

The rules hold a position and no animation, so whether a character is walking is the view's to work out. A `Gait` does it for one character from the positions it is shown at: `update(x, z, time)` once per frame drawn, then `moving`, which is true from a change of position until `linger` seconds after the last one (0.1 unless told), and `since`, the time of the update that last changed `moving`, to play the walk from its first frame. The linger keeps a frame with no step, or the gap between two turns of a held key, from flickering the character back to standing. `reset()` forgets the position, for a new run.

It has no facing: which way a character looks is the game's to say, from its rules or from the way it last moved.

## A sheet is an asset

A game declares its sheet as an [`Asset`](../content/README.md): the app says where it comes from, anything loads it with `.load`, the first success is kept, and the app's end frees it.

```ts
import { Asset } from "arcadekit/content";
import { loadSpriteSheet } from "arcadekit/render-three";
import type { SpriteSheet, SpriteSheetError } from "arcadekit/render-three";

/** The app's sheet: loaded once, and freed when the app ends. */
export class RaceSheet extends Asset<SpriteSheet, SpriteSheetError>()(
  "RaceSheet",
  { release: (sheet) => sheet.dispose() }
) {}

// The app says where it comes from, with its other layers. Building it loads nothing.
export const sheetLayer = RaceSheet.layer(
  loadSpriteSheet("/sprites/race.json")
);

// Its loading screen loads it, to show a failure and retry; so does anything else.
export const loadSheet = RaceSheet.load;
```

A [`Game.Engine`](../game/README.md) names it in `uses` (`uses: { sheet: RaceSheet.load }`), so each attach takes the sheet already loaded and hands it to the view. The view draws from it and never frees it: `disposeObject` and `Stage.dispose` skip its texture.

## Mesh instances

`MeshInstances` draws up to `capacity` copies of one mesh in a single draw call. `set(index, x, y, z, scale?, rotationY?)` places one, `setMatrix(index, matrix)` gives it any transform (a squash, a tilt of its own), `setColor` tints it, and `commit(count)` shows the first `count` and uploads the changes.

A material with a shader of the game's own reads more than a matrix and a color. The view declares those values as `attributes`, floats per instance by the name the shader reads each under, and writes them with `setAttribute`. A name it didn't declare is a type error.

The declared attributes go on the geometry the instances are given, and `dispose` takes them off again. So a name the geometry already has is refused when the instances are made: `position` or `uv`, or what other instances over the same geometry declared, which need a geometry of their own. So are `instanceMatrix` and `instanceColor`, where Three.js keeps what `setMatrix` and `setColor` write.

```ts
import { MeshInstances } from "arcadekit/render-three";
import * as THREE from "three";

// The shader is the game's. For each ring it reads `aRing` (x, z and radius) and `aColor`.
const material = new THREE.ShaderMaterial({
  vertexShader: `
    attribute vec3 aRing;
    attribute vec3 aColor;
    varying vec3 vColor;
    void main() {
      vColor = aColor;
      vec2 p = aRing.xy + position.xz * aRing.z;
      gl_Position = projectionMatrix * viewMatrix * vec4(p.x, 0.1, p.y, 1.0);
    }`,
  fragmentShader: `
    varying vec3 vColor;
    void main() {
      gl_FragColor = vec4(vColor, 1.0);
    }`,
});
// A quad lying on the ground.
const quad = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);

export const rings = new MeshInstances(quad, material, {
  capacity: 16,
  attributes: { aRing: 3, aColor: 3 },
});

interface Hero {
  readonly x: number;
  readonly z: number;
  readonly reach: number;
  readonly color: THREE.Color;
}

/** Each frame: a ring around every hero. */
export const drawRings = (heroes: readonly Hero[]): void => {
  for (let i = 0; i < heroes.length; i++) {
    const hero = heroes[i]!;
    rings.setAttribute(i, "aRing", hero.x, hero.z, hero.reach);
    rings.setAttribute(i, "aColor", hero.color.r, hero.color.g, hero.color.b);
  }
  rings.commit(heroes.length);
};

// A material that reads the instance's matrix, as Three.js's own do, takes any transform.
// One matrix, refilled for each instance: `setMatrix` copies it.
const lean = new THREE.Matrix4();
export const leanCrate = (
  crates: MeshInstances,
  index: number,
  x: number,
  z: number,
  angle: number
): void => {
  lean.makeRotationZ(angle).setPosition(x, 0.5, z);
  crates.setMatrix(index, lean);
};
```

## Testing a view

`arcadekit/render-three/testing` runs a view's drawing in Node, with no WebGL. `testSheet(tags)` is a sheet with the tags a test names, each with its number of 16 px frames of 100 ms, and an image that is only a size. `drawnSprites(batch)` is every sprite a batch shows, in the order pushed: its position as pushed, its frame and the tag that holds it, its flip, tint, flash, lift and layer. Given a `TileLayer`, it is every tile of the layer's last fill, each at its cell's centre. So a test draws a frame with its view and reads what the view's batches and layers show, and knows nothing of how a batch stores it. The rounding of a position is the shader's, so a test holds which one a batch was made with by its `snap`.

Two more check the sheet a game ships, from the bytes of its PNG: `pngSize(png)` is its width and height, which the sheet's JSON must match, and `framesWithSoftAlpha(sheet, png, blended?)` names every frame with a pixel that is neither clear nor opaque. A batch draws opaque unless it is made `transparent`, cutting out pixels below half alpha, so such a frame will not look as it was painted; the tags a view draws blended, such as a soft shadow, go in `blended`. It reads an 8-bit RGBA PNG without interlacing, and throws for any other. This entry imports `node:zlib` for it, so only a test or a script can import it.

```ts
import { InstancedSprites, frameAt, resolveTags } from "arcadekit/render-three";
import type {
  ResolvedTags,
  SpriteSheet,
  SpriteSheetData,
} from "arcadekit/render-three";
import {
  drawnSprites,
  framesWithSoftAlpha,
  pngSize,
  testSheet,
} from "arcadekit/render-three/testing";

const BOARD_TAGS = {
  floor: "floor",
  idle: "player/idle",
  shadow: "shadow",
} as const;

/** A view's drawing, cut down to a floor tile and the player on it. */
class BoardSprites {
  readonly batch: InstancedSprites;
  private readonly sheet: SpriteSheet;
  private readonly tags: ResolvedTags<typeof BOARD_TAGS>["tags"];

  constructor(sheet: SpriteSheet) {
    this.sheet = sheet;
    this.tags = resolveTags(sheet.data, BOARD_TAGS).tags;
    this.batch = new InstancedSprites(sheet);
  }

  draw(playerX: number, time: number): void {
    const { batch, tags } = this;
    batch.begin();
    batch.push(playerX, 0, tags.floor.from);
    batch.push(playerX, 0, frameAt(this.sheet.data, tags.idle, time), true);
    batch.end();
  }
}

// A sheet with these tags and numbers of frames. No image, no WebGL.
const view = new BoardSprites(
  testSheet({ floor: 3, "player/idle": 2, shadow: 1 })
);
view.draw(2, 0.15);

// In a test: `expect(drawn).toStrictEqual(["floor at 2", "player/idle at 2, flipped"])`.
export const drawn = drawnSprites(view.batch).map(
  (sprite) => `${sprite.tag} at ${sprite.x}${sprite.flipX ? ", flipped" : ""}`
);

// The sheet the game ships, from its files: `data` is its decoded JSON, and `png` the bytes
// of its image, as `readFileSync` gives them. In a test, each is `toStrictEqual` the value
// beside it.
export const checkSheet = (data: SpriteSheetData, png: Uint8Array) => ({
  // Every tag the view draws: []
  missing: resolveTags(data, BOARD_TAGS).missing,
  // { width: data.width, height: data.height }
  size: pngSize(png),
  // The shadow is drawn blended, so its soft edge is meant: []
  soft: framesWithSoftAlpha(data, png, ["shadow"]),
});
```

See [ADR-0015](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0015-pixel-art-sprites-loaded-by-the-app.md) (pixel-art sprites loaded by the app).
