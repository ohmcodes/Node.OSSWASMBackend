import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { type Config, loadConfig } from "../src/config.js";

function testConfig(overrides: Partial<Config> = {}): Config {
  return loadConfig(
    { JWT_SECRET: "test-secret", SERVER_KEYS: "k", ITCH_CLIENT_ID: "client123", PUBLIC_URL: "https://api.example.com" },
    { databasePath: ":memory:", ...overrides },
  );
}

let app: FastifyInstance;
const itchUser = { id: 4242, username: "cool_dev", display_name: "Cool Dev" };
let tokenStatus = 200;
let tokenForm: URLSearchParams | undefined;

beforeEach(async () => {
  tokenStatus = 200;
  tokenForm = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/oauth/token")) {
        tokenForm = new URLSearchParams(init?.body as URLSearchParams);
        return new Response(JSON.stringify({ access_token: "itch-access" }), { status: tokenStatus });
      }
      if (url.endsWith("/profile")) {
        const auth = (init?.headers as Record<string, string>).authorization;
        return new Response(JSON.stringify({ user: itchUser }), { status: auth === "Bearer itch-access" ? 200 : 401 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
  app = await buildApp(testConfig());
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

async function start() {
  const res = await app.inject({ method: "POST", url: "/v1/auth/itch/start" });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { authorizeUrl: string; pollId: string };
  return { ...body, url: new URL(body.authorizeUrl) };
}

const poll = async (pollId: string) => app.inject({ method: "GET", url: `/v1/auth/itch/status/${pollId}` });

describe("itch.io login", () => {
  it("lists providers", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/auth/providers" });
    expect((res.json() as { providers: { name: string }[] }).providers.map((p) => p.name)).toEqual(["guest", "itch"]);
  });

  it("is off without ITCH_CLIENT_ID", async () => {
    await app.close();
    app = await buildApp(testConfig({ itchClientId: "" }));
    const providers = await app.inject({ method: "GET", url: "/v1/auth/providers" });
    expect((providers.json() as { providers: unknown[] }).providers).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: "/v1/auth/itch/start" })).statusCode).toBe(501);
  });

  it("builds a PKCE authorize URL", async () => {
    const { url } = await start();
    expect(url.origin + url.pathname).toBe("https://itch.io/user/oauth");
    expect(url.searchParams.get("client_id")).toBe("client123");
    expect(url.searchParams.get("scope")).toBe("profile:me");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.example.com/v1/auth/itch/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("completes the flow: callback exchanges the code, poll returns a working player token once", async () => {
    const { url, pollId } = await start();
    expect(((await poll(pollId)).json() as { status: string }).status).toBe("pending");

    const state = url.searchParams.get("state");
    const cb = await app.inject({ method: "GET", url: `/v1/auth/itch/callback?code=abc&state=${state}` });
    expect(cb.statusCode).toBe(200);
    expect(cb.headers["content-type"]).toContain("text/html");
    expect(cb.body).toContain("Cool Dev");

    // PKCE: the verifier sent to itch hashes to the challenge sent in the authorize URL
    expect(tokenForm?.get("code")).toBe("abc");
    expect(tokenForm?.get("client_id")).toBe("client123");
    expect(createHash("sha256").update(tokenForm?.get("code_verifier") ?? "").digest("base64url")).toBe(
      url.searchParams.get("code_challenge"),
    );

    const done = (await poll(pollId)).json() as { status: string; token: string; player: { displayName: string; id: string } };
    expect(done.status).toBe("done");
    expect(done.player.displayName).toBe("Cool Dev");
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${done.token}` } });
    expect(me.json()).toMatchObject({ id: done.player.id, displayName: "Cool Dev" });

    expect((await poll(pollId)).statusCode).toBe(404); // handed out once
  });

  it("gives the same player to the same itch account", async () => {
    const login = async () => {
      const { url, pollId } = await start();
      await app.inject({ method: "GET", url: `/v1/auth/itch/callback?code=abc&state=${url.searchParams.get("state")}` });
      return ((await poll(pollId)).json() as { player: { id: string } }).player.id;
    };
    const first = await login();
    expect(await login()).toBe(first);
  });

  it("rejects an unknown or reused state", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/auth/itch/callback?code=abc&state=nope" })).statusCode).toBe(400);
    const { url } = await start();
    const state = url.searchParams.get("state");
    await app.inject({ method: "GET", url: `/v1/auth/itch/callback?code=abc&state=${state}` });
    expect((await app.inject({ method: "GET", url: `/v1/auth/itch/callback?code=abc&state=${state}` })).statusCode).toBe(400);
  });

  it("reports a cancelled login to the game", async () => {
    const { url, pollId } = await start();
    await app.inject({ method: "GET", url: `/v1/auth/itch/callback?error=access_denied&state=${url.searchParams.get("state")}` });
    expect(await poll(pollId).then((r) => r.json())).toMatchObject({ status: "error" });
  });

  it("reports an itch.io failure to the game and escapes nothing unsafe in the page", async () => {
    tokenStatus = 400;
    const { url, pollId } = await start();
    const cb = await app.inject({ method: "GET", url: `/v1/auth/itch/callback?code=bad&state=${url.searchParams.get("state")}` });
    expect(cb.statusCode).toBe(502);
    expect(await poll(pollId).then((r) => r.json())).toMatchObject({ status: "error" });
  });

  it("escapes the player's name in the callback page", async () => {
    itchUser.display_name = "<img src=x onerror=alert(1)>";
    const { url } = await start();
    const cb = await app.inject({ method: "GET", url: `/v1/auth/itch/callback?code=abc&state=${url.searchParams.get("state")}` });
    expect(cb.body).not.toContain("<img");
    itchUser.display_name = "Cool Dev";
  });

  it("expires logins", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { pollId } = await start();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect((await poll(pollId)).statusCode).toBe(404);
    vi.useRealTimers();
  });
});
