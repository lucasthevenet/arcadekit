# Sprites

Pixel art is drawn from an Aseprite sheet, a PNG and its JSON: `SpriteSheet.fromUrl` loads one, `SpriteSheet.resolveTags` picks each tag a view draws, and `SpriteSheet.frameAt` picks the frame a tag shows at a time. `InstancedSprites` draws many sprites from one sheet in one draw call, and a `Gait` says whether a character a view draws is walking.

## A view of sprites

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

## Walking

The rules hold a position and no animation, so whether a character is walking is the view's to work out. A gait does it for one character from the positions it is shown at: `Gait.update(gait, x, z, time)` once per frame drawn, then `gait.moving`, which is true from a change of position until `linger` seconds after the last one (0.1 unless told), and `gait.since`, the time of the update that last changed `moving`, to play the walk from its first frame. The linger keeps a frame with no step, or the gap between two turns of a held key, from flickering the character back to standing. `Gait.reset(gait)` forgets the position, for a new run.

It has no facing: which way a character looks is the game's to say, from its rules or from the way it last moved.

## A sheet is an asset

A game declares its sheet as an [`Asset`](content.md): the app says where it comes from, anything loads it with `.load`, the first success is kept, and the app's end frees it with `SpriteSheet.dispose`.

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

A [`Game.Engine`](engine.md) names it in `uses` (`uses: { sheet: RaceSheet.load }`), so each attach takes the sheet already loaded and hands it to the view. The view draws from it and never frees it: `Stage.dispose` and `Stage.disposeObject` skip its texture.
