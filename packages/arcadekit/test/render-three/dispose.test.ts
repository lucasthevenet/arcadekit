import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  InstancedSprites,
  SpriteSheet,
  Stage,
} from "../../src/render-three/index";

// No WebGL here: disposing only fires "dispose" events, which a renderer would listen to.

/** Counts the "dispose" events each of `things` fires. */
const disposals = (
  things: readonly (THREE.Texture | THREE.Material | THREE.BufferGeometry)[]
) => {
  const counts = new Map<unknown, number>();
  for (const thing of things) {
    counts.set(thing, 0);
    thing.addEventListener("dispose", () =>
      counts.set(thing, (counts.get(thing) ?? 0) + 1)
    );
  }
  return (thing: unknown) => counts.get(thing);
};

const SHEET: SpriteSheet.Data = {
  image: "sheet.png",
  width: 32,
  height: 16,
  frames: [0, 16].map((x) => ({
    name: `f${x}`,
    x,
    y: 0,
    width: 16,
    height: 16,
    offsetX: 0,
    offsetY: 0,
    sourceWidth: 16,
    sourceHeight: 16,
    duration: 0.1,
  })),
  frameByName: new Map([
    ["f0", 0],
    ["f16", 1],
  ]),
  tags: new Map(),
};

/** A stand-in image: three only reads it when uploading. */
const image = { width: 32, height: 16 } as unknown as TexImageSource;

describe(Stage.disposeObject, () => {
  it("frees geometries, materials, their textures and the scene's background", () => {
    const map = new THREE.Texture();
    const uniform = new THREE.Texture();
    const background = new THREE.Texture();
    const geometry = new THREE.BoxGeometry();
    const basic = new THREE.MeshBasicMaterial({ map });
    const shader = new THREE.ShaderMaterial({
      uniforms: { uTexture: { value: uniform } },
    });
    const scene = new THREE.Scene();
    scene.background = background;
    const group = new THREE.Group();
    group.add(new THREE.Mesh(geometry, [basic, shader]));
    scene.add(group);
    const count = disposals([
      map,
      uniform,
      background,
      geometry,
      basic,
      shader,
    ]);

    Stage.disposeObject(scene);

    for (const thing of [map, uniform, background, geometry, basic, shader]) {
      expect(count(thing)).toBe(1);
    }
  });

  it("leaves a kept texture to its owner", () => {
    const kept = Stage.keepTexture(new THREE.Texture());
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(),
      new THREE.MeshBasicMaterial({ map: kept })
    );
    const count = disposals([kept, mesh.material]);
    Stage.disposeObject(mesh);
    expect(Stage.isKeptTexture(kept)).toBe(true);
    expect(count(kept)).toBe(0);
    expect(count(mesh.material)).toBe(1);
  });

  it("frees a sprite batch but not its sheet", () => {
    const sheet = SpriteSheet.make(SHEET, image);
    const sprites = InstancedSprites.make(sheet, { capacity: 4 });
    const scene = new THREE.Scene();
    scene.add(sprites.mesh);
    const frameTable = sprites.mesh.material.uniforms["uFrames"]
      ?.value as THREE.Texture;
    const count = disposals([
      sheet.texture,
      frameTable,
      sprites.mesh.geometry,
      sprites.mesh.material,
    ]);

    Stage.disposeObject(scene);

    expect(count(sheet.texture)).toBe(0);
    expect(count(frameTable)).toBe(1);
    expect(count(sprites.mesh.geometry)).toBe(1);
    expect(count(sprites.mesh.material)).toBe(1);
    SpriteSheet.dispose(sheet);
    expect(count(sheet.texture)).toBe(1);
  });
});
