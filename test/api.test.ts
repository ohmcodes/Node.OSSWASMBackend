import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { type Config, loadConfig } from "../src/config.js";

const SERVER_KEY = "test-server-key";

function testConfig(overrides: Partial<Config> = {}): Config {
  return loadConfig(
    { JWT_SECRET: "test-secret", SERVER_KEYS: SERVER_KEY },
    { databasePath: ":memory:", serverTtl: 30, ...overrides },
  );
}

let app: FastifyInstance;

async function guest(deviceId = "device-0123456789abcdef", displayName?: string) {
  const res = await app.inject({ method: "POST", url: "/v1/auth/guest", payload: { deviceId, displayName } });
  expect(res.statusCode).toBe(200);
  return res.json() as { token: string; player: { id: string; displayName: string } };
}

async function registerServer(body: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/servers/register",
    headers: { "x-server-key": SERVER_KEY },
    payload: { name: "EU #1", version: "1.0", connectUrl: "ws://localhost:7777", maxPlayers: 4, ...body },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { serverId: string; serverToken: string; heartbeatIntervalSeconds: number };
}

beforeEach(async () => {
  app = await buildApp(testConfig());
});
afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

describe("health + CORS", () => {
  it("reports health", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toMatchObject({ ok: true });
  });

  it("allows itch.io and localhost origins, rejects others", async () => {
    const preflight = (origin: string) =>
      app.inject({
        method: "OPTIONS",
        url: "/v1/servers",
        headers: { origin, "access-control-request-method": "GET" },
      });
    expect((await preflight("https://html-classic.itch.zone")).headers["access-control-allow-origin"]).toBe(
      "https://html-classic.itch.zone",
    );
    expect((await preflight("http://localhost:8080")).headers["access-control-allow-origin"]).toBe(
      "http://localhost:8080",
    );
    expect((await preflight("https://evil.example.com")).headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("guest auth", () => {
  it("returns the same player for the same deviceId and supports renaming", async () => {
    const a = await guest("device-aaaaaaaaaaaaaaaa", "Alice");
    const b = await guest("device-aaaaaaaaaaaaaaaa");
    expect(b.player.id).toBe(a.player.id);
    expect(b.player.displayName).toBe("Alice");

    const renamed = await app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: { authorization: `Bearer ${a.token}` },
      payload: { displayName: "Alice2" },
    });
    expect(renamed.json().player.displayName).toBe("Alice2");

    const me = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${a.token}` } });
    expect(me.json().displayName).toBe("Alice2");
  });

  it("gives new guests a random friendly name and keeps it on later logins", async () => {
    const first = await guest("device-random-name-0001");
    expect(first.player.displayName).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+\d{4}$/);
    const again = await guest("device-random-name-0001");
    expect(again.player.displayName).toBe(first.player.displayName);
    const other = await guest("device-random-name-0002");
    expect(other.player.id).not.toBe(first.player.id);
  });

  it("sanitizes display names", async () => {
    const p = await guest("device-sanitize-000001", "  <b>Bob</b>\u0007  the  Builder  ");
    expect(p.player.displayName).toBe("bBob/b the Builder");
    const long = await guest("device-sanitize-000002", "Abcdefghij Klmnopqrst Uvwxyz12");
    expect(long.player.displayName).toBe("Abcdefghij Klmnopqrst Uv");
    const bad = await app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: { authorization: `Bearer ${p.token}` },
      payload: { displayName: "<<>>" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("rejects requests without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/me" });
    expect(res.statusCode).toBe(401);
  });
});

describe("server registry", () => {
  it("rejects registration with a wrong key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/servers/register",
      headers: { "x-server-key": "nope" },
      payload: { name: "x", version: "1.0", connectUrl: "ws://localhost:7777", maxPlayers: 4 },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts host:port and ws(s) URLs, rejects other connect URLs", async () => {
    const register = (connectUrl: string) =>
      app.inject({
        method: "POST",
        url: "/v1/servers/register",
        headers: { "x-server-key": SERVER_KEY },
        payload: { name: "x", version: "1.0", connectUrl, maxPlayers: 4 },
      });
    expect((await register("127.0.0.1:7777")).statusCode).toBe(201);
    expect((await register("game.example.com:7777")).statusCode).toBe(201);
    expect((await register("wss://game.example.com:443")).statusCode).toBe(201);
    expect((await register("http://localhost:7777")).statusCode).toBe(400);
    expect((await register("localhost")).statusCode).toBe(400);
    expect((await register("1.2.3.4:7777 junk")).statusCode).toBe(400);
  });

  it("register -> list -> heartbeat -> filter -> unregister", async () => {
    const s1 = await registerServer({ region: "eu", map: "ThirdPersonMap" });
    await registerServer({ name: "US #1", region: "us", version: "2.0", connectUrl: "wss://us.example.com" });

    let list = (await app.inject({ method: "GET", url: "/v1/servers" })).json().servers;
    expect(list).toHaveLength(2);
    expect(list[0]).not.toHaveProperty("token_hash");

    const hb = await app.inject({
      method: "POST",
      url: `/v1/servers/${s1.serverId}/heartbeat`,
      headers: { "x-server-token": s1.serverToken },
      payload: { players: 3 },
    });
    expect(hb.statusCode).toBe(200);

    const badHb = await app.inject({
      method: "POST",
      url: `/v1/servers/${s1.serverId}/heartbeat`,
      headers: { "x-server-token": "wrong" },
      payload: {},
    });
    expect(badHb.statusCode).toBe(401);

    list = (await app.inject({ method: "GET", url: "/v1/servers?region=eu" })).json().servers;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "EU #1", players: 3, map: "ThirdPersonMap" });

    list = (await app.inject({ method: "GET", url: "/v1/servers?version=2.0" })).json().servers;
    expect(list.map((s: { name: string }) => s.name)).toEqual(["US #1"]);

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/servers/${s1.serverId}`,
      headers: { "x-server-token": s1.serverToken },
    });
    expect(del.statusCode).toBe(204);
    list = (await app.inject({ method: "GET", url: "/v1/servers" })).json().servers;
    expect(list).toHaveLength(1);
  });

  it("drops servers that stop sending heartbeats", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await registerServer();
    expect((await app.inject({ method: "GET", url: "/v1/servers" })).json().servers).toHaveLength(1);

    vi.setSystemTime(new Date("2026-01-01T00:00:31Z"));
    expect((await app.inject({ method: "GET", url: "/v1/servers" })).json().servers).toHaveLength(0);
  });
});

describe("join tickets", () => {
  it("issues a ticket the server can verify exactly once", async () => {
    const player = await guest();
    const s = await registerServer();

    const join = await app.inject({
      method: "POST",
      url: `/v1/servers/${s.serverId}/join`,
      headers: { authorization: `Bearer ${player.token}` },
    });
    expect(join.statusCode).toBe(200);
    const { ticket, connectUrl } = join.json();
    expect(connectUrl).toBe("ws://localhost:7777");

    const verify = () =>
      app.inject({
        method: "POST",
        url: `/v1/servers/${s.serverId}/verify-ticket`,
        headers: { "x-server-token": s.serverToken },
        payload: { ticket },
      });
    expect((await verify()).json()).toEqual({
      valid: true,
      playerId: player.player.id,
      displayName: player.player.displayName,
    });
    expect((await verify()).json()).toMatchObject({ valid: false, reason: "already_used" });
  });

  it("rejects a ticket for another server and refuses full servers", async () => {
    const player = await guest();
    const a = await registerServer();
    const b = await registerServer({ name: "Full", players: 4, maxPlayers: 4 });

    const ticket = (
      await app.inject({
        method: "POST",
        url: `/v1/servers/${a.serverId}/join`,
        headers: { authorization: `Bearer ${player.token}` },
      })
    ).json().ticket;
    const wrong = await app.inject({
      method: "POST",
      url: `/v1/servers/${b.serverId}/verify-ticket`,
      headers: { "x-server-token": b.serverToken },
      payload: { ticket },
    });
    expect(wrong.json()).toMatchObject({ valid: false, reason: "wrong_server" });

    const full = await app.inject({
      method: "POST",
      url: `/v1/servers/${b.serverId}/join`,
      headers: { authorization: `Bearer ${player.token}` },
    });
    expect(full.statusCode).toBe(409);
  });

  it("accepts body-less POSTs that still carry a Content-Type (engine HTTP does this)", async () => {
    const player = await guest();
    const s = await registerServer();
    for (const contentType of ["application/json", "text/plain", "application/x-www-form-urlencoded"]) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/servers/${s.serverId}/join`,
        headers: { authorization: `Bearer ${player.token}`, "content-type": contentType },
        payload: "",
      });
      expect(res.statusCode, contentType).toBe(200);
    }
    const bad = await app.inject({
      method: "POST",
      url: "/v1/auth/guest",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(bad.statusCode).toBe(400);
  });

  it("does not accept a join ticket as a player token", async () => {
    const player = await guest();
    const s = await registerServer();
    const { ticket } = (
      await app.inject({
        method: "POST",
        url: `/v1/servers/${s.serverId}/join`,
        headers: { authorization: `Bearer ${player.token}` },
      })
    ).json();
    const res = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${ticket}` } });
    expect(res.statusCode).toBe(401);
  });
});

describe("leaderboards", () => {
  it("keeps the best score per player and ranks them", async () => {
    const alice = await guest("device-alice-000000000", "Alice");
    const bob = await guest("device-bob-00000000000", "Bob");
    const post = (token: string, score: number) =>
      app.inject({
        method: "POST",
        url: "/v1/leaderboards/time_trial/scores",
        headers: { authorization: `Bearer ${token}` },
        payload: { score },
      });

    expect((await post(alice.token, 100)).json()).toMatchObject({ improved: true, entry: { rank: 1 } });
    expect((await post(bob.token, 150)).json()).toMatchObject({ improved: true, entry: { rank: 1 } });
    expect((await post(alice.token, 50)).json()).toMatchObject({ improved: false, entry: { score: 100, rank: 2 } });

    const board = (await app.inject({ method: "GET", url: "/v1/leaderboards/time_trial?limit=10" })).json();
    expect(board.total).toBe(2);
    expect(board.entries.map((e: { displayName: string }) => e.displayName)).toEqual(["Bob", "Alice"]);

    const mine = await app.inject({ method: "GET", url: `/v1/leaderboards/time_trial/players/${alice.player.id}` });
    expect(mine.json()).toMatchObject({ rank: 2, score: 100 });
  });

  it("lets a dedicated server submit for a player, and can block client submits", async () => {
    await app.close();
    app = await buildApp(testConfig({ clientScoreSubmit: false }));
    const player = await guest();
    const s = await registerServer();

    const byClient = await app.inject({
      method: "POST",
      url: "/v1/leaderboards/kills/scores",
      headers: { authorization: `Bearer ${player.token}` },
      payload: { score: 5 },
    });
    expect(byClient.statusCode).toBe(403);

    const byServer = await app.inject({
      method: "POST",
      url: "/v1/leaderboards/kills/scores",
      headers: { "x-server-id": s.serverId, "x-server-token": s.serverToken },
      payload: { score: 5, playerId: player.player.id },
    });
    expect(byServer.statusCode).toBe(200);
    expect(byServer.json().entry).toMatchObject({ score: 5, playerId: player.player.id });
  });
});

describe("cloud saves", () => {
  it("puts, lists, gets and deletes slots per player", async () => {
    const a = await guest("device-save-a000000000");
    const b = await guest("device-save-b000000000");
    const auth = (t: string) => ({ authorization: `Bearer ${t}` });
    const data = Buffer.from("hello save").toString("base64");

    expect((await app.inject({ method: "PUT", url: "/v1/saves/slot1", headers: auth(a.token), payload: { data } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/saves/slot1", headers: auth(a.token) })).json().data).toBe(data);
    expect((await app.inject({ method: "GET", url: "/v1/saves/slot1", headers: auth(b.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/saves", headers: auth(a.token) })).json().slots).toHaveLength(1);

    expect((await app.inject({ method: "DELETE", url: "/v1/saves/slot1", headers: auth(a.token) })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/v1/saves/slot1", headers: auth(a.token) })).statusCode).toBe(404);
  });

  it("rejects saves over the size limit", async () => {
    await app.close();
    app = await buildApp(testConfig({ maxSaveBytes: 16 }));
    const a = await guest();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/saves/big",
      headers: { authorization: `Bearer ${a.token}` },
      payload: { data: "x".repeat(100) },
    });
    expect(res.statusCode).toBe(400);
  });
});
