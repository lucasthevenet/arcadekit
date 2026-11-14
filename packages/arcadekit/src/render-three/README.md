# arcadekit/render-three

Three.js drawing for arcadekit games. A `Stage` is a renderer, scene and camera that fill an element and resize with it; its `"pixel"` camera (a `PixelCamera`) looks straight down and keeps sprite pixels whole. `SpriteSheet.fromUrl` loads an Aseprite sheet (PNG and JSON) as an Effect, `SpriteSheet.resolveTags` picks each tag a view draws, with its fallbacks, and `SpriteSheet.frameAt` picks a tag's frame at a time. `InstancedSprites` draws many sprites from one sheet in one draw call and grows when a frame needs more room, `TileLayer` draws a grid of cells from the same sheet, only the cells the camera shows, and a `Gait` says whether a character a view draws is walking. `MeshInstances` draws one mesh many times, each copy with a matrix, a color and the attributes its view declares, and `Camera` places a 3D stage's camera over the ground. `arcadekit/render-three/testing` has what a view's tests need, and only tests import it.

An entry of the [`arcadekit`](../../README.md) package. Needs the DOM and WebGL.

## Install

```bash
pnpm add arcadekit three effect
pnpm add -D @types/three
```

Peer dependencies: `effect` (~4.1), and `three` (^0.187, an optional peer of the package that this entry needs). `@types/three` (^0.187, also optional) gives Three.js its types.

Loading a sheet is an Effect, with a typed error. Drawing runs none: a view draws inside the frame the browser shows, so its calls are plain, and the engine makes and disposes the view around them.

## Its modules

Each module is a namespace, written as a module of Effect is: a data type named after it, its `make`, a guard, and functions that take the value first.

| Namespace | What it holds |
| --- | --- |
| `Stage` | A renderer, a scene and a camera that fill an element and resize with it |
| `PixelCamera` | A camera that looks straight down and keeps sprite pixels whole, with the arithmetic of its pixel scale |
| `Camera` | Where a 3D stage's camera goes: following, circling or fitting a rectangle of ground |
| `SpriteSheet` | A sheet's frames and tags, its image as a texture, its load, and the frame a tag shows at a time |
| `InstancedSprites` | A batch of sprites from one sheet, drawn in one draw call |
| `TileLayer` | A grid of cells drawn from a sheet, only the cells on screen |
| `Gait` | Whether a character a view draws is walking |
| `MeshInstances` | Copies of one mesh, drawn in one draw call |

A function of a value takes it first, and with one argument less gives the function a `pipe` applies: `InstancedSprites.setLayer(sprites, hero, 1)`, or `sprites.pipe(InstancedSprites.setLayer(hero, 1))`.

## Example

A view that draws a hero and every enemy, each with its tag's animation, following the hero (a cut-down version of the genres' views). The app loads the sheet and owns it ([below](#a-sheet-is-an-asset)): the view never frees it.

```ts
import {
  Gait,
  InstancedSprites,
  PixelCamera,
  SpriteSheet,
  Stage,
} from "arcadekit/render-three";

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
  private readonly stage: Stage.Stage<"pixel">;
  private readonly sprites: InstancedSprites.InstancedSprites;
  private readonly sheet: SpriteSheet.SpriteSheet;
  private readonly tags: SpriteSheet.ResolvedTags<typeof WORLD_TAGS>["tags"];
  private readonly gait = Gait.make();

  constructor(container: HTMLElement, sheet: SpriteSheet.SpriteSheet) {
    this.sheet = sheet;
    // Picked once: each tag is the first of its choices the sheet has.
    this.tags = SpriteSheet.resolveTags(sheet.data, WORLD_TAGS).tags;
    this.stage = Stage.make(container, {
      camera: "pixel",
      pixelsPerUnit: 16,
      background: "#17151f",
    });
    // Room for 64 sprites to start with: a frame that pushes more doubles it.
    this.sprites = InstancedSprites.make(sheet, { unitsPerPixel: 1 / 16 });
    this.stage.scene.add(this.sprites.mesh);
  }

  render(world: World | null, timeSeconds: number): void {
    if (world !== null) {
      const { gait, sprites, tags } = this;
      const { data } = this.sheet;
      InstancedSprites.begin(sprites);
      const slime = SpriteSheet.frameAt(data, tags.slime, timeSeconds);
      for (let i = 0; i < world.enemies.count; i++) {
        InstancedSprites.push(
          sprites,
          world.enemies.x[i]!,
          world.enemies.z[i]!,
          slime
        );
      }
      // The hero walks while its position changes, and a moment after.
      Gait.update(gait, world.heroX, world.heroZ, timeSeconds);
      const tag = gait.moving ? tags.heroWalk : tags.heroIdle;
      const hero = InstancedSprites.push(
        sprites,
        world.heroX,
        world.heroZ,
        SpriteSheet.frameAt(data, tag, timeSeconds - gait.since)
      );
      // Over the enemies, whatever their positions.
      InstancedSprites.setLayer(sprites, hero, 1);
      InstancedSprites.end(sprites);
      PixelCamera.follow(this.stage.camera, world.heroX, world.heroZ);
    }
    Stage.render(this.stage);
  }

  dispose(): void {
    // Frees everything in the scene except the sheet's texture, which the app frees.
    Stage.dispose(this.stage);
  }
}
```

## A stage

`Stage.make(container, options)` makes a WebGL renderer whose canvas fills `container`, a scene, and the camera `options.camera` names: `"perspective"` (the default) for a 3D world seen from a point, `"orthographic"` for a flat board, and `"pixel"` for pixel art seen straight down. Its `renderer`, `scene` and `camera` are fields a view uses as Three.js's own: `stage.scene.add(mesh)`, `stage.scene.fog`, a perspective camera's `fov`. `Stage.render(stage)` draws the scene once, at the end of a view's frame.

It resizes with its container. A perspective camera takes the new aspect ratio, an orthographic one keeps its view height and widens or narrows, and a pixel camera picks its pixel scale again. A pixel stage sizes its drawing buffer to the canvas's exact device pixels, where the others cap the pixel ratio at 2.

`Stage.dispose(stage)` frees every geometry, material and texture in its scene, but for the textures `Stage.keepTexture` marked, such as a sprite sheet's, then releases the WebGL context and removes the canvas. A view that takes an object out of the scene frees it with `Stage.disposeObject(object)`, which skips kept textures too.

A view makes its stage when it is made, and disposes it in its own `dispose`: the engine makes the view on each attach and disposes it when the attach ends, so the stage lives as long as the attach.

The 3D cameras are placed by `Camera`: `Camera.follow(camera, target, offset)` keeps a fixed offset from a point on the ground, `Camera.orbit` circles one, and `Camera.fit(camera, bounds, options)` shows a rectangle of ground whole, at the camera's aspect ratio. A pixel camera is placed by its own functions, which keep its pixels whole: `PixelCamera.follow(camera, x, z)` centres it on a point, and `PixelCamera.fit(camera, bounds, margin)` shows an area at the largest whole pixel scale that fits.

## Tags

A view names what it draws once, in one object: each name with its tag, or the tags to try in order. `SpriteSheet.resolveTags(sheet.data, wanted)` gives `tags`, with a `SpriteSheet.Tag` under every name: the first of its choices the sheet has, or a tag named `""` that shows frame 0 when it has none. So a view never tests for a missing tag, and a sheet that lacks one draws something. An `undefined` among the choices is skipped, for a content entry that may name no sprite of its own: `[def.sprite, "enemy/move"]`.

It also gives `missing`: every choice tried and not found, once each, in the order tried. A choice after the one found is not tried. A call that misses warns once on the console, naming the sheet's image and each missing tag, and a game's test checks its sheet with the same object: `expect(SpriteSheet.resolveTags(data, WORLD_TAGS).missing).toStrictEqual([])`.

A name given no tag to try, an empty list or one of `undefined`s alone, draws frame 0 as well. The same warning names it, and `missing` does not: no tag was tried, so no sheet could have it. Give such a name a last choice that every sheet of the game has, as `"enemy/move"` is in `[def.sprite, "enemy/move"]`.

Call it when the view is made, or once per run for tags that come from the run's content, never per frame: it allocates.

## A batch of sprites

Each frame a view calls `InstancedSprites.begin`, then `InstancedSprites.push(sprites, x, z, frame, flipX?)` for every sprite it draws, then `InstancedSprites.end`, which shows them and uploads them. `push` gives the sprite's index for the other setters (`setTint`, `setAlpha`, `setFlash`, `setLift`, `setLayer`) and starts its look plain, so nothing of the sprite that had the index last frame is left. A batch filled once, such as a ground that only changes when the camera moves, keeps showing its last `end`.

A batch has room for `capacity` sprites (64 unless told) and doubles it when a frame pushes more: its `mesh` and material stay, and its geometry is replaced. So a view makes each batch once, with no count of its own and no size to work out. Once a batch has its size a frame allocates no buffer: `push` and the setters write into the ones it has, and `end` costs the three small records Three.js keeps of what to upload. A `capacity` that is no finite number throws a `RangeError`.

`snap` says what a sprite's position is rounded to, in the shader:

| `snap` | Rounds to | For |
| --- | --- | --- |
| `"sprite"`, the default | whole sprite pixels | everything on one grid with the ground, so the art never shimmers |
| `"screen"` | whole screen pixels of the pixel camera that draws it | what slides between two cells: a screen pixel is finer than a sprite pixel at any pixel scale above 1. Drawn by any other camera, it rounds to sprite pixels |
| `"none"` | nothing | positions as pushed |

A batch says which it was made with, as `snap`.

## A tile layer

A floor of tiles is a grid of cells, and a view draws only the ones on screen. A tile layer does it in one draw call: each frame the view gives `TileLayer.draw` the rectangle of ground its camera shows and a function that says which frame a cell shows. `PixelCamera.groundOnScreen(camera, out)` writes that rectangle into an object the view keeps, after `follow` or `fit`.

Cell (col, row) is the square of ground from (col, row) to (col + 1, row + 1), and its tile is drawn at its centre. `frameOf(col, row)` gives a frame's index, as `SpriteSheet.frameAt` does, or a negative number for a cell with no tile. The layer imports nothing of the rules: a game whose level is a [tile map](../core/README.md#a-tile-map) reads it in that function, where `TileMap.cellAt` gives -1 for a cell off the map, and a game whose ground is a rule of the cell alone, such as an arena's wall, works the frame out there.

```ts
import { TileMap } from "arcadekit/core";
import {
  PixelCamera,
  SpriteSheet,
  Stage,
  TileLayer,
} from "arcadekit/render-three";
import type { Camera } from "arcadekit/render-three";

/** The track as the rules hold it. */
const TRACK_LAYOUT = {
  /** 1 where a cell is road, and 0 where it is grass. */
  tile: Uint8Array,
};
type Track = TileMap.TileMap<typeof TRACK_LAYOUT>;

interface Race {
  readonly track: Track;
  readonly carX: number;
  readonly carZ: number;
}

const TRACK_TAGS = { grass: "track/grass", road: "track/road" } as const;

export class TrackView {
  private readonly stage: Stage.Stage<"pixel">;
  private readonly ground: TileLayer.TileLayer;
  private readonly tags: SpriteSheet.ResolvedTags<typeof TRACK_TAGS>["tags"];
  /** The ground the camera shows: one object, filled each frame. */
  private readonly seen: Camera.MutableGroundBounds = {
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
    const cell = TileMap.cellAt(track, col, row);
    // Off the track: no tile, and the stage's background shows.
    if (cell === -1) {
      return -1;
    }
    return track.fields.tile[cell] === 1 ? tags.road.from : tags.grass.from;
  };

  constructor(container: HTMLElement, sheet: SpriteSheet.SpriteSheet) {
    this.tags = SpriteSheet.resolveTags(sheet.data, TRACK_TAGS).tags;
    this.stage = Stage.make(container, {
      camera: "pixel",
      pixelsPerUnit: 16,
      background: "#17151f",
    });
    // 16 px frames, one to a cell, under everything else.
    this.ground = TileLayer.make(sheet);
    this.stage.scene.add(this.ground.mesh);
  }

  render(race: Race | null): void {
    if (race !== null) {
      const { camera } = this.stage;
      if (this.track !== race.track) {
        // Another run's track: what `frameOf` gives has changed.
        this.track = race.track;
        TileLayer.invalidate(this.ground);
      }
      PixelCamera.follow(camera, race.carX, race.carZ);
      TileLayer.draw(
        this.ground,
        PixelCamera.groundOnScreen(camera, this.seen),
        this.frameOf
      );
    }
    Stage.render(this.stage);
  }

  dispose(): void {
    // Frees the layer with the rest of the scene, and never the sheet's texture.
    Stage.dispose(this.stage);
  }
}
```

- **A fill asks `frameOf` once for each cell that touches the rectangle**, row by row, and pushes a tile for each frame that is not negative into a batch of the layer's own, which grows with the window. A cell that shares only an edge with the rectangle is left out.
- **It fills only when the rectangle touches other cells than at the last fill**: when an edge of it crosses into another cell. A camera whose edges stay within the same cells costs the layer nothing, and its batch keeps showing its last fill. A rectangle that is not a whole number of cells wide has edges that cross at different places, so a camera moving one cell east can fill twice on the way.
- **`TileLayer.invalidate(layer)` makes the next `draw` fill again**, for when what `frameOf` gives has changed: another level, a tile the rules changed, an animated tile's next frame, or another function handed to `draw`. The layer is told of none of them, and compares no functions. A board small enough to fill on every frame, as push-puzzle's is, invalidates before each `draw`.
- **`tint` multiplies every tile's colours**, as a batch's `setTint` does one sprite's: a dimmed floor behind a menu. It is white when the layer is made, and a change shows from the next fill, so invalidate after it.
- **`count` is the tiles the last fill drew**, and `mesh` is what goes in the scene. The options are a batch's `unitsPerPixel` (1/16 unless told: a 16 px frame fills a cell) and `layer` (0 unless told), and a layer rounds to sprite pixels, as the ground of every other batch does.
- **What is no cell is no tile.** Something larger than a cell or between two, such as a patch of dirt three cells wide, goes in a batch of sprites of its own in a layer above.

## Walking

The rules hold a position and no animation, so whether a character is walking is the view's to work out. A gait does it for one character from the positions it is shown at: `Gait.update(gait, x, z, time)` once per frame drawn, then `gait.moving`, which is true from a change of position until `linger` seconds after the last one (0.1 unless told), and `gait.since`, the time of the update that last changed `moving`, to play the walk from its first frame. The linger keeps a frame with no step, or the gap between two turns of a held key, from flickering the character back to standing. `Gait.reset(gait)` forgets the position, for a new run.

It has no facing: which way a character looks is the game's to say, from its rules or from the way it last moved.

## A sheet is an asset

A game declares its sheet as an [`Asset`](../content/README.md): the app says where it comes from, anything loads it with `.load`, the first success is kept, and the app's end frees it with `SpriteSheet.dispose`.

```ts
import { Asset } from "arcadekit/content";
import { SpriteSheet } from "arcadekit/render-three";

/** The app's sheet: loaded once, and freed when the app ends. */
export class RaceSheet extends Asset<
  SpriteSheet.SpriteSheet,
  SpriteSheet.SpriteSheetError
>()("RaceSheet", { release: SpriteSheet.dispose }) {}

// The app says where it comes from, with its other layers. Building it loads nothing.
export const sheetLayer = RaceSheet.layer(
  SpriteSheet.fromUrl("/sprites/race.json")
);

// Its loading screen loads it, to show a failure and retry; so does anything else.
export const loadSheet = RaceSheet.load;
```

`SpriteSheet.fromUrl` fetches the JSON, then the image its `meta.image` names, relative to the JSON. It fails with a `SpriteSheet.SpriteSheetError` that names the file when either can't be fetched, the JSON is no sheet, or the image isn't the size the JSON says. Interrupting it aborts what it is fetching.

A [`Game.Engine`](../game/README.md) names it in `uses` (`uses: { sheet: RaceSheet.load }`), so each attach takes the sheet already loaded and hands it to the view. The view draws from it and never frees it: `Stage.dispose` and `Stage.disposeObject` skip its texture.

## Mesh instances

`MeshInstances` draws up to `capacity` copies of one mesh in a single draw call. `MeshInstances.set(instances, index, x, y, z, scale?, rotationY?)` places one, `setMatrix` gives it any transform (a squash, a tilt of its own), `setColor` tints it, and `commit(instances, count)` shows the first `count` and uploads the changes.

A material with a shader of the game's own reads more than a matrix and a color. The view declares those values as `attributes`, floats per instance by the name the shader reads each under, and writes them with `MeshInstances.setAttribute`. A name it didn't declare is a type error.

The declared attributes go on the geometry the instances are given, and `MeshInstances.dispose` takes them off again. So a name the geometry already has is refused when the instances are made: `position` or `uv`, or what other instances over the same geometry declared, which need a geometry of their own. So are `instanceMatrix` and `instanceColor`, where Three.js keeps what `setMatrix` and `setColor` write.

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

export const rings = MeshInstances.make(quad, material, {
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
    MeshInstances.setAttribute(rings, i, "aRing", hero.x, hero.z, hero.reach);
    MeshInstances.setAttribute(
      rings,
      i,
      "aColor",
      hero.color.r,
      hero.color.g,
      hero.color.b
    );
  }
  MeshInstances.commit(rings, heroes.length);
};

// A material that reads the instance's matrix, as Three.js's own do, takes any transform.
// One matrix, refilled for each instance: `setMatrix` copies it.
const lean = new THREE.Matrix4();
export const leanCrate = (
  crates: MeshInstances.MeshInstances,
  index: number,
  x: number,
  z: number,
  angle: number
): void => {
  lean.makeRotationZ(angle).setPosition(x, 0.5, z);
  MeshInstances.setMatrix(crates, index, lean);
};
```

## Testing a view

`arcadekit/render-three/testing` runs a view's drawing in Node, with no WebGL. `TestSpriteSheet.fromTags(tags)` is a sheet with the tags a test names, each with its number of 16 px frames of 100 ms, and an image that is only a size. `DrawnSprites.read(batch)` is every sprite a batch shows, in the order pushed: its position as pushed, its frame and the tag that holds it, its flip, tint, flash, lift and layer. Given a tile layer, it is every tile of the layer's last fill, each at its cell's centre. So a test draws a frame with its view and reads what the view's batches and layers show, and knows nothing of how a batch stores it. The rounding of a position is the shader's, so a test holds which one a batch was made with by its `snap`.

Two more check the sheet a game ships, from the bytes of its PNG: `Png.size(png)` is its width and height, which the sheet's JSON must match, and `Png.framesWithSoftAlpha(png, data, blended?)` names every frame with a pixel that is neither clear nor opaque. A batch draws opaque unless it is made `transparent`, cutting out pixels below half alpha, so such a frame will not look as it was painted; the tags a view draws blended, such as a soft shadow, go in `blended`. It reads an 8-bit RGBA PNG without interlacing, and throws for any other. This entry imports `node:zlib` for it, so only a test or a script can import it.

```ts
import { InstancedSprites, SpriteSheet } from "arcadekit/render-three";
import {
  DrawnSprites,
  Png,
  TestSpriteSheet,
} from "arcadekit/render-three/testing";

const BOARD_TAGS = {
  floor: "floor",
  idle: "player/idle",
  shadow: "shadow",
} as const;

/** A view's drawing, cut down to a floor tile and the player on it. */
class BoardSprites {
  readonly batch: InstancedSprites.InstancedSprites;
  private readonly sheet: SpriteSheet.SpriteSheet;
  private readonly tags: SpriteSheet.ResolvedTags<typeof BOARD_TAGS>["tags"];

  constructor(sheet: SpriteSheet.SpriteSheet) {
    this.sheet = sheet;
    this.tags = SpriteSheet.resolveTags(sheet.data, BOARD_TAGS).tags;
    this.batch = InstancedSprites.make(sheet);
  }

  draw(playerX: number, time: number): void {
    const { batch, tags } = this;
    const idle = SpriteSheet.frameAt(this.sheet.data, tags.idle, time);
    InstancedSprites.begin(batch);
    InstancedSprites.push(batch, playerX, 0, tags.floor.from);
    InstancedSprites.push(batch, playerX, 0, idle, true);
    InstancedSprites.end(batch);
  }
}

// A sheet with these tags and numbers of frames. No image, no WebGL.
const view = new BoardSprites(
  TestSpriteSheet.fromTags({ floor: 3, "player/idle": 2, shadow: 1 })
);
view.draw(2, 0.15);

// In a test: `expect(drawn).toStrictEqual(["floor at 2", "player/idle at 2, flipped"])`.
export const drawn = DrawnSprites.read(view.batch).map(
  (sprite) => `${sprite.tag} at ${sprite.x}${sprite.flipX ? ", flipped" : ""}`
);

// The sheet the game ships, from its files: `data` is its decoded JSON, and `png` the bytes
// of its image, as `readFileSync` gives them. In a test, each is `toStrictEqual` the value
// beside it.
export const checkSheet = (data: SpriteSheet.Data, png: Uint8Array) => ({
  // Every tag the view draws: []
  missing: SpriteSheet.resolveTags(data, BOARD_TAGS).missing,
  // { width: data.width, height: data.height }
  size: Png.size(png),
  // The shadow is drawn blended, so its soft edge is meant: []
  soft: Png.framesWithSoftAlpha(png, data, ["shadow"]),
});
```
