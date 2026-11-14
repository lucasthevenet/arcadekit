import { Effect, Logger } from "effect";
import { describe, expect, it } from "vitest";

import { JoinCode } from "../../../../src/net/signalling/index";
import {
  handleRequest,
  readRoomRequest,
  roomRequest,
} from "../../../../src/net/worker/internal/routes";
import type { Bindings } from "../../../../src/net/worker/internal/routes";

/**
 * The Worker's bindings, recording what reaches them. `room` answers for every join code, and
 * `site` for the site's files.
 */
const fakeBindings = (
  room: (request: Request) => Promise<Response> = () =>
    Promise.resolve(new Response("room")),
  site: (request: Request) => Promise<Response> = () =>
    Promise.resolve(new Response("site"))
) => {
  const assets: Request[] = [];
  const rooms: { code: string; request: Request }[] = [];
  const bindings: Bindings = {
    ASSETS: {
      fetch: (request) => {
        assets.push(request);
        return site(request);
      },
    },
    ROOMS: {
      getByName: (code) => ({
        fetch: (request) => {
          rooms.push({ code, request });
          return room(request);
        },
      }),
    },
  };
  return { bindings, assets, rooms };
};

const upgrade = { headers: { Upgrade: "websocket" } };

const answer = async (request: Request, bindings: Bindings) => {
  const logs: unknown[] = [];
  const response = await handleRequest(request, bindings).pipe(
    Effect.provide(
      Logger.layer([Logger.make((log) => logs.push(log.message))])
    ),
    Effect.runPromise
  );
  return { response, logs };
};

describe(handleRequest, () => {
  it("serves anything but the signalling routes from the site's files", async () => {
    const { bindings, assets, rooms } = fakeBindings();
    const { response } = await answer(
      new Request("https://game.test/hostel", upgrade),
      bindings
    );
    await expect(response.text()).resolves.toBe("site");
    expect(assets.map((request) => request.url)).toStrictEqual([
      "https://game.test/hostel",
    ]);
    expect(rooms).toStrictEqual([]);
  });

  it("asks for a WebSocket upgrade on a signalling route", async () => {
    const { bindings, rooms } = fakeBindings();
    const { response } = await answer(
      new Request("https://game.test/host"),
      bindings
    );
    expect(response.status).toBe(426);
    expect(rooms).toStrictEqual([]);
  });

  it("hands /host to a fresh join code's room, as its host", async () => {
    const { bindings, rooms } = fakeBindings();
    const { response } = await answer(
      new Request("https://game.test/host", upgrade),
      bindings
    );
    await expect(response.text()).resolves.toBe("room");
    const [{ code, request }] = rooms as [(typeof rooms)[number]];
    expect(JoinCode.fromTyped(code)).toBe(code);
    expect(readRoomRequest(request)).toStrictEqual({ code, role: "host" });
    expect(request.headers.get("Upgrade")).toBe("websocket");
  });

  it("hands /join/<code> to that code's room, as a guest", async () => {
    const { bindings, rooms } = fakeBindings();
    await answer(
      new Request("https://game.test/join/k7mq2x", upgrade),
      bindings
    );
    expect(
      rooms.map(({ code, request }) => [code, readRoomRequest(request)])
    ).toStrictEqual([["K7MQ2X", { code: "K7MQ2X", role: "guest" }]]);
  });

  it("answers 404 for a join path that can't hold a join code", async () => {
    const { bindings, rooms } = fakeBindings();
    const { response } = await answer(
      new Request("https://game.test/join/K7MQ2", upgrade),
      bindings
    );
    expect(response.status).toBe(404);
    expect(rooms).toStrictEqual([]);
  });

  it("answers 503 and logs it when the room's Durable Object can't be reached", async () => {
    const error = new Error("Durable Object is overloaded");
    const { bindings } = fakeBindings(() => Promise.reject(error));
    const { response, logs } = await answer(
      new Request("https://game.test/join/K7MQ2X", upgrade),
      bindings
    );
    expect(response.status).toBe(503);
    expect(logs).toStrictEqual([["The Worker's ROOMS binding failed", error]]);
  });

  it("answers 503 and logs it when the site's files can't be fetched", async () => {
    const error = new Error("assets down");
    const { bindings } = fakeBindings(undefined, () => Promise.reject(error));
    const { response, logs } = await answer(
      new Request("https://game.test/hostel"),
      bindings
    );
    expect(response.status).toBe(503);
    expect(logs).toStrictEqual([["The Worker's ASSETS binding failed", error]]);
  });
});

describe(readRoomRequest, () => {
  it("reads back what roomRequest wrote, and nothing else", () => {
    const peer = new Request("https://game.test/join/K7MQ2X?x=1", upgrade);
    expect(
      [
        roomRequest(peer, "K7MQ2X", "guest"),
        new Request("https://game.test/?code=K7MQ2X&role=admin"),
        new Request("https://game.test/?role=host"),
      ].map(readRoomRequest)
    ).toStrictEqual([{ code: "K7MQ2X", role: "guest" }, undefined, undefined]);
  });
});
