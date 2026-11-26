// In a game of your own this is "@arcadekit/three".
import { Gltf, Three } from "@arcadekit/three";
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
 *   pnpm --filter @arcadekit/example-three start
 *
 * `?count=50000` draws that many.
 */
import {
  App,
  Assets,
  Color,
  Commands,
  Component,
  Driver,
  Field,
  Frame,
  Input,
  Plugin,
  Query,
  Random,
  System,
  Time,
  Transform2d,
  Transform3d,
} from "arcadekit";
import * as Browser from "arcadekit/browser/Browser";
import { Effect, Layer } from "effect";
import {
  AmbientLight,
  BoxGeometry,
  DirectionalLight,
  DoubleSide,
  MeshStandardMaterial,
  PlaneGeometry,
  Color as ThreeColor,
} from "three";

const { Position, Rotation, Scale } = Transform3d;
const COUNT =
  Number(new URLSearchParams(location.search).get("count")) || 10_000;
const BOX = 60;

// --- the simulation: no Three.js here ----------------------------------------------
const Mote = Component.tag("page/Mote", { requires: [Position] });
const Card = Component.tag("page/Card", {
  requires: [Transform2d.Position],
});
const CARDS = 48;
const Ship = Component.tag("page/Ship", { requires: [Position] });
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

// A mote's colour is the game's to say, as where it is: one that comes off
// a wall takes that wall's.
const Drifting = Query.all(Position, Velocity, Color.Rgb).pipe(
  Query.writes(Position, Velocity, Color.Rgb)
);
const Spinning = Query.all(Rotation, Spin).pipe(Query.writes(Rotation, Spin));

// The rules know a colour as three numbers and nothing else. What draws
// them converts each for the renderer.
const WALLS = [
  ["x", Color.hex(0x78_dc_e8)],
  ["y", Color.hex(0xff_d8_66)],
  ["z", Color.hex(0xff_61_88)],
] as const;

const Drift = System.tick("Drift", function* () {
  const { delta } = yield* Time;
  (yield* Drifting).eachChunk((start, end, position, velocity, tint) => {
    for (const [axis, wall] of WALLS) {
      const at = position[axis];
      const speed = velocity[axis];
      for (let i = start; i < end; i++) {
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

const Turn = System.tick("Turn", function* () {
  const { delta } = yield* Time;
  (yield* Spinning).eachChunk((start, end, rotation, spin) => {
    for (let i = start; i < end; i++) {
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
  Query.writes(Transform2d.Position, Transform2d.Rotation),
  Query.with(Card)
);
const Wheel = System.tick("Wheel", function* () {
  const { delta } = yield* Time;
  const cos = Math.cos(delta * 0.3);
  const sin = Math.sin(delta * 0.3);
  (yield* Carded).eachChunk((start, end, position, rotation) => {
    for (let i = start; i < end; i++) {
      const x = position.x[i]!;
      const y = position.y[i]!;
      position.x[i] = x * cos - y * sin;
      position.y[i] = x * sin + y * cos;
      rotation.angle[i] = rotation.angle[i]! + delta * 1.5;
    }
  });
});

// Where the player steers the ship, with the arrows or a gamepad's stick.
const Fly = Input.stick("page/Fly", {
  left: ["ArrowLeft"],
  right: ["ArrowRight"],
  up: ["ArrowUp"],
  down: ["ArrowDown"],
  pad: Input.padStick(0, "left"),
});

/** The one ship the player flies. */
const Piloted = Query.all(Position).pipe(
  Query.with(Ship),
  Query.writes(Position)
);

const Steer = System.tick("Steer", function* () {
  const { delta } = yield* Time;
  const { x, y } = yield* Fly;
  if (x === 0 && y === 0) {
    return;
  }
  const [position] = (yield* Piloted).single();
  position.x += x * 30 * delta;
  position.y += y * 30 * delta;
});

const Rules = Plugin.make("page/Rules", {
  plugins: [Input.controls("page/Controls", [Fly])],
  systems: [Steer, Drift, Turn, Wheel],
  setup: Effect.gen(function* () {
    const commands = yield* Commands.spawns(
      Mote,
      Position,
      Velocity,
      Rotation,
      Spin,
      Scale,
      Color.Rgb,
      Card,
      Transform2d.Position,
      Transform2d.Rotation,
      Transform2d.Scale,
      Ship
    );
    const random = yield* Random;
    const within = () => (random.next() * 2 - 1) * BOX;
    const speed = () => (random.next() * 2 - 1) * 12;
    for (let i = 0; i < COUNT; i++) {
      const size = 0.3 + random.next() * 0.7;
      commands.spawn(
        Mote,
        Position.of({ x: within(), y: within(), z: within() }),
        Velocity.of({ x: speed(), y: speed(), z: speed() }),
        Rotation.of({ x: 0, y: 0, z: 0, w: 1 }),
        Spin.of({ rate: speed() / 4, angle: 0 }),
        Scale.of({ x: size, y: size, z: size }),
        Color.Rgb.of(Color.hex(0xcb_cb_cb))
      );
    }
    for (let i = 0; i < CARDS; i++) {
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
  transform: Transform3d,
  geometry: new BoxGeometry(1, 1, 1),
  // White, which each mote's own colour multiplies.
  material: new MeshStandardMaterial({ color: "#ffffff" }),
  color: Color.Rgb,
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
// Whether the deck is out is the page's, kept apart for each app: C, read
// in the input stage, puts it away and brings it back.
const DeckOut = System.local(() => ({ out: true }));
const PutAway = System.input("page/PutAway", function* () {
  if ((yield* Input.Devices).pressed.includes("KeyC")) {
    const deck = yield* DeckOut;
    deck.out = !deck.out;
  }
});
const KeepDeck = Assets.during(Deck).pipe(
  System.runIf(Effect.map(DeckOut, ({ out }) => out))
);

const Cards = Three.instancesFrom("page/Cards", {
  of: Card,
  transform: Transform2d,
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
const KeepFleet = Assets.during(Fleet);
const Ships = Three.objectsFrom("page/Ships", {
  of: Ship,
  transform: Transform3d,
  from: Fleet,
  make: (_entity, { ship }) => ship.scene.clone(),
  smooth: true,
});

// The camera goes round the box, in real time: it is no part of the game.
const Going = System.local(() => ({ angle: 0 }));
const Orbit = System.frame("Orbit", function* () {
  const { camera } = yield* Three.Scene;
  const going = yield* Going;
  going.angle += (yield* Frame).delta * 0.1;
  const { angle } = going;
  camera.position.set(Math.sin(angle) * 170, 40, Math.cos(angle) * 170);
  camera.lookAt(0, 0, 0);
});

const hud = document.querySelector("#hud") as HTMLElement;
// When the text was last shown, and the frames drawn since.
const Counted = System.local(() => ({ shown: 0, frames: 0 }));
const Hud = System.frame("Hud", function* () {
  const { tick } = yield* Time;
  const counted = yield* Counted;
  counted.frames++;
  const now = performance.now();
  // Twice a second: text that changes every frame is work nobody can read.
  if (now - counted.shown >= 500) {
    hud.textContent = `${COUNT} motes · tick ${tick} · ${Math.round((counted.frames * 1000) / (now - counted.shown))} frames a second`;
    counted.shown = now;
    counted.frames = 0;
  }
});

const Look = Plugin.make("page/Look", {
  plugins: [Three.plugin, Assets.plugin, Rules],
  // The scene is set up once, when the app is made.
  layer: Layer.effectDiscard(
    Effect.map(Three.Scene, ({ scene }) => {
      scene.background = new ThreeColor("#10131a");
      const sun = new DirectionalLight("#ffffff", 2.5);
      sun.position.set(1, 2, 3);
      scene.add(new AmbientLight("#8090b0", 1.2), sun);
    })
  ),
  systems: [PutAway, KeepDeck, KeepFleet, Motes, Cards, Ships, Orbit, Hud],
});

// --- the entry point -------------------------------------------------------------
const canvas = document.querySelector("#game") as HTMLCanvasElement;
Browser.runMain(
  Driver.run(App.define({ plugins: [Look] }), { seed: 7, hz: 60 }).pipe(
    Effect.provide(Three.layerWebGL({ canvas, antialias: true }))
  ),
  { preventDefault: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] }
);
