import { describe, expect, it } from "vitest";

import { createMemoryNetwork } from "./memory-network";

const collect = (
  network: ReturnType<typeof createMemoryNetwork>,
  id: string
) => {
  const received: string[] = [];
  network.connect(id).listen((_from, message) => received.push(message));
  return received;
};

const sendThousandLossy = () => {
  const network = createMemoryNetwork({ seed: 7, loss: 0.25 });
  const a = network.connect("a");
  const received = collect(network, "b");
  for (let i = 0; i < 1000; i++) {
    a.send("b", String(i));
  }
  network.advance(0);
  return received;
};

describe(createMemoryNetwork, () => {
  it("delivers a message after its latency, not before", () => {
    const network = createMemoryNetwork({ seed: 1, latencyMs: 50 });
    const a = network.connect("a");
    const received = collect(network, "b");
    a.send("b", "hello");
    network.advance(49);
    expect(received).toStrictEqual([]);
    network.advance(50);
    expect(received).toStrictEqual(["hello"]);
  });

  it("loses about the share of messages it is told to, the same ones for the same seed", () => {
    const first = sendThousandLossy();
    expect(first.length).toBeGreaterThan(700);
    expect(first.length).toBeLessThan(800);
    expect(sendThousandLossy()).toStrictEqual(first);
  });

  it("reorders messages with jitter", () => {
    const network = createMemoryNetwork({
      seed: 3,
      latencyMs: 10,
      jitterMs: 40,
    });
    const a = network.connect("a");
    const received = collect(network, "b");
    for (let i = 0; i < 50; i++) {
      a.send("b", String(i));
    }
    network.advance(100);
    expect(received).toHaveLength(50);
    expect(received).not.toStrictEqual(
      received.toSorted((x, y) => Number(x) - Number(y))
    );
  });

  it("loses everything to and from a cut-off peer, including messages in flight", () => {
    const network = createMemoryNetwork({ seed: 1, latencyMs: 10 });
    const a = network.connect("a");
    const toB = collect(network, "b");
    const c = network.connect("c");
    const toD = collect(network, "d");
    a.send("b", "in flight");
    network.cutOff("b", true);
    a.send("b", "while cut");
    network.advance(20);
    expect(toB).toStrictEqual([]);
    network.cutOff("b", false);
    a.send("b", "after");
    c.send("d", "others unaffected");
    network.advance(40);
    expect(toB).toStrictEqual(["after"]);
    expect(toD).toStrictEqual(["others unaffected"]);
  });
});
