import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeBrowserAudio } from "./browser";

// No DOM here: Node's EventTarget stands in for the document, and small fakes stand in for
// Web Audio. A fake AudioParam keeps `value` as the browser does before audio renders: set
// only by the `value` setter, never by scheduled events.

const fakeGainNode = () => {
  const events: string[] = [];
  return {
    gain: {
      value: 1,
      events,
      cancelScheduledValues: () => events.push("cancel"),
      setValueAtTime: (value: number) => events.push(`set ${value}`),
      linearRampToValueAtTime: (value: number) => events.push(`ramp ${value}`),
    },
    connect: () => {},
    disconnect: () => {},
  };
};

let contexts: FakeContext[] = [];

class FakeContext {
  state: "suspended" | "running" | "closed" = "suspended";
  currentTime = 0;
  readonly destination = {};
  readonly gains: ReturnType<typeof fakeGainNode>[] = [];
  /** Whether resume() may start audio: the browser refuses outside an activating gesture. */
  allowed = false;
  constructor() {
    contexts.push(this);
  }
  createGain() {
    const node = fakeGainNode();
    this.gains.push(node);
    return node;
  }
  readonly sources: unknown[] = [];
  createBufferSource() {
    const source = {
      playbackRate: { value: 1 },
      loop: false,
      buffer: null,
      connect() {},
      start() {},
      stop() {},
    };
    this.sources.push(source);
    return source;
  }
  resume() {
    if (this.allowed) {
      this.state = "running";
    }
    return Promise.resolve();
  }
  suspend() {
    this.state = "suspended";
    return Promise.resolve();
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
}

/** Stands in for OfflineAudioContext, which the backend only decodes with. */
const FakeOfflineContext = function FakeOfflineContext() {
  return { decodeAudioData: () => Promise.resolve({ duration: 2 }) };
};

let document: EventTarget & { hidden: boolean };
let activation: { isActive: boolean };

const gesture = (type: string, active: boolean) => {
  activation.isActive = active;
  document.dispatchEvent(new Event(type));
};

/** Lets pending promises (a resume) settle. */
const settle = () => Effect.runPromise(Effect.sleep("1 millis"));

describe(makeBrowserAudio, () => {
  beforeEach(() => {
    contexts = [];
    document = Object.assign(new EventTarget(), { hidden: false });
    activation = { isActive: false };
    vi.stubGlobal("document", document);
    vi.stubGlobal("navigator", { userActivation: activation });
    vi.stubGlobal("AudioContext", FakeContext);
    vi.stubGlobal("OfflineAudioContext", FakeOfflineContext);
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(new ArrayBuffer(8), { status: 200 }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("waits for a gesture that lets audio start, and listens until audio runs", async () => {
    const { dispose } = makeBrowserAudio();

    // A touch's pointerdown gives no activation: nothing is made.
    gesture("pointerdown", false);
    const beforeActivation = contexts.length;
    // An activating gesture the browser still refuses (the context stays suspended)...
    gesture("touchend", true);
    await settle();
    const context = contexts[0]!;
    // ...so the next one tries again, and that one starts audio.
    context.allowed = true;
    gesture("touchend", true);
    await settle();
    const resume = vi.spyOn(context, "resume");
    gesture("keydown", true);
    const { state } = context;
    dispose();

    expect({
      beforeActivation,
      made: contexts.length,
      state,
      resumesAfterRunning: resume.mock.calls.length,
    }).toStrictEqual({
      beforeActivation: 0,
      made: 1,
      state: "running",
      resumesAfterRunning: 0,
    });
  });

  it("fades a loop in from silence", async () => {
    const { audio, dispose } = makeBrowserAudio();
    await Effect.runPromise(audio.load({ hum: { file: "hum.wav" } }));
    activation.isActive = true;
    gesture("keydown", true);
    const context = contexts[0]!;
    const before = context.gains.length;

    audio.setLoop("hum", 0.5);
    const voiceGain = context.gains[before]!.gain;
    dispose();

    expect(voiceGain.events).toStrictEqual([
      "cancel",
      "cancel",
      "set 0",
      "ramp 0.5",
    ]);
  });
});
