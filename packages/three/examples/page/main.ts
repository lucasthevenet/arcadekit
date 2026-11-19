/**
 * Ten thousand moving objects in a page: motes that drift and spin in a
 * box, each one instance of one mesh and of a colour of its own, and a ship
 * that is an object of its own, a glTF model, steered with the arrow keys. Through the middle of the box a ring
 * of cards turns in a plane: they are placed as a flat game places things,
 * with two numbers and an angle. A card's face is a picture, loaded as an
 * asset: C puts the deck away, which lets the picture go, and brings it
 * back, which loads it again.
 *
 * The simulation runs at sixty ticks a second and knows nothing of
 * Three.js. What draws it reads the columns once per repaint.
 *
 *   pnpm --filter @arcadekit/three page
 *
 * `?count=50000` draws that many.
 */
import {
  App,
  Assets,
  Commands,
  Component,
  Field,
  Frame,
  Input,
  Plugin,
  Query,
  Random,
  System,
  Time,
  Transform3d,
  Transform2d,
} from "arcadekit";
import * as Browser from "arcadekit/Browser";
import { Effect, Layer } from "effect";
import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  MeshStandardMaterial,
  PlaneGeometry,
} from "three";

// In a game of your own this is "@arcadekit/three".
import { Gltf, Three } from "../../src/index";

const { Position, Rotation, Scale } = Transform3d;

const COUNT =
  Number(new URLSearchParams(location.search).get("count")) || 10_000;

const BOX = 60;

// --- the simulation: no Three.js here ----------------------------------------------
const Mote = Component.tag("page/Mote");
const Card = Component.tag("page/Card");
const CARDS = 48;
const Ship = Component.tag("page/Ship");

const Velocity = Component.define("page/Velocity", {
  x: Field.f32,
  y: Field.f32,
  z: Field.f32,
});

/** How fast a mote spins about the vertical, in radians a second. */
const Spin = Component.define("page/Spin", {
  rate: Field.f32,
  angle: Field.f32,
});

/**
 * What colour a mote is: the game's to say, as where it is. A mote that
 * comes off a wall takes that wall's.
 */
const Tint = Component.define("page/Tint", {
  r: Field.f32,
  g: Field.f32,
  b: Field.f32,
});

const Drifting = Query.all(Position, Velocity, Tint);
const Spinning = Query.all(Rotation, Spin);

/** A hex code's three bytes, each over 255: what a `Tint` holds. */
const code = (hex: number) => ({
  r: (hex >> 16) / 255,
  g: ((hex >> 8) & 255) / 255,
  b: (hex & 255) / 255,
});

// The rules know a colour as three numbers and nothing else. What draws
// them converts each for the renderer.
const WALLS = [
  ["x", code(0x78_dc_e8)],
  ["y", code(0xff_d8_66)],
  ["z", code(0xff_61_88)],
] as const;

const Drift = System.make("Drift", function* () {
  const { delta } = yield* Time;
  (yield* Drifting).eachChunk((start, end, position, velocity, tint) => {
    for (const [axis, wall] of WALLS) {
      const at = position[axis];
      const speed = velocity[axis];

      for (let i = start; i < end; i += 1) {
        let next = at[i]! + speed[i]! * delta;

        // Off a wall of the box, and back, in the colour of that wall.
        if (next > BOX || next < -BOX) {
          speed[i] = -speed[i]!;
          next = at[i]!;
          tint.r[i] = wall.r;
          tint.g[i] = wall.g;
          tint.b[i] = wall.b;
        }

        at[i] = next;
      }
    }
  });
});

const Turn = System.make("Turn", function* () {
  const { delta } = yield* Time;
  (yield* Spinning).eachChunk((start, end, rotation, spin) => {
    for (let i = start; i < end; i += 1) {
      const angle = spin.angle[i]! + spin.rate[i]! * delta;
      spin.angle[i] = angle;
      // About the vertical: a quaternion written out, with nothing made.
      rotation.y[i] = Math.sin(angle / 2);
      rotation.w[i] = Math.cos(angle / 2);
    }
  });
});

// The cards go round the middle, each turning as it goes: a flat game's
// components, a position of two numbers and an angle.
const Carded = Query.all(Transform2d.Position, Transform2d.Rotation).pipe(
  Query.with(Card)
);

const Wheel = System.make("Wheel", function* () {
  const { delta } = yield* Time;
  const cos = Math.cos(delta * 0.3);
  const sin = Math.sin(delta * 0.3);
  (yield* Carded).eachChunk((start, end, position, rotation) => {
    for (let i = start; i < end; i += 1) {
      const x = position.x[i]!;
      const y = position.y[i]!;
      position.x[i] = x * cos - y * sin;
      position.y[i] = x * sin + y * cos;
      rotation.angle[i] = rotation.angle[i]! + delta * 1.5;
    }
  });
});

const Steer = System.make("Steer", function* () {
  const keys = yield* Input.Keyboard;
  const { delta } = yield* Time;

  const x =
    (keys.down("ArrowRight") ? 1 : 0) - (keys.down("ArrowLeft") ? 1 : 0);

  const y = (keys.down("ArrowUp") ? 1 : 0) - (keys.down("ArrowDown") ? 1 : 0);

  if (x === 0 && y === 0) {
    return;
  }

  (yield* Query.all(Position).pipe(Query.with(Ship))).each((position) => {
    position.x += x * 30 * delta;
    position.y += y * 30 * delta;
  });
});

const Rules = Plugin.make("page/Rules", {
  plugins: [Input.plugin, Transform3d.plugin, Transform2d.plugin],
  components: [Mote, Card, Ship, Velocity, Spin, Tint],
  systems: [Steer, Drift, Turn, Wheel],
  setup: Effect.gen(function* () {
    const commands = yield* Commands;
    const random = yield* Random;
    const within = () => (random.next() * 2 - 1) * BOX;
    const speed = () => (random.next() * 2 - 1) * 12;

    for (let i = 0; i < COUNT; i += 1) {
      const size = 0.3 + random.next() * 0.7;
      commands.spawn(
        Mote,
        Position.of({ x: within(), y: within(), z: within() }),
        Velocity.of({ x: speed(), y: speed(), z: speed() }),
        Rotation.of({ x: 0, y: 0, z: 0, w: 1 }),
        Spin.of({ rate: speed() / 4, angle: 0 }),
        Scale.of({ x: size, y: size, z: size }),
        Tint.of(code(0xcb_cb_cb))
      );
    }

    for (let i = 0; i < CARDS; i += 1) {
      const around = (i / CARDS) * Math.PI * 2;
      commands.spawn(
        Card,
        Transform2d.Position.of({
          x: Math.cos(around) * 40,
          y: Math.sin(around) * 40,
        }),
        Transform2d.Rotation.of({ angle: around }),
        Transform2d.Scale.of({ x: 1, y: 1.5 })
      );
    }

    commands.spawn(Ship, Position.of({ x: 0, y: 0, z: 0 }));
  }),
});

// --- how it looks: only the page has this --------------------------------------------
const Motes = Three.instances("page/Motes", {
  of: Mote,
  geometry: new BoxGeometry(1, 1, 1),
  // White, which each mote's own colour multiplies.
  material: new MeshStandardMaterial({ color: "#ffffff" }),
  color: Tint,
  capacity: COUNT,
  // Sixty ticks a second and as many frames as the screen shows: each mote
  // is drawn between its last two places, so that it moves evenly, and
  // between its last two colours.
  smooth: true,
});

// A card's face is a file. The cards are drawn while it is loaded, which
// is while the deck is out: that is the page's to say, and no part of the
// game, which moves its cards whether they are seen or not.
const Deck = Assets.bundle("page/Deck", {
  face: Three.texture("/card.png"),
});

let deckOut = true;

addEventListener("keydown", (event) => {
  if (event.key === "c") {
    deckOut = !deckOut;
  }
});

const KeepDeck = Assets.during(
  Effect.sync(() => deckOut),
  Deck
);

const Cards = Three.instances("page/Cards", {
  of: Card,
  from: Deck,
  look: ({ face }) => ({
    geometry: new PlaneGeometry(4, 4),
    material: new MeshStandardMaterial({ map: face, side: DoubleSide }),
  }),
  free: ({ geometry, material }) => {
    geometry.dispose();
    material.dispose();
  },
  smooth: true,
});

// The ship is a model: a .gltf with its buffer and its picture beside it,
// which are fetched with it, through the game's loader of assets. It is
// kept for as long as the page; every ship is a copy of its scene, and
// they share what it is made of.
const Fleet = Assets.bundle("page/Fleet", {
  ship: Gltf.model("/ship.gltf"),
});

const KeepFleet = Assets.during(Effect.succeed(true), Fleet);

const Ships = Three.objects("page/Ships", {
  of: Ship,
  from: Fleet,
  make: (_entity, { ship }) => ship.scene.clone(),
  smooth: true,
});

// The camera goes round the box, in real time: it is no part of the game.
let angle = 0;

const Orbit = System.make("Orbit", function* () {
  const { camera } = yield* Three.Scene;
  angle += (yield* Frame).delta * 0.1;
  camera.position.set(Math.sin(angle) * 170, 40, Math.cos(angle) * 170);
  camera.lookAt(0, 0, 0);
}).pipe(System.inStage("frame"));

const hud = document.querySelector("#hud") as HTMLElement;
let shown = 0;
let frames = 0;

const Hud = System.make("Hud", function* () {
  const { tick } = yield* Time;
  frames += 1;
  const now = performance.now();

  // Twice a second: text that changes every frame is work nobody can read.
  if (now - shown >= 500) {
    hud.textContent = `${COUNT} motes · tick ${tick} · ${Math.round((frames * 1000) / (now - shown))} frames a second`;
    shown = now;
    frames = 0;
  }
}).pipe(System.inStage("frame"));

const Look = Plugin.make("page/Look", {
  plugins: [Three.plugin, Assets.plugin, Rules],
  // The scene is set up once, when the app is made.
  layer: Layer.effectDiscard(
    Effect.map(Three.Scene, ({ scene }) => {
      scene.background = new Color("#10131a");
      const sun = new DirectionalLight("#ffffff", 2.5);
      sun.position.set(1, 2, 3);
      scene.add(new AmbientLight("#8090b0", 1.2), sun);
    })
  ),
  systems: [KeepDeck, KeepFleet, Motes, Cards, Ships, Orbit, Hud],
});

// --- the entry point -------------------------------------------------------------
const canvas = document.querySelector("#game") as HTMLCanvasElement;

Browser.runMain(
  App.run({ plugins: [Look], seed: 7 }, { hz: 60 }).pipe(
    Effect.provide(Three.layerWebGL({ canvas, antialias: true }))
  ),
  { preventDefault: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] }
);
