/**
 * Models: a glTF file as an asset. This is the package's
 * `@arcadekit/three/Gltf` entry.
 *
 *   import * as Gltf from "@arcadekit/three/Gltf"
 *
 *   const Fleet = Assets.bundle("game/Fleet", {
 *     ship: Gltf.model("/ship.glb"),
 *   })
 *
 *   // An object each, made of the model while the bundle is loaded.
 *   const Ships = Three.objects("game/Ships", {
 *     of: Ship,
 *     from: Fleet,
 *     make: (entity, { ship }) => ship.scene.clone(),
 *   })
 *
 *   // Or a crowd, each an instance of one of its meshes.
 *   const Rocks = Three.instances("game/Rocks", {
 *     of: Rock,
 *     from: Fleet,
 *     look: ({ ship }) => Gltf.mesh(ship, "Hull"),
 *   })
 *
 * A model is loaded as any asset is: with its bundle, through
 * `Assets.Loader`, and let go with the scope it was loaded in, its
 * geometries, materials and textures disposed of. That goes for the files
 * a `.gltf` names beside itself, its buffers and its pictures, too: they
 * are fetched here, through the same loader, and handed to Three.js with
 * the model, which then fetches nothing for itself.
 *
 * It is a module of its own because it brings the glTF loader of Three.js
 * with it, which a game with no models need not carry.
 */
import * as Assets from "arcadekit/Assets";
import { Effect } from "effect";
import type { BufferGeometry, Material, Mesh, Object3D, Texture } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";

/**
 * A model that was loaded: what the glTF loader of Three.js gives. `scene`
 * is its default scene, `scenes` all of them, `animations` its clips.
 *
 * @category Models
 */
export type Model = GLTF;

/**
 * How a model is loaded.
 *
 * @category Options
 */
export interface ModelOptions {
  /**
   * Handed the loader before it reads the model, once per loading: to give
   * it what a compressed model needs, `setDRACOLoader`, `setKTX2Loader` or
   * `setMeshoptDecoder`, which are the game's to bring.
   */
  readonly prepare?: (loader: GLTFLoader) => void;
}

// --- a model's files, packed into one ------------------------------------------------

const MAGIC = 0x46_54_6c_67;
const JSON_CHUNK = 0x4e_4f_53_4a;
const BIN_CHUNK = 0x00_4e_49_42;

/** As much of a glTF document as is read and rewritten here. */
interface Document {
  buffers?: { uri?: string; byteLength: number }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number }[];
  images?: { uri?: string; mimeType?: string; bufferView?: number }[];
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message || error.name : String(error);

/** A model's document, and the binary chunk that came in the same file, if one did. */
const read = (
  data: Uint8Array
): { readonly document: Document; readonly binary: Uint8Array | undefined } => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.byteLength < 12 || view.getUint32(0, true) !== MAGIC) {
    return {
      document: JSON.parse(new TextDecoder().decode(data)) as Document,
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
      document = JSON.parse(new TextDecoder().decode(chunk)) as Document;
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

/** The bytes of a `data:` URI, and the type it says they are of. */
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

/** Where a file a model names is, given where the model is. */
const beside = (model: string, uri: string): string =>
  /^[a-z][a-z0-9+.-]*:/iu.test(uri) || uri.startsWith("/")
    ? uri
    : model.slice(0, model.lastIndexOf("/") + 1) + uri;

/** What kind of picture some bytes are, told from how they begin. */
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
 * A model and every file it names, as one binary glTF: its buffers joined
 * into one, its pictures put in that buffer too. What is in the file
 * already is taken from it; what is beside it is fetched through the
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
    /** The bytes a URI stands for: in the URI itself, or beside the model. */
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
 * An asset that is a model: a glTF file, `.glb` or `.gltf`, loaded with
 * its bundle and disposed of with the scope it was loaded in.
 *
 *   const Fleet = Assets.bundle("game/Fleet", {
 *     ship: Gltf.model("/ship.glb"),
 *     rock: Gltf.model("/rocks/rock.gltf"),   // with rock.bin and rock.png beside it
 *   })
 *
 * - The buffers and pictures a `.gltf` names are fetched through
 *   `Assets.Loader`, from beside the model, at once with each other: a
 *   test's files in memory serve them, one that is missing fails the
 *   bundle with its own URL, and a level that is left while its model is
 *   still on its way gives those requests up.
 * - A file that is no model fails the bundle with `Assets.AssetFailed`,
 *   which says what was wrong with it.
 * - What a compressed model needs is given to the loader in `prepare`.
 * - A model is one for the whole bundle: an object made of it shares its
 *   geometries and materials, so `model.scene.clone()` is cheap, there is
 *   nothing to free, and what changes one copy's material changes them
 *   all.
 * - Its pictures are decoded by the page, as `Three.texture`'s are, and
 *   closed when the model is let go: a model with pictures is for a page,
 *   and one without loads anywhere.
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
      return yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            new Promise<Model>((resolve, reject) => {
              const loader = new GLTFLoader();
              options.prepare?.(loader);
              loader.parse(packed, "", resolve, reject);
            }),
          catch: (error) =>
            new Assets.AssetFailed({
              url: at,
              message: `It could not be made a model: ${describe(error)}`,
            }),
        }),
        (loaded) => Effect.sync(() => dispose(loaded))
      );
    })
  );

/**
 * A mesh of a model, by its name, or the first there is: what
 * `Three.instances` takes as a look, since a mesh has a geometry and a
 * material.
 *
 *   look: ({ rock }) => Gltf.mesh(rock, "Boulder")
 *
 * The name is that of the node the mesh is on, as an editor shows it, or
 * the mesh's own where its node has none. A mesh of several materials is
 * several meshes under that name, and the first is given. Throws, naming
 * the meshes there are, when none has it.
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
