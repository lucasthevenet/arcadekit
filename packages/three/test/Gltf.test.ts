/// <reference types="node" />
import { App, Assets, Component, State, Transform3d } from "arcadekit";
import { Cause, Effect, Exit, Fiber, Layer, Logger, Scope } from "effect";
import { InstancedMesh, Texture } from "three";
import type { BufferGeometry, MeshStandardMaterial, Scene, Mesh } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Gltf, Three } from "../src/index";

// --- a model small enough to write out ----------------------------------------------
// One triangle: three indices, then, on a multiple of four, three positions.
const indices = new Uint8Array(new Uint16Array([0, 1, 2]).buffer);

const positions = new Uint8Array(
  new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer
);

const both = new Uint8Array(8 + positions.length);

both.set(indices, 0);

both.set(positions, 8);

interface Doc {
  [key: string]: unknown;
}

/** The triangle's document, with its buffers and views as given. */
const triangle = (
  buffers: readonly Doc[],
  views: readonly Doc[],
  more: Doc = {}
): Doc => ({
  asset: { version: "2.0" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: "Tri" }],
  meshes: [
    {
      name: "TriMesh",
      primitives: [
        { attributes: { POSITION: 1 }, indices: 0, ...(more.primitive as Doc) },
      ],
    },
  ],
  buffers,
  bufferViews: views,
  accessors: [
    { bufferView: 0, componentType: 5123, count: 3, type: "SCALAR" },
    {
      bufferView: 1,
      componentType: 5126,
      count: 3,
      type: "VEC3",
      min: [0, 0, 0],
      max: [1, 1, 0],
    },
  ],
  ...(more.document as Doc),
});

/** Its two views, in one buffer. */
const oneBuffer = [
  { buffer: 0, byteOffset: 0, byteLength: 6 },
  { buffer: 0, byteOffset: 8, byteLength: 36 },
];

const base64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64");

const text = (document: Doc): string => JSON.stringify(document);

/** A binary glTF of a document and what goes in its one chunk of data. */
const glb = (document: Doc, binary?: Uint8Array): Uint8Array => {
  const pad = (bytes: Uint8Array, fill: number): Uint8Array => {
    const out = new Uint8Array((bytes.length + 3) & ~3).fill(fill);
    out.set(bytes);

    return out;
  };

  const json = pad(new TextEncoder().encode(text(document)), 0x20);
  const chunks: (readonly [number, Uint8Array])[] = [[0x4e_4f_53_4a, json]];

  if (binary !== undefined) {
    chunks.push([0x00_4e_49_42, pad(binary, 0)]);
  }

  const length =
    12 + chunks.reduce((sum, [, data]) => sum + 8 + data.length, 0);

  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46_54_6c_67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, length, true);
  let at = 12;

  for (const [type, data] of chunks) {
    view.setUint32(at, data.length, true);
    view.setUint32(at + 4, type, true);
    out.set(data, at + 8);
    at += 8 + data.length;
  }

  return out;
};

/** A loader of files in memory that notes what it was asked for. */
const makeLoader = (files: Readonly<Record<string, Uint8Array | string>>) => {
  const asked: string[] = [];

  const layer = Layer.succeed(Assets.Loader, {
    bytes: (url) =>
      Effect.suspend(() => {
        asked.push(url);
        const file = Object.hasOwn(files, url) ? files[url] : undefined;

        return file === undefined
          ? Effect.fail(
              new Assets.AssetFailed({ url, message: "There is no such file." })
            )
          : Effect.succeed(
              typeof file === "string" ? new TextEncoder().encode(file) : file
            );
      }),
  }) as Layer.Layer<never>;

  return { asked, layer };
};

/** Loads one model into a scope of the test's. */
const load = async (
  url: string,
  files: Readonly<Record<string, Uint8Array | string>>,
  options?: Gltf.ModelOptions
) => {
  const loader = makeLoader(files);
  const scope = Effect.runSync(Scope.make());

  const exit = await Effect.runPromise(
    Effect.exit(
      Assets.load(
        Assets.bundle("gl/Bundle", { model: Gltf.model(url, options) })
      )
    ).pipe(Scope.provide(scope), Effect.provide(loader.layer))
  );

  return {
    asked: loader.asked,
    exit,
    model: Exit.isSuccess(exit) ? exit.value.model : undefined,
    failure: Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};

/** The one mesh of the triangle, and what it is made of. */
const meshOf = (model: Gltf.Model | undefined) => {
  const mesh = model!.scene.children[0] as Mesh<BufferGeometry>;

  return {
    mesh,
    name: mesh.name,
    indices: [...mesh.geometry.index!.array],
    positions: [...mesh.geometry.attributes.position!.array],
  };
};

const TRIANGLE = {
  name: "Tri",
  indices: [0, 1, 2],
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a model", () => {
  it("is a binary glTF, loaded as it is and disposed of with the scope it was loaded in", async () => {
    const file = glb(triangle([{ byteLength: both.length }], oneBuffer), both);

    const { asked, close, model } = await load("/tri.glb", {
      "/tri.glb": file,
    });

    expect(meshOf(model)).toMatchObject(TRIANGLE);
    expect(model!.scenes).toHaveLength(1);
    expect(model!.animations).toStrictEqual([]);
    // One file, asked for once: it names no other.
    expect(asked).toStrictEqual(["/tri.glb"]);
    const { mesh } = meshOf(model);
    const gone: string[] = [];
    mesh.geometry.addEventListener("dispose", () => gone.push("geometry"));
    (mesh.material as MeshStandardMaterial).addEventListener("dispose", () =>
      gone.push("material")
    );
    await close();
    expect(gone.toSorted()).toStrictEqual(["geometry", "material"]);
  });

  it("is a .gltf with its files beside it, each fetched through the loader, once, from where the model is", async () => {
    const files = {
      "/models/tri.gltf": text(
        triangle([{ byteLength: both.length, uri: "tri.bin" }], oneBuffer)
      ),
      "/models/tri.bin": both,
      // Named from the root of the site, and found there.
      "/far.gltf": text(
        triangle(
          [{ byteLength: both.length, uri: "/shared/tri.bin" }],
          oneBuffer
        )
      ),
      "/shared/tri.bin": both,
      // Written into the document itself: nothing to fetch.
      "/inline.gltf": text(
        triangle(
          [
            {
              byteLength: both.length,
              uri: `data:application/octet-stream;base64,${base64(both)}`,
            },
          ],
          oneBuffer
        )
      ),
    };

    const beside = await load("/models/tri.gltf", files);
    expect(meshOf(beside.model)).toMatchObject(TRIANGLE);
    expect(beside.asked).toStrictEqual(["/models/tri.gltf", "/models/tri.bin"]);
    const far = await load("/far.gltf", files);
    expect(meshOf(far.model)).toMatchObject(TRIANGLE);
    expect(far.asked).toStrictEqual(["/far.gltf", "/shared/tri.bin"]);
    const inline = await load("/inline.gltf", files);
    expect(meshOf(inline.model)).toMatchObject(TRIANGLE);
    expect(inline.asked).toStrictEqual(["/inline.gltf"]);
  });

  it("puts several buffers into one, each where the model's views expect it", async () => {
    // The indices in one file and the positions in another, the second
    // read from the middle of its file; and, in a binary glTF, the first
    // in the file itself and the second beside it.
    const padded = new Uint8Array(4 + positions.length);
    padded.set(positions, 4);

    const views = [
      { buffer: 0, byteLength: 6 },
      { buffer: 1, byteOffset: 4, byteLength: 36 },
    ];

    const files = {
      "/m/two.gltf": text(
        triangle(
          [
            { byteLength: 6, uri: `data:;base64,${base64(indices)}` },
            { byteLength: padded.length, uri: "positions.bin" },
          ],
          views
        )
      ),
      "/m/mixed.glb": glb(
        triangle(
          [
            { byteLength: 6 },
            { byteLength: padded.length, uri: "positions.bin" },
          ],
          views
        ),
        indices
      ),
      "/m/positions.bin": padded,
    };

    const two = await load("/m/two.gltf", files);
    expect(meshOf(two.model)).toMatchObject(TRIANGLE);
    expect(two.asked).toStrictEqual(["/m/two.gltf", "/m/positions.bin"]);
    const mixed = await load("/m/mixed.glb", files);
    expect(meshOf(mixed.model)).toMatchObject(TRIANGLE);
    expect(mixed.asked).toStrictEqual(["/m/mixed.glb", "/m/positions.bin"]);
  });

  it("fails its bundle with the file that was missing, or with what was wrong with the model", async () => {
    const files = {
      "/m/tri.gltf": text(
        triangle([{ byteLength: both.length, uri: "gone.bin" }], oneBuffer)
      ),
      "/garbage.glb": "not a model at all",
      "/empty.gltf": "{}",
      "/bad.gltf": text(
        triangle([{ byteLength: 3, uri: "data:;base64,@@@" }], oneBuffer)
      ),
      "/plain.gltf": text(
        triangle([{ byteLength: 3, uri: "data:text/plain,abc" }], oneBuffer)
      ),
      // A binary glTF that says it has a document, and has none.
      "/hollow.glb": glb({}).subarray(0, 12),
    };

    expect((await load("/m/tri.gltf", files)).failure).toStrictEqual(
      new Assets.AssetFailed({
        url: "/m/gone.bin",
        message: "There is no such file.",
      })
    );

    const garbage = (await load("/garbage.glb", files))
      .failure as Assets.AssetFailed;

    expect(garbage).toBeInstanceOf(Assets.AssetFailed);
    expect(garbage.url).toBe("/garbage.glb");
    expect(garbage.message).toMatch(/^It is not a glTF model: /u);

    const hollow = (await load("/hollow.glb", files))
      .failure as Assets.AssetFailed;

    expect([hollow.url, hollow.message]).toStrictEqual([
      "/hollow.glb",
      "It is not a glTF model: It is a binary glTF with no JSON in it.",
    ]);

    // JSON, and no model: Three.js says what it makes of it.
    const empty = (await load("/empty.gltf", files))
      .failure as Assets.AssetFailed;

    expect(empty).toBeInstanceOf(Assets.AssetFailed);
    expect(empty.url).toBe("/empty.gltf");
    expect(empty.message).toMatch(/^It could not be made a model: .+/u);
    const bad = (await load("/bad.gltf", files)).failure as Assets.AssetFailed;
    expect(bad.url).toBe("/bad.gltf");
    expect(bad.message).toMatch(
      /^A file written into it could not be read: .+/u
    );
    expect((await load("/plain.gltf", files)).failure).toStrictEqual(
      new Assets.AssetFailed({
        url: "/plain.gltf",
        message:
          "A file written into it could not be read: It is a data URI that is not base64.",
      })
    );
  });

  it("gives up the files it was still fetching when its loading is given up", async () => {
    const waiting: string[] = [];
    const givenUp: string[] = [];

    const slow = Layer.succeed(Assets.Loader, {
      bytes: (url) =>
        url.endsWith(".gltf")
          ? Effect.succeed(
              new TextEncoder().encode(
                text(
                  triangle(
                    [
                      { byteLength: 6, uri: "a.bin" },
                      { byteLength: 40, uri: "b.bin" },
                    ],
                    [
                      { buffer: 0, byteLength: 6 },
                      { buffer: 1, byteOffset: 4, byteLength: 36 },
                    ]
                  )
                )
              )
            )
          : Effect.callback<Uint8Array, Assets.AssetFailed>(() => {
              waiting.push(url);

              return Effect.sync(() => {
                givenUp.push(url);
              });
            }),
    }) as Layer.Layer<never>;

    const fiber = Effect.runFork(
      Effect.scoped(
        Assets.load(
          Assets.bundle("gl/Slow", { model: Gltf.model("/m/tri.gltf") })
        )
      ).pipe(Effect.provide(slow))
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    // Both at once, and neither is here.
    expect(waiting.toSorted()).toStrictEqual(["/m/a.bin", "/m/b.bin"]);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(givenUp.toSorted()).toStrictEqual(["/m/a.bin", "/m/b.bin"]);
  });

  it("hands its loader to prepare, once each time it is loaded, before the model is read", async () => {
    const file = glb(triangle([{ byteLength: both.length }], oneBuffer), both);
    const prepared: unknown[] = [];

    const options: Gltf.ModelOptions = {
      prepare: (loader) => {
        prepared.push(loader);
      },
    };

    await load("/tri.glb", { "/tri.glb": file }, options);
    await load("/tri.glb", { "/tri.glb": file }, options);
    expect(prepared).toHaveLength(2);
    expect(prepared[0]).toBeInstanceOf(GLTFLoader);
    expect(prepared[1]).not.toBe(prepared[0]);
  });

  it("has its pictures fetched through the loader too, decoded by the page, and closed with it", async () => {
    // What a page has, and Node has not.
    vi.stubGlobal("self", globalThis);
    const decoded: { readonly bytes: number[]; readonly type: string }[] = [];
    const bitmaps: { closed: number }[] = [];
    vi.stubGlobal("createImageBitmap", async (blob: Blob) => {
      decoded.push({
        bytes: [...new Uint8Array(await blob.arrayBuffer())],
        type: blob.type,
      });

      const bitmap = {
        width: 1,
        height: 1,
        closed: 0,
        close() {
          bitmap.closed += 1;
        },
      };

      bitmaps.push(bitmap);

      return bitmap;
    });
    // Enough of a JPEG to be told for one, and bytes that are nothing.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 9, 8, 7]);
    const unknown = new Uint8Array([1, 2, 3]);

    const skinned = (...uris: string[]): Doc =>
      triangle([{ byteLength: both.length, uri: "tri.bin" }], oneBuffer, {
        primitive: { material: 0 },
        document: {
          materials: [
            {
              pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
              ...(uris.length > 1 ? { emissiveTexture: { index: 1 } } : {}),
            },
          ],
          textures: uris.map((_, source) => ({ source })),
          images: uris.map((uri) => ({ uri })),
        },
      });

    const files = {
      "/m/skin.gltf": text(skinned("skin.jpg")),
      "/m/kinds.gltf": text(
        skinned(`data:image/webp;base64,${base64(unknown)}`, "skins/plain.bin")
      ),
      "/m/tri.bin": both,
      "/m/skin.jpg": jpeg,
      "/m/skins/plain.bin": unknown,
    };

    const { asked, close, model } = await load("/m/skin.gltf", files);
    expect(asked.toSorted()).toStrictEqual([
      "/m/skin.gltf",
      "/m/skin.jpg",
      "/m/tri.bin",
    ]);
    // The geometry is where it was, with the picture after it.
    expect(meshOf(model)).toMatchObject(TRIANGLE);
    const { map } = meshOf(model).mesh.material as MeshStandardMaterial;
    expect(map).toBeInstanceOf(Texture);
    // The picture's own bytes, and the kind they say they are.
    expect(decoded).toStrictEqual([{ bytes: [...jpeg], type: "image/jpeg" }]);
    expect(map!.image).toBe(bitmaps[0]);
    let disposed = 0;
    map!.addEventListener("dispose", () => {
      disposed += 1;
    });
    await close();
    expect(disposed).toBe(1);
    expect(bitmaps[0]!.closed).toBe(1);

    // One written into the document is taken from it, and where the bytes
    // do not say what they are, the document's word is taken, or a PNG.
    decoded.length = 0;
    const kinds = await load("/m/kinds.gltf", files);
    expect(kinds.asked.toSorted()).toStrictEqual([
      "/m/kinds.gltf",
      "/m/skins/plain.bin",
      "/m/tri.bin",
    ]);
    expect(
      decoded.toSorted((a, b) => a.type.localeCompare(b.type))
    ).toStrictEqual([
      { bytes: [1, 2, 3], type: "image/png" },
      { bytes: [1, 2, 3], type: "image/webp" },
    ]);

    const material = meshOf(kinds.model).mesh.material as MeshStandardMaterial;

    expect(material.emissiveMap).toBeInstanceOf(Texture);
    await kinds.close();
    expect(bitmaps.map((bitmap) => bitmap.closed)).toStrictEqual([1, 1, 1]);
  });
});

describe("Gltf.mesh", () => {
  it("is a mesh of a model by its name or its node's, or the first, and says which there are when there is none", async () => {
    const file = glb(
      triangle([{ byteLength: both.length }], oneBuffer, {
        document: {
          scenes: [{ nodes: [0, 1, 2, 3] }],
          nodes: [
            { mesh: 0, name: "Tri" },
            { mesh: 1, name: "Other" },
            // A mesh of two parts is two meshes under its node.
            { mesh: 2, name: "Pair" },
            // And one whose node has no name keeps its own.
            { mesh: 3 },
          ],
          meshes: [
            {
              name: "TriMesh",
              primitives: [{ attributes: { POSITION: 1 }, indices: 0 }],
            },
            {
              name: "OtherMesh",
              primitives: [{ attributes: { POSITION: 1 }, indices: 0 }],
            },
            {
              name: "PairMesh",
              primitives: [
                { attributes: { POSITION: 1 }, indices: 0 },
                { attributes: { POSITION: 1 }, indices: 0 },
              ],
            },
            {
              name: "Nameless",
              primitives: [{ attributes: { POSITION: 1 }, indices: 0 }],
            },
          ],
        },
      }),
      both
    );

    const { model } = await load("/two.glb", { "/two.glb": file });
    const [first, second, pair, nameless] = model!.scene.children as Mesh[];
    expect(Gltf.mesh(model!)).toBe(first);
    expect(Gltf.mesh(model!, "Other")).toBe(second);
    expect(Gltf.mesh(model!, "Tri")).toBe(first);
    // The first part of the mesh of two, by the name of what holds both.
    expect(pair!.children).toHaveLength(2);
    expect(Gltf.mesh(model!, "Pair")).toBe(pair!.children[0]);
    expect(Gltf.mesh(model!, "Nameless")).toBe(nameless);
    expect(() => Gltf.mesh(model!, "Hull")).toThrow(
      `Gltf.mesh found no mesh named "Hull" in the model. Its meshes are: ${[
        first,
        second,
        ...pair!.children,
        nameless,
      ]
        .map((one) => `"${one!.name}"`)
        .join(", ")}.`
    );
    // A name the loader gave no mesh: the mesh's own, where a node has one.
    expect(() => Gltf.mesh(model!, "TriMesh")).toThrow("found no mesh named");
    // A look is a geometry and a material, which a mesh has.
    expect(Gltf.mesh(model!).geometry).toBe(first!.geometry);

    const bare = await load("/bare.gltf", {
      "/bare.gltf": text({
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ name: "Empty" }],
      }),
    });

    expect(() => Gltf.mesh(bare.model!)).toThrow(
      "Gltf.mesh was given a model with no mesh in it."
    );
    expect(() => Gltf.mesh(bare.model!, "Hull")).toThrow(
      "Its meshes are: none."
    );
  });
});

const at = (x: number) => Transform3d.Position.of({ x, y: 0, z: 0 });

describe("a level's models", () => {
  const Ship = Component.tag("gl/Ship");
  const Rock = Component.tag("gl/Rock");
  const Level = State.define("gl/Level", ["dock", "space"]);

  it("are what its objects and its instances are made of, for as long as the level", async () => {
    const file = glb(triangle([{ byteLength: both.length }], oneBuffer), both);
    const Fleet = Assets.bundle("gl/Fleet", { ship: Gltf.model("/tri.glb") });

    const Ships = Three.objects("gl/Ships", {
      of: Ship,
      from: Fleet,
      make: (_entity, { ship }) => ship.scene.clone(),
    });

    const Rocks = Three.instances("gl/Rocks", {
      of: Rock,
      from: Fleet,
      look: ({ ship }) => Gltf.mesh(ship, "Tri"),
    });

    let scene: Scene | undefined;

    const renderer = Layer.succeed(Three.Renderer, {
      render(drawn) {
        scene = drawn;
      },
    });

    const scope = Effect.runSync(Scope.make());

    const app = Effect.runSync(
      App.make({
        plugins: [Three.plugin, Assets.plugin],
        components: [Ship, Rock, Level],
        systems: [Assets.during(State.is(Level, "space"), Fleet), Ships, Rocks],
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            renderer,
            makeLoader({ "/tri.glb": file }).layer,
            Logger.layer([])
          )
        ),
        Scope.provide(scope)
      )
    );

    app.world.spawn(Ship, at(1));
    app.world.spawn(Ship, at(2));
    app.world.spawn(Rock, at(3));

    const go = async (to: "dock" | "space"): Promise<void> => {
      app.world.singleton(Level).next = to;
      app.tick(1);
      app.frame(0);
      // A model is read in its own time.
      await new Promise((resolve) => setTimeout(resolve, 0));
      app.frame(0);
    };

    app.frame(0);
    expect(scene!.children).toStrictEqual([]);
    await go("space");

    const [one, two] = scene!.children.filter(
      (child) => !(child instanceof InstancedMesh)
    );

    const rocks = scene!.children.find(
      (child): child is InstancedMesh => child instanceof InstancedMesh
    )!;

    // Two ships, each a copy of the model's scene, where its entity is.
    expect([one!.position.x, two!.position.x]).toStrictEqual([1, 2]);
    expect(one).not.toBe(two);
    const hull = (one!.children[0] as Mesh).geometry;
    expect((two!.children[0] as Mesh).geometry).toBe(hull);
    // And the rocks are instances of the same mesh.
    expect(rocks.geometry).toBe(hull);
    expect(rocks.count).toBe(1);
    let disposed = 0;
    hull.addEventListener("dispose", () => {
      disposed += 1;
    });
    await go("dock");
    expect(scene!.children).toStrictEqual([]);
    expect(disposed).toBe(1);
    Effect.runSync(Scope.close(scope, Exit.void));
  });
});
