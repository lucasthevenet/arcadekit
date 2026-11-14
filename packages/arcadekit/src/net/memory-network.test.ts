import { describe, expect, it } from "vitest";

import { MemoryNetwork } from "./index";

const collect = (network: MemoryNetwork.MemoryNetwork, id: string) => {
  const received: string[] = [];
  MemoryNetwork.connect(network, id).listen((_from, message) =>
    received.push(message)
  );
  return received;
};

const sendThousandLossy = () => {
  const network = MemoryNetwork.make({ seed: 7, loss: 0.25 });
  const a = MemoryNetwork.connect(network, "a");
  const received = collect(network, "b");
  for (let i = 0; i < 1000; i++) {
    a.send("b", String(i));
  }
  MemoryNetwork.advance(network, 0);
  return received;
};

describe(MemoryNetwork.make, () => {
  it("delivers a message after its latency, not before", () => {
    const network = MemoryNetwork.make({ seed: 1, latencyMs: 50 });
    const a = MemoryNetwork.connect(network, "a");
    const received = collect(network, "b");
    a.send("b", "hello");
    MemoryNetwork.advance(network, 49);
    expect(received).toStrictEqual([]);
    MemoryNetwork.advance(network, 50);
    expect(received).toStrictEqual(["hello"]);
  });

  it("loses about the share of messages it is told to, the same ones for the same seed", () => {
    const first = sendThousandLossy();
    expect(first.length).toBeGreaterThan(700);
    expect(first.length).toBeLessThan(800);
    expect(sendThousandLossy()).toStrictEqual(first);
  });

  it("reorders messages with jitter", () => {
    const network = MemoryNetwork.make({
      seed: 3,
      latencyMs: 10,
      jitterMs: 40,
    });
    const a = MemoryNetwork.connect(network, "a");
    const received = collect(network, "b");
    for (let i = 0; i < 50; i++) {
      a.send("b", String(i));
    }
    MemoryNetwork.advance(network, 100);
    expect(received).toHaveLength(50);
    expect(received).not.toStrictEqual(
      received.toSorted((x, y) => Number(x) - Number(y))
    );
  });

  it("loses everything to and from a cut-off peer, including messages in flight", () => {
    const network = MemoryNetwork.make({ seed: 1, latencyMs: 10 });
    const a = MemoryNetwork.connect(network, "a");
    const toB = collect(network, "b");
    const c = MemoryNetwork.connect(network, "c");
    const toD = collect(network, "d");
    a.send("b", "in flight");
    MemoryNetwork.cutOff(network, "b", true);
    a.send("b", "while cut");
    MemoryNetwork.advance(network, 20);
    expect(toB).toStrictEqual([]);
    MemoryNetwork.cutOff(network, "b", false);
    a.send("b", "after");
    c.send("d", "others unaffected");
    MemoryNetwork.advance(network, 40);
    expect(toB).toStrictEqual(["after"]);
    expect(toD).toStrictEqual(["others unaffected"]);
  });
});
