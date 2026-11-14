// Writes the demos' placeholder sounds: 16-bit mono PCM WAV files synthesized in code.
// Run with `pnpm sounds`. The output is byte-identical every run (noise comes from a seeded
// PRNG), so regenerating never shows up as a diff. Swap any file for a real CC0 sound of the
// same name; the apps only know file names.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const SURVIVOR_DIR = path.join(ROOT, "examples/survivor-demo/public/sounds");
const PUZZLE_DIR = path.join(ROOT, "examples/push-puzzle-demo/public/sounds");

const SFX_RATE = 22_050;
// Music is 16 s per loop; a lower rate keeps the three loops near 500 KB each.
const MUSIC_RATE = 16_000;
const TAU = 2 * Math.PI;

// Peak levels as linear gain: -3 dBFS for most effects, quieter for frequent or looping ones.
const dbfs = (db) => 10 ** (db / 20);
const SFX_PEAK = dbfs(-3);
const QUIET_PEAK = dbfs(-9);
const MUSIC_PEAK = dbfs(-8);

// ---------------------------------------------------------------------------------------------
// Building blocks

// Mulberry32: a small seeded PRNG, so noise is the same bytes every run.
const rng = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d_2b_79_f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

// Equal-tempered pitch from a MIDI note number (69 = A4 = 440 Hz).
const midi = (note) => 440 * 2 ** ((note - 69) / 12);

const buffer = (rate, seconds) => ({
  rate,
  data: new Float64Array(Math.round(rate * seconds)),
});

// Linear attack, exponential-ish decay to silence at `length`, with a short release so the
// tail always lands on zero.
const envelope = (t, length, attack, curve = 4) => {
  if (t < 0 || t >= length) {
    return 0;
  }
  const rise = attack > 0 ? Math.min(1, t / attack) : 1;
  const left = 1 - t / length;
  const fall = left ** curve;
  const release = Math.min(1, (length - t) / 0.004);
  return rise * fall * release;
};

const oscillators = {
  sine: (phase) => Math.sin(phase),
  triangle: (phase) => {
    const x = (phase / TAU) % 1;
    return 1 - 4 * Math.abs(x - 0.5);
  },
  square: (phase) => ((phase / TAU) % 1 < 0.5 ? 1 : -1),
  saw: (phase) => 2 * ((phase / TAU) % 1) - 1,
};

/**
 * Adds one tone into `buf`. `freq` may be a number or a function of time (for sweeps); phase is
 * integrated so sweeps stay smooth. With `wrap`, samples past the end land at the start, so a
 * note that rings over a loop's end continues into its beginning.
 */
const tone = (
  buf,
  {
    start = 0,
    length,
    freq,
    wave = "sine",
    gain = 1,
    attack = 0.005,
    curve = 4,
    vibrato = 0,
    vibratoRate = 5,
    wrap = false,
  }
) => {
  const { rate, data } = buf;
  const osc = oscillators[wave];
  const first = Math.round(start * rate);
  const count = Math.round(length * rate);
  let phase = 0;
  for (let i = 0; i < count; i++) {
    const t = i / rate;
    const base = typeof freq === "function" ? freq(t) : freq;
    const f = base * (1 + vibrato * Math.sin(TAU * vibratoRate * t));
    phase = (phase + (TAU * Math.max(0, f)) / rate) % TAU;
    let index = first + i;
    if (index >= data.length) {
      if (!wrap) {
        break;
      }
      index %= data.length;
    }
    data[index] += gain * envelope(t, length, attack, curve) * osc(phase);
  }
};

/** Adds filtered noise: a one-pole low-pass whose cutoff may sweep over time. */
const noise = (
  buf,
  {
    start = 0,
    length,
    seed,
    gain = 1,
    attack = 0.002,
    curve = 4,
    cutoff = 2000,
    highpass = false,
    wrap = false,
  }
) => {
  const { rate, data } = buf;
  const random = rng(seed);
  const first = Math.round(start * rate);
  const count = Math.round(length * rate);
  let low = 0;
  for (let i = 0; i < count; i++) {
    const t = i / rate;
    const fc = typeof cutoff === "function" ? cutoff(t) : cutoff;
    const k = 1 - Math.exp((-TAU * fc) / rate);
    const white = random() * 2 - 1;
    low += k * (white - low);
    const sample = highpass ? white - low : low;
    let index = first + i;
    if (index >= data.length) {
      if (!wrap) {
        break;
      }
      index %= data.length;
    }
    data[index] += gain * envelope(t, length, attack, curve) * sample;
  }
};

/** Scales the buffer so its loudest sample sits at `peak`. */
const normalize = (buf, peak) => {
  let max = 0;
  for (const sample of buf.data) {
    max = Math.max(max, Math.abs(sample));
  }
  if (max > 0) {
    const scale = peak / max;
    for (let i = 0; i < buf.data.length; i++) {
      buf.data[i] *= scale;
    }
  }
  return buf;
};

/** Short linear fades at both ends so a one-shot never starts or stops on a click. */
const fadeEdges = (buf, seconds = 0.003) => {
  const n = Math.min(Math.round(buf.rate * seconds), buf.data.length >> 1);
  const last = buf.data.length - 1;
  for (let i = 0; i < n; i++) {
    const g = i / n;
    buf.data[i] *= g;
    buf.data[last - i] *= g;
  }
  return buf;
};

const oneShot = (buf, peak = SFX_PEAK) => fadeEdges(normalize(buf, peak));

const encodeWav = ({ rate, data }) => {
  const bytes = Buffer.alloc(44 + data.length * 2);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + data.length * 2, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  // Format 1 (PCM), one channel.
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(data.length * 2, 40);
  for (let i = 0; i < data.length; i++) {
    const clamped = Math.max(-1, Math.min(1, data[i]));
    bytes.writeInt16LE(Math.round(clamped * 32_767), 44 + i * 2);
  }
  return bytes;
};

// ---------------------------------------------------------------------------------------------
// Survivors effects

const shotArc = () => {
  const buf = buffer(SFX_RATE, 0.14);
  tone(buf, {
    length: 0.14,
    freq: (t) => 1800 - 9000 * t,
    wave: "square",
    gain: 0.5,
    vibrato: 0.08,
    vibratoRate: 90,
    curve: 2,
  });
  noise(buf, {
    length: 0.06,
    seed: 11,
    gain: 0.35,
    cutoff: 7000,
    highpass: true,
  });
  return oneShot(buf, QUIET_PEAK);
};

const shotBubble = () => {
  const buf = buffer(SFX_RATE, 0.16);
  tone(buf, {
    length: 0.16,
    freq: (t) => 320 + 2400 * t,
    gain: 1,
    attack: 0.01,
    curve: 2,
  });
  tone(buf, {
    start: 0.03,
    length: 0.1,
    freq: (t) => 600 + 3000 * t,
    gain: 0.35,
    attack: 0.008,
  });
  return oneShot(buf, QUIET_PEAK);
};

const hit = () => {
  const buf = buffer(SFX_RATE, 0.06);
  tone(buf, {
    length: 0.06,
    freq: (t) => 220 - 1800 * t,
    wave: "triangle",
    gain: 1,
    attack: 0.001,
    curve: 3,
  });
  noise(buf, { length: 0.025, seed: 21, gain: 0.5, cutoff: 1800 });
  return oneShot(buf, dbfs(-12));
};

const kill = () => {
  const buf = buffer(SFX_RATE, 0.22);
  tone(buf, {
    length: 0.18,
    freq: (t) => 520 - 1800 * t,
    wave: "triangle",
    gain: 0.8,
    vibrato: 0.15,
    vibratoRate: 40,
    curve: 2,
  });
  noise(buf, {
    length: 0.22,
    seed: 31,
    gain: 0.6,
    cutoff: (t) => 3000 - 12_000 * t,
    curve: 3,
  });
  return oneShot(buf, dbfs(-6));
};

const pickup = () => {
  const buf = buffer(SFX_RATE, 0.18);
  tone(buf, { length: 0.08, freq: midi(84), wave: "square", gain: 0.4 });
  tone(buf, {
    start: 0.06,
    length: 0.12,
    freq: midi(91),
    wave: "square",
    gain: 0.4,
  });
  tone(buf, { start: 0.06, length: 0.12, freq: midi(91) * 2, gain: 0.3 });
  return oneShot(buf, dbfs(-8));
};

const hurt = () => {
  const buf = buffer(SFX_RATE, 0.3);
  tone(buf, {
    length: 0.3,
    freq: (t) => 140 - 150 * t,
    wave: "saw",
    gain: 0.7,
    vibrato: 0.2,
    vibratoRate: 30,
    curve: 2,
  });
  tone(buf, {
    length: 0.15,
    freq: (t) => 90 - 200 * t,
    gain: 1,
    attack: 0.002,
  });
  noise(buf, { length: 0.08, seed: 41, gain: 0.4, cutoff: 900 });
  return oneShot(buf);
};

const down = () => {
  const buf = buffer(SFX_RATE, 0.9);
  tone(buf, {
    length: 0.9,
    freq: (t) => 660 * 2 ** (-t * 2.4),
    wave: "triangle",
    gain: 0.8,
    vibrato: 0.03,
    vibratoRate: 7,
    attack: 0.01,
    curve: 1.5,
  });
  tone(buf, {
    length: 0.9,
    freq: (t) => 330 * 2 ** (-t * 2.4),
    wave: "square",
    gain: 0.2,
    curve: 1.5,
  });
  return oneShot(buf);
};

// Major arpeggio up the scale, each note ringing under the next.
const levelUp = () => {
  const buf = buffer(SFX_RATE, 0.75);
  const notes = [72, 76, 79, 84, 88];
  for (const [i, note] of notes.entries()) {
    const start = i * 0.07;
    tone(buf, {
      start,
      length: 0.75 - start,
      freq: midi(note),
      wave: "triangle",
      gain: 0.5,
      curve: 3,
    });
    tone(buf, {
      start,
      length: 0.3,
      freq: midi(note) * 2,
      gain: 0.15,
      curve: 3,
    });
  }
  return oneShot(buf);
};

// Short brass-ish fanfare: G C E, held G, then a final C chord.
const won = () => {
  const buf = buffer(SFX_RATE, 1.6);
  const phrase = [
    [0, 0.14, [67]],
    [0.15, 0.14, [72]],
    [0.3, 0.14, [76]],
    [0.45, 0.3, [79]],
    [0.78, 0.82, [72, 76, 79, 84]],
  ];
  for (const [start, length, notes] of phrase) {
    for (const note of notes) {
      tone(buf, {
        start,
        length,
        freq: midi(note),
        wave: "saw",
        gain: 0.25,
        attack: 0.02,
        curve: 1.2,
        vibrato: 0.004,
      });
      tone(buf, {
        start,
        length,
        freq: midi(note),
        wave: "square",
        gain: 0.12,
        attack: 0.02,
        curve: 1.2,
      });
    }
  }
  return oneShot(buf);
};

// Descending A minor phrase that lands low and slow.
const lost = () => {
  const buf = buffer(SFX_RATE, 1.8);
  const phrase = [
    [0, 0.35, 69],
    [0.3, 0.35, 67],
    [0.6, 0.35, 64],
    [0.9, 0.9, 57],
  ];
  for (const [start, length, note] of phrase) {
    tone(buf, {
      start,
      length,
      freq: midi(note),
      wave: "triangle",
      gain: 0.6,
      attack: 0.02,
      curve: 1.5,
      vibrato: 0.006,
    });
    tone(buf, {
      start,
      length,
      freq: midi(note - 12),
      gain: 0.4,
      attack: 0.02,
      curve: 1.5,
    });
  }
  return oneShot(buf);
};

// Seamless 2 s loop. Every partial and the tremolo complete a whole number of cycles in 2 s
// (frequencies are multiples of 0.5 Hz) and start at phase 0, so the end meets the start.
const auraHum = () => {
  const seconds = 2;
  const buf = buffer(SFX_RATE, seconds);
  const partials = [
    [110, 1],
    [165, 0.35],
    [220, 0.3],
    [330.5, 0.08],
  ];
  for (let i = 0; i < buf.data.length; i++) {
    const t = i / buf.rate;
    const tremolo = 0.8 + 0.2 * Math.sin(TAU * 1 * t);
    let sample = 0;
    for (const [freq, gain] of partials) {
      sample += gain * Math.sin(TAU * freq * t);
    }
    buf.data[i] = tremolo * sample;
  }
  return normalize(buf, dbfs(-14));
};

const click = () => {
  const buf = buffer(SFX_RATE, 0.035);
  tone(buf, {
    length: 0.035,
    freq: 1800,
    wave: "triangle",
    gain: 0.6,
    attack: 0.0005,
    curve: 6,
  });
  noise(buf, {
    length: 0.012,
    seed: 51,
    gain: 0.5,
    cutoff: 5000,
    highpass: true,
  });
  return oneShot(buf, dbfs(-10));
};

// ---------------------------------------------------------------------------------------------
// Music. Each loop lasts a whole number of bars; notes that ring over the end wrap to the start,
// so the loop point is seamless.

const LOOP_SECONDS = 16;

/** A triad as MIDI notes. */
const chord = (root, minor) => [root, root + (minor ? 3 : 4), root + 7];

const musicMenu = () => {
  // 90 BPM: 24 beats = 16 s, six bars of 4/4.
  const beat = 60 / 90;
  const buf = buffer(MUSIC_RATE, LOOP_SECONDS);
  const bars = [
    chord(57, true),
    chord(53, false),
    chord(48, false),
    chord(55, false),
    chord(57, true),
    chord(52, true),
  ];
  for (const [bar, notes] of bars.entries()) {
    const start = bar * 4 * beat;
    for (const note of notes) {
      tone(buf, {
        start,
        length: 4 * beat + 0.6,
        freq: midi(note),
        wave: "triangle",
        gain: 0.18,
        attack: 0.6,
        curve: 0.8,
        vibrato: 0.003,
        wrap: true,
      });
    }
    tone(buf, {
      start,
      length: 4 * beat,
      freq: midi(notes[0] - 12),
      gain: 0.35,
      attack: 0.05,
      curve: 1.5,
      wrap: true,
    });
    // A slow arpeggio on top: root, fifth, third, octave.
    const arpeggio = [
      notes[0] + 12,
      notes[2] + 12,
      notes[1] + 12,
      notes[0] + 24,
    ];
    for (const [i, note] of arpeggio.entries()) {
      tone(buf, {
        start: start + i * beat,
        length: beat * 1.5,
        freq: midi(note),
        gain: 0.14,
        attack: 0.01,
        curve: 3,
        wrap: true,
      });
    }
  }
  return normalize(buf, MUSIC_PEAK);
};

const musicRun = () => {
  // 120 BPM: 32 beats = 16 s, eight bars of 4/4.
  const beat = 0.5;
  const buf = buffer(MUSIC_RATE, LOOP_SECONDS);
  const roots = [45, 45, 41, 43, 45, 45, 48, 43];
  for (const [bar, root] of roots.entries()) {
    const barStart = bar * 4 * beat;
    // Driving eighth-note bass with an octave jump on the off-beats.
    for (let step = 0; step < 8; step++) {
      const note = step % 2 === 0 ? root - 12 : root;
      tone(buf, {
        start: barStart + step * (beat / 2),
        length: beat / 2,
        freq: midi(note),
        wave: "saw",
        gain: 0.22,
        attack: 0.003,
        curve: 2,
      });
    }
    // Kick on every beat, snare-ish noise on 2 and 4, closed hats on eighths.
    for (let b = 0; b < 4; b++) {
      const start = barStart + b * beat;
      tone(buf, {
        start,
        length: 0.18,
        freq: (t) => 120 - 500 * t,
        gain: 0.7,
        attack: 0.001,
        curve: 3,
      });
      if (b % 2 === 1) {
        noise(buf, {
          start,
          length: 0.15,
          seed: 600 + bar * 4 + b,
          gain: 0.3,
          cutoff: 3500,
          curve: 3,
        });
      }
    }
    for (let step = 0; step < 8; step++) {
      noise(buf, {
        start: barStart + step * (beat / 2),
        length: 0.04,
        seed: 700 + bar * 8 + step,
        gain: step % 2 === 0 ? 0.08 : 0.12,
        cutoff: 6000,
        highpass: true,
        curve: 4,
      });
    }
    // A minor-pentatonic riff, one bar long, with a variation in the second half.
    const riff =
      bar < 4 ? [0, 3, 7, 10, 12, 10, 7, 3] : [12, 10, 7, 5, 3, 5, 7, 10];
    for (const [step, offset] of riff.entries()) {
      tone(buf, {
        start: barStart + step * (beat / 2),
        length: beat / 2 + 0.05,
        freq: midi(root + 24 + offset),
        wave: "square",
        gain: 0.07,
        attack: 0.004,
        curve: 2,
        wrap: true,
      });
    }
  }
  return normalize(buf, MUSIC_PEAK);
};

// ---------------------------------------------------------------------------------------------
// Push-puzzle effects

const move = () => {
  const buf = buffer(SFX_RATE, 0.08);
  tone(buf, {
    length: 0.08,
    freq: (t) => 260 - 800 * t,
    wave: "triangle",
    gain: 0.8,
    attack: 0.002,
    curve: 3,
  });
  noise(buf, { length: 0.04, seed: 81, gain: 0.3, cutoff: 1200 });
  return oneShot(buf, dbfs(-12));
};

const push = () => {
  const buf = buffer(SFX_RATE, 0.22);
  noise(buf, {
    length: 0.2,
    seed: 91,
    gain: 0.6,
    cutoff: (t) => 900 + 2000 * t,
    attack: 0.01,
    curve: 1.5,
  });
  tone(buf, {
    length: 0.12,
    freq: (t) => 150 - 300 * t,
    wave: "triangle",
    gain: 0.8,
    attack: 0.002,
    curve: 3,
  });
  tone(buf, {
    length: 0.2,
    freq: 95,
    wave: "square",
    gain: 0.1,
    vibrato: 0.2,
    vibratoRate: 35,
  });
  return oneShot(buf, dbfs(-6));
};

const hole = () => {
  const buf = buffer(SFX_RATE, 0.6);
  tone(buf, {
    length: 0.35,
    freq: (t) => 700 * 2 ** (-t * 8),
    wave: "triangle",
    gain: 0.5,
    attack: 0.005,
    curve: 1,
  });
  tone(buf, {
    start: 0.32,
    length: 0.28,
    freq: (t) => 90 - 120 * t,
    gain: 1,
    attack: 0.002,
    curve: 3,
  });
  noise(buf, {
    start: 0.32,
    length: 0.2,
    seed: 101,
    gain: 0.5,
    cutoff: 700,
    curve: 3,
  });
  return oneShot(buf);
};

const undo = () => {
  const buf = buffer(SFX_RATE, 0.16);
  tone(buf, {
    length: 0.16,
    freq: (t) => 1400 * 2 ** (-t * 10),
    gain: 0.7,
    attack: 0.01,
    curve: 1.5,
  });
  noise(buf, {
    length: 0.14,
    seed: 111,
    gain: 0.25,
    cutoff: (t) => 6000 - 30_000 * t,
    attack: 0.04,
    curve: 2,
  });
  return oneShot(buf, dbfs(-8));
};

// Bell-like chime: C E G C, with an inharmonic overtone for the shimmer.
const solved = () => {
  const buf = buffer(SFX_RATE, 1.4);
  const notes = [72, 76, 79, 84];
  for (const [i, note] of notes.entries()) {
    const start = i * 0.12;
    const freq = midi(note);
    tone(buf, { start, length: 1.4 - start, freq, gain: 0.5, curve: 3 });
    tone(buf, {
      start,
      length: 0.6,
      freq: freq * 2.76,
      gain: 0.12,
      curve: 4,
    });
    tone(buf, {
      start,
      length: 0.9,
      freq: freq * 2,
      gain: 0.18,
      curve: 3,
    });
  }
  return oneShot(buf);
};

const musicPuzzle = () => {
  // 90 BPM: 24 beats = 16 s, six bars; a music-box melody over soft pads in F major.
  const beat = 60 / 90;
  const buf = buffer(MUSIC_RATE, LOOP_SECONDS);
  const bars = [
    chord(53, false),
    chord(50, true),
    chord(46, false),
    chord(48, false),
    chord(53, false),
    chord(48, false),
  ];
  const melody = [
    [77, 81, 84, 81],
    [74, 77, 81, 77],
    [70, 74, 77, 82],
    [72, 76, 79, 76],
    [81, 79, 77, 72],
    [76, 79, 72, 0],
  ];
  for (const [bar, notes] of bars.entries()) {
    const start = bar * 4 * beat;
    for (const note of notes) {
      tone(buf, {
        start,
        length: 4 * beat + 0.8,
        freq: midi(note),
        gain: 0.16,
        attack: 0.8,
        curve: 0.8,
        wrap: true,
      });
    }
    for (const [i, note] of melody[bar].entries()) {
      if (note === 0) {
        continue;
      }
      tone(buf, {
        start: start + i * beat,
        length: beat * 2,
        freq: midi(note),
        gain: 0.16,
        attack: 0.003,
        curve: 4,
        wrap: true,
      });
      tone(buf, {
        start: start + i * beat,
        length: beat,
        freq: midi(note) * 3,
        gain: 0.03,
        attack: 0.003,
        curve: 5,
        wrap: true,
      });
    }
  }
  return normalize(buf, MUSIC_PEAK);
};

// ---------------------------------------------------------------------------------------------

const SOUNDS = [
  [SURVIVOR_DIR, "shot-arc", shotArc],
  [SURVIVOR_DIR, "shot-bubble", shotBubble],
  [SURVIVOR_DIR, "hit", hit],
  [SURVIVOR_DIR, "kill", kill],
  [SURVIVOR_DIR, "pickup", pickup],
  [SURVIVOR_DIR, "hurt", hurt],
  [SURVIVOR_DIR, "down", down],
  [SURVIVOR_DIR, "level-up", levelUp],
  [SURVIVOR_DIR, "won", won],
  [SURVIVOR_DIR, "lost", lost],
  [SURVIVOR_DIR, "aura-hum", auraHum],
  [SURVIVOR_DIR, "click", click],
  [SURVIVOR_DIR, "music-menu", musicMenu],
  [SURVIVOR_DIR, "music-run", musicRun],
  [PUZZLE_DIR, "move", move],
  [PUZZLE_DIR, "push", push],
  [PUZZLE_DIR, "hole", hole],
  [PUZZLE_DIR, "undo", undo],
  [PUZZLE_DIR, "solved", solved],
  [PUZZLE_DIR, "click", click],
  [PUZZLE_DIR, "music", musicPuzzle],
];

let total = 0;
for (const [dir, id, make] of SOUNDS) {
  mkdirSync(dir, { recursive: true });
  const bytes = encodeWav(make());
  writeFileSync(path.join(dir, `${id}.wav`), bytes);
  total += bytes.length;
}
console.log(
  `Wrote ${SOUNDS.length} sounds (${(total / 1024).toFixed(0)} KB) to examples/*/public/sounds.`
);
