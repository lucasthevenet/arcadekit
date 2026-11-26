/**
 * The `@arcadekit/three/Gltf` entry point, which loads glTF files as assets.
 *
 *   import * as Gltf from "@arcadekit/three/Gltf"
 *
 *   const Fleet = Assets.bundle("game/Fleet", {
 *     ship: Gltf.model("/ship.glb"),
 *     rock: Gltf.model("/rocks/rock.gltf"),
 *   })
 *
 *   // One object per entity, made from the model while the bundle is loaded.
 *   const Ships = Three.objectsFrom("game/Ships", {
 *     of: Ship,
 *     transform: Transform3d,
 *     from: Fleet,
 *     make: (entity, { ship }) => ship.scene.clone(),
 *   })
 *
 *   // Or a crowd, each entity an instance of one of a model's meshes.
 *   const Rocks = Three.instancesFrom("game/Rocks", {
 *     of: Rock,
 *     transform: Transform3d,
 *     from: Fleet,
 *     look: ({ rock }) => Gltf.mesh(rock, "Boulder"),
 *   })
 *
 * A model loads like any asset, with its bundle and through `Assets.Loader`.
 * When the scope it was loaded in closes, its geometries, materials and
 * textures are disposed of. The buffers and images a `.gltf` file references
 * load the same way, and so do the files a decoder of compressed models
 * fetches. This module fetches them through `Assets.Loader` and hands them to
 * Three.js with the model, so Three.js fetches nothing itself.
 *
 * It is a separate entry point because it imports Three.js's glTF loader,
 * which a game without models doesn't need to ship.
 */
import * as Assets from "arcadekit/Assets";
import { Effect, Schema } from "effect";
import type {
  BufferGeometry,
  LoadingManager,
  Material,
  Mesh,
  Object3D,
  Texture,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";

import * as Three from "./Three.ts";

/**
 * A loaded model, as Three.js's glTF loader returns it. `scene` is its default
 * scene, `scenes` all of them, and `animations` its clips.
 *
 * **Gotchas**
 *
 * - Its animations are loaded, and nothing plays them.
 * - `scene.clone()` doesn't copy a skinned model correctly. Use Three.js's
 *   `SkeletonUtils.clone` for one.
 *
 * @category Models
 */
export type Model = GLTF;

/**
 * Options for loading a model.
 *
 * @category Options
 */
export interface ModelOptions {
  /**
   * The files the loader's decoders fetch, such as
   * `"/draco/draco_decoder.wasm"`. The manager `prepare` receives serves them,
   * fetched through `Assets.Loader`. Defaults to none.
   */
  readonly files?: ReadonlyArray<string>;
  /**
   * Receives the loader once per load, before it parses the model, with the
   * manager that serves `files`. Use it to set the decoders a compressed model
   * needs, with `setDRACOLoader`, `setKTX2Loader` or `setMeshoptDecoder`. Make
   * a DRACO or KTX2 loader here, with the manager:
   *
   *   prepare: (loader, manager) => {
   *     loader.setDRACOLoader(new DRACOLoader(manager).setDecoderPath("/draco/"))
   *   }
   *
   * It is disposed of once the model is parsed.
   */
  readonly prepare?: (loader: GLTFLoader, manager: LoadingManager) => void;
}

// --- a model's files, packed into one ------------------------------------------------

const MAGIC = 0x46_54_6c_67;
const JSON_CHUNK = 0x4e_4f_53_4a;
const BIN_CHUNK = 0x00_4e_49_42;

/**
 * The parts of a glTF document this module reads and rewrites. A document has
 * more, which it keeps as they are.
 */
// Each key may be rewritten, as a document is packed into one file.
const optional = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(Schema.mutableKey(schema));
const required = <S extends Schema.Top>(schema: S) => Schema.mutableKey(schema);
const list = <S extends Schema.Top>(item: S) =>
  optional(Schema.mutable(Schema.Array(item)));

const DocumentSchema = Schema.Struct({
  buffers: list(
    Schema.Struct({
      uri: optional(Schema.String),
      byteLength: required(Schema.Number),
    })
  ),
  bufferViews: list(
    Schema.Struct({
      buffer: required(Schema.Number),
      byteOffset: optional(Schema.Number),
      byteLength: required(Schema.Number),
    })
  ),
  images: list(
    Schema.Struct({
      uri: optional(Schema.String),
      mimeType: optional(Schema.String),
      bufferView: optional(Schema.Number),
    })
  ),
});

type Document = typeof DocumentSchema.Type;

const isDocument = Schema.is(DocumentSchema);

/** Reads a model's JSON, which must be a document of the parts this module uses. */
const documentOf = (bytes: Uint8Array): Document => {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isDocument(parsed)) {
    throw new Error(
      "Its JSON is not a glTF document: its buffers, buffer views or images are not as glTF has them."
    );
  }
  return parsed;
};

const describe = (error: unknown): string =>
  error instanceof Error ? error.message || error.name : String(error);

/** Returns a model's document, and the binary chunk from the same file, if any. */
const read = (
  data: Uint8Array
): { readonly document: Document; readonly binary: Uint8Array | undefined } => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.byteLength < 12 || view.getUint32(0, true) !== MAGIC) {
    return {
      document: documentOf(data),
      binary: undefined,
    };
  }
  let document: Document | undefined;
  let binary: Uint8Array | undefined;
  for (let at = 12; at + 8 <= data.byteLength;) {
    const length = view.getUint32(at, true);
    const type = view.getUint32(at + 4, true);
    const chunk = data.subarray(at + 8, at + 8 + length);
    if (type === JSON_CHUNK) {
      document = documentOf(chunk);
    } else if (type === BIN_CHUNK) {
      binary = chunk;
    }
    at += 8 + length;
  }
  if (document === undefined) {
    throw new Error("It is a binary glTF with no JSON in it.");
  }
  return { document, binary };
};

/** Returns the bytes of a `data:` URI, and the media type it declares. */
const fromDataUri = (
  uri: string
): { readonly bytes: Uint8Array; readonly type: string } => {
  const comma = uri.indexOf(",");
  const head = uri.slice("data:".length, comma);
  const body = uri.slice(comma + 1);
  const type = head.split(";")[0] ?? "";
  if (comma === -1 || !head.endsWith(";base64")) {
    throw new Error("It is a data URI that is not base64.");
  }
  const text = atob(body);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    bytes[i] = text.codePointAt(i)!;
  }
  return { bytes, type };
};

/** Resolves the location of a file a model references, relative to the model. */
const beside = (model: string, uri: string): string =>
  /^[a-z][a-z0-9+.-]*:/iu.test(uri) || uri.startsWith("/")
    ? uri
    : model.slice(0, model.lastIndexOf("/") + 1) + uri;

/** Detects an image's type from its first bytes. */
const pictureType = (bytes: Uint8Array): string | undefined => {
  const starts = (...head: number[]): boolean =>
    head.every((byte, i) => bytes[i] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) {
    return "image/png";
  }
  if (starts(0xff, 0xd8, 0xff)) {
    return "image/jpeg";
  }
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57) {
    return "image/webp";
  }
  if (starts(0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30)) {
    return "image/ktx2";
  }
  return undefined;
};

const aligned = (length: number): number => (length + 3) & ~3;

/**
 * Packs a model and every file it references into a single binary glTF: its
 * buffers joined into one, with its images in that buffer too. Content already
 * in the file is taken from it; files alongside it are fetched through the
 * loader.
 */
const pack = (
  data: Uint8Array,
  url: string,
  loader: Assets.LoaderShape
): Effect.Effect<ArrayBuffer, Assets.AssetFailed> =>
  Effect.gen(function* () {
    const { binary, document } = yield* Effect.try({
      try: () => read(data),
      catch: (error) =>
        new Assets.AssetFailed({
          url,
          message: `It is not a glTF model: ${describe(error)}`,
        }),
    });
    const buffers = document.buffers ?? [];
    const images = document.images ?? [];
    const named =
      buffers.some((buffer) => buffer.uri !== undefined) ||
      images.some((image) => image.uri !== undefined);
    // A binary glTF that names no file is whole as it is.
    if (!named && binary !== undefined) {
      return data.slice().buffer;
    }
    /**
     * Returns the bytes a URI refers to, embedded in the URI itself or in a
     * file alongside the model.
     */
    const fetched = (
      uri: string
    ): Effect.Effect<
      { readonly bytes: Uint8Array; readonly type: string },
      Assets.AssetFailed
    > =>
      uri.startsWith("data:")
        ? Effect.try({
            try: () => fromDataUri(uri),
            catch: (error) =>
              new Assets.AssetFailed({
                url,
                message: `A file written into it could not be read: ${describe(error)}`,
              }),
          })
        : Effect.map(loader.bytes(beside(url, uri)), (bytes) => ({
            bytes,
            type: "",
          }));
    const [bufferBytes, imageBytes] = yield* Effect.all(
      [
        Effect.forEach(
          buffers,
          (buffer) =>
            buffer.uri === undefined
              ? Effect.succeed(binary ?? new Uint8Array(0))
              : Effect.map(fetched(buffer.uri), (file) => file.bytes),
          { concurrency: "unbounded" }
        ),
        Effect.forEach(
          images,
          (image) =>
            image.uri === undefined
              ? Effect.succeed(undefined)
              : fetched(image.uri),
          { concurrency: "unbounded" }
        ),
      ],
      { concurrency: "unbounded" }
    );
    // Every buffer after the other, each starting on a multiple of four.
    const offsets: number[] = [];
    let length = 0;
    for (const bytes of bufferBytes) {
      offsets.push(length);
      length += aligned(bytes.byteLength);
    }
    const views = (document.bufferViews ??= []);
    for (const view of views) {
      view.byteOffset = (view.byteOffset ?? 0) + (offsets[view.buffer] ?? 0);
      view.buffer = 0;
    }
    // And each picture after them, as a view of its own.
    const pictures: { readonly at: number; readonly bytes: Uint8Array }[] = [];
    for (let i = 0; i < images.length; i++) {
      const file = imageBytes[i];
      const image = images[i]!;
      if (file === undefined) {
        continue;
      }
      pictures.push({ at: length, bytes: file.bytes });
      views.push({
        buffer: 0,
        byteOffset: length,
        byteLength: file.bytes.byteLength,
      });
      image.bufferView = views.length - 1;
      image.mimeType ??= pictureType(file.bytes) ?? (file.type || "image/png");
      delete image.uri;
      length += aligned(file.bytes.byteLength);
    }
    document.buffers = [{ byteLength: length }];
    const text = new TextEncoder().encode(JSON.stringify(document));
    const jsonLength = aligned(text.byteLength);
    const packed = new Uint8Array(12 + 8 + jsonLength + 8 + length);
    const out = new DataView(packed.buffer);
    out.setUint32(0, MAGIC, true);
    out.setUint32(4, 2, true);
    out.setUint32(8, packed.byteLength, true);
    out.setUint32(12, jsonLength, true);
    out.setUint32(16, JSON_CHUNK, true);
    // JSON is padded with spaces, as the format asks. (It asks, too, that
    // each buffer start on a multiple of four and that a picture be named
    // by its view alone, which the loader of Three.js does not need.)
    packed.fill(0x20, 20, 20 + jsonLength);
    packed.set(text, 20);
    const start = 20 + jsonLength;
    out.setUint32(start, length, true);
    out.setUint32(start + 4, BIN_CHUNK, true);
    for (let i = 0; i < bufferBytes.length; i++) {
      packed.set(bufferBytes[i]!, start + 8 + offsets[i]!);
    }
    for (const picture of pictures) {
      packed.set(picture.bytes, start + 8 + picture.at);
    }
    return packed.buffer;
  });

// --- letting a model go --------------------------------------------------------------

const isTexture = (value: unknown): value is Texture =>
  typeof value === "object" &&
  value !== null &&
  (value as { isTexture?: boolean }).isTexture === true;

/** Disposes of every geometry, material and texture a model's scenes hold, each once. */
const dispose = (model: Model): void => {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  for (const scene of model.scenes) {
    scene.traverse((object: Object3D) => {
      const { geometry, material } = object as Partial<Mesh>;
      if (geometry !== undefined) {
        geometries.add(geometry);
      }
      for (const one of Array.isArray(material) ? material : [material]) {
        if (one !== undefined) {
          materials.add(one);
        }
      }
    });
  }
  for (const material of materials) {
    for (const value of Object.values(material)) {
      if (isTexture(value)) {
        textures.add(value);
      }
    }
    material.dispose();
  }
  for (const geometry of geometries) {
    geometry.dispose();
  }
  for (const texture of textures) {
    texture.dispose();
    // The picture it was made of, where that is one to close.
    (texture.image as { close?: () => void } | null)?.close?.();
  }
};

// --- the asset -----------------------------------------------------------------------

/**
 * Makes a model asset from a glTF file, `.glb` or `.gltf`. It loads with its
 * bundle, and is disposed of when the scope it was loaded in closes.
 *
 *   const Fleet = Assets.bundle("game/Fleet", {
 *     ship: Gltf.model("/ship.glb"),
 *     rock: Gltf.model("/rocks/rock.gltf"),   // with rock.bin and rock.png beside it
 *   })
 *
 * **Details**
 *
 * - The buffers and images a `.gltf` file references are fetched through
 *   `Assets.Loader`, relative to the model, in parallel. A test's in-memory
 *   files therefore serve them. A missing file fails the bundle with its own
 *   URL. Leaving a level while its model is still loading cancels those
 *   requests.
 * - A file that isn't a valid model fails the bundle with `Assets.AssetFailed`,
 *   which says what was wrong.
 * - Set what a compressed model needs on the loader, in `prepare`, and list
 *   the files its decoders fetch in `files`. They are fetched through
 *   `Assets.Loader` too.
 * - A bundle loads each model once. Copies made with `model.scene.clone()`
 *   share its geometries and materials, so a copy is cheap and has nothing to
 *   free.
 *
 * **Gotchas**
 *
 * - Changing one copy's material changes it for every copy.
 * - The page decodes the model's images, as it does `Three.texture`'s, and
 *   they are closed when the model is released. A model with images therefore
 *   loads only in a page, and a model without images loads anywhere.
 *
 * @category Constructors
 */
export const model = (
  url: string,
  options: ModelOptions = {}
): Assets.Asset<Model> =>
  Assets.make(url, (data, at) =>
    Effect.gen(function* () {
      // Fetched before anything is held: a loading that is given up gives
      // these requests up, which what is being acquired would not.
      const packed = yield* pack(data, at, yield* Assets.Loader);
      const manager = yield* Three.manager(options.files ?? []);
      const loader = new GLTFLoader(manager);
      options.prepare?.(loader, manager);
      const decoders = [loader.dracoLoader, loader.ktx2Loader].filter(
        (decoder) => decoder !== null
      );
      if (decoders.some((decoder) => decoder.manager !== manager)) {
        return yield* new Assets.AssetFailed({
          url: at,
          message:
            "A decoder set in `prepare` was not made with the manager `prepare` receives, so it would fetch its files around `Assets.Loader`.",
        });
      }
      return yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => loader.parseAsync(packed, ""),
          catch: (error) =>
            new Assets.AssetFailed({
              url: at,
              message: `It could not be made a model: ${describe(error)}`,
            }),
        }),
        (loaded) => Effect.sync(() => dispose(loaded))
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            for (const decoder of decoders) {
              decoder.dispose();
            }
          })
        )
      );
    })
  );

/**
 * Returns a model's mesh by name, or its first mesh when given no name. A mesh
 * has a geometry and a material, so it is a look that `Three.instancesFrom`
 * accepts.
 *
 *   look: ({ rock }) => Gltf.mesh(rock, "Boulder")
 *
 * **Details**
 *
 * The name is the name of the node the mesh is on, as an editor shows it, or
 * the mesh's own name when its node has none. It searches every scene of the
 * model. A mesh with several materials is several meshes under that name, and
 * `Gltf.mesh` returns the first.
 *
 * **Gotchas**
 *
 * - It throws when no mesh has the name, and the error lists the model's
 *   meshes. It also throws for a model with no mesh.
 *
 * @category Utilities
 */
export const mesh = (of: Model, name?: string): Mesh => {
  const found: Mesh[] = [];
  for (const scene of of.scenes) {
    scene.traverse((object: Object3D) => {
      if ((object as Partial<Mesh>).isMesh === true) {
        found.push(object as Mesh);
      }
    });
  }
  const wanted =
    name === undefined
      ? found[0]
      : found.find((one) => one.name === name || one.parent?.name === name);
  if (wanted === undefined) {
    throw new Error(
      name === undefined
        ? "Gltf.mesh was given a model with no mesh in it."
        : `Gltf.mesh found no mesh named "${name}" in the model. Its meshes are: ${found.map((one) => `"${one.name}"`).join(", ") || "none"}.`
    );
  }
  return wanted;
};
