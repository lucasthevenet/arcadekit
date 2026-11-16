/**
 * Ten thousand moving objects in a page: motes that drift and spin in a
 * box, each one instance of one mesh, and a ship that is an object of its
 * own, steered with the arrow keys. Through the middle of the box a ring
 * of cards turns in a plane: they are placed as a flat game places things,
 * with two numbers and an angle.
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
  Transform,
  Transform2d,
} from "arcadekit";
import * as Browser from "arcadekit/Browser";
import { Effect, Layer } from "effect";
import {
  AmbientLight,
  BoxGeometry,
  Color,
  ConeGeometry,
  DirectionalLight,
  DoubleSide,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
} from "three";

// In a game of your own this is "@arcadekit/three".
import { Three } from "../../src/index";

const { Position, Rotation, Scale } = Transform;
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

const Drifting = Query.all(Position, Velocity);
const Spinning = Query.all(Rotation, Spin);

const Drift = System.make("Drift", function* () {
  const { delta } = yield* Time;
  (yield* Drifting).eachChunk((start, end, position, velocity) => {
    for (const axis of ["x", "y", "z"] as const) {
      const at = position[axis];
      const speed = velocity[axis];
      for (let i = start; i < end; i++) {
        let next = at[i]! + speed[i]! * delta;
        // Off a wall of the box, and back.
        if (next > BOX || next < -BOX) {
          speed[i] = -speed[i]!;
          next = at[i]!;
        }
        at[i] = next;
      }
    }
  });
});

const Turn = System.make("Turn", function* () {
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
  Query.with(Card)
);
const Wheel = System.make("Wheel", function* () {
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
  plugins: [Input.plugin, Transform.plugin, Transform2d.plugin],
  components: [Mote, Card, Ship, Velocity, Spin],
  systems: [Steer, Drift, Turn, Wheel],
  setup: Effect.gen(function* () {
    const commands = yield* Commands;
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
        Scale.of({ x: size, y: size, z: size })
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
  geometry: new BoxGeometry(1, 1, 1),
  material: new MeshStandardMaterial({ color: "#78dce8" }),
  capacity: COUNT,
});

const Cards = Three.instances("page/Cards", {
  of: Card,
  geometry: new PlaneGeometry(4, 4),
  material: new MeshStandardMaterial({ color: "#ff6188", side: DoubleSide }),
});

const Ships = Three.objects("page/Ships", {
  of: Ship,
  make: () =>
    new Mesh(
      new ConeGeometry(2, 6, 12),
      new MeshStandardMaterial({ color: "#ffd866" })
    ),
  free: (ship) => {
    ship.geometry.dispose();
    ship.material.dispose();
  },
});

// The camera goes round the box, in real time: it is no part of the game.
let angle = 0;
const Orbit = System.make("Orbit", function* () {
  const { camera } = yield* Three.Scene;
  angle += (yield* Frame).delta * 0.1;
  camera.position.set(Math.sin(angle) * 170, 40, Math.cos(angle) * 170);
  camera.lookAt(0, 0, 0);
}).pipe(System.inStage("frame"), System.before(Three.Render));

const hud = document.querySelector("#hud") as HTMLElement;
let shown = 0;
let frames = 0;
const Hud = System.make("Hud", function* () {
  const { tick } = yield* Time;
  frames++;
  const now = performance.now();
  // Twice a second: text that changes every frame is work nobody can read.
  if (now - shown >= 500) {
    hud.textContent = `${COUNT} motes · tick ${tick} · ${Math.round((frames * 1000) / (now - shown))} frames a second`;
    shown = now;
    frames = 0;
  }
}).pipe(System.inStage("frame"));

const Look = Plugin.make("page/Look", {
  plugins: [Three.plugin, Rules],
  // The scene is set up once, when the app is made.
  layer: Layer.effectDiscard(
    Effect.map(Three.Scene, ({ scene }) => {
      scene.background = new Color("#10131a");
      const sun = new DirectionalLight("#ffffff", 2.5);
      sun.position.set(1, 2, 3);
      scene.add(new AmbientLight("#8090b0", 1.2), sun);
    })
  ),
  systems: [Motes, Cards, Ships, Orbit, Hud],
});

// --- the entry point -------------------------------------------------------------
const canvas = document.querySelector("#game") as HTMLCanvasElement;
Browser.runMain(
  App.run({ plugins: [Look], seed: 7 }, { hz: 60 }).pipe(
    Effect.provide(Three.layerWebGL({ canvas, antialias: true }))
  ),
  { preventDefault: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] }
);
