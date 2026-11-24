import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { randomToken } from "../auth.js";
import { now } from "../db.js";
import { sanitizeDisplayName } from "../names.js";

/**
 * itch.io login (OAuth authorization code + PKCE, no client secret).
 *
 * The backend does the whole dance so every platform behaves the same and the game needs no crypto or listener:
 *   1. game  POST /v1/auth/itch/start            -> { authorizeUrl, pollId }
 *   2. game  opens authorizeUrl (popup / system browser) and polls GET /v1/auth/itch/status/:pollId
 *   3. itch  redirects the browser to GET /v1/auth/itch/callback?code&state (this backend)
 *   4. backend exchanges the code, reads the itch profile, finds/creates the player, stores the result
 *   5. the game's next poll returns the normal player token (once).
 * The redirect URI (ITCH_REDIRECT_URI, default <PUBLIC_URL>/v1/auth/itch/callback) must be registered on the itch.io
 * OAuth app. Pending logins live in memory (single backend instance, ITCH_LOGIN_TTL_SECONDS, default 10 minutes).
 */

type Pending = {
  pollId: string;
  verifier: string;
  expiresAt: number;
  result?: { status: "done"; body: object } | { status: "error"; message: string };
};

interface PlayerRow {
  id: string;
  display_name: string;
  created_at: number;
}

const PROVIDER = "itch";

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const page = (title: string, message: string, ok: boolean) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${escapeHtml(title)}</title><style>body{font:16px system-ui,sans-serif;background:#111;color:#eee;display:grid;` +
  `place-items:center;min-height:100vh;margin:0}main{max-width:26em;padding:2em;text-align:center}` +
  `h1{color:${ok ? "#7ddc8a" : "#ff8a80"}}</style></head><body><main><h1>${escapeHtml(title)}</h1>` +
  `<p>${escapeHtml(message)}</p></main><script>setTimeout(function(){window.close()},1500)</script></body></html>`;

export default async function itchRoutes(app: FastifyInstance) {
  const { db, config } = app;
  const pending = new Map<string, Pending>(); // key = state
  const byPollId = new Map<string, string>(); // pollId -> state

  const drop = (state: string) => {
    const entry = pending.get(state);
    if (entry) byPollId.delete(entry.pollId);
    pending.delete(state);
  };
  const sweep = () => {
    const t = now();
    for (const [state, entry] of pending) if (entry.expiresAt < t) drop(state);
  };
  const sweeper = setInterval(sweep, 60_000);
  sweeper.unref();
  app.addHook("onClose", async () => clearInterval(sweeper));

  const findIdentity = db.prepare("SELECT player_id FROM identities WHERE provider = ? AND subject = ?");
  const findPlayer = db.prepare("SELECT id, display_name, created_at FROM players WHERE id = ?");
  const insertPlayer = db.prepare(
    "INSERT INTO players (id, display_name, device_hash, created_at, last_seen_at) VALUES (?, ?, NULL, ?, ?)",
  );
  const insertIdentity = db.prepare("INSERT INTO identities (provider, subject, player_id, created_at) VALUES (?, ?, ?, ?)");
  const touch = db.prepare("UPDATE players SET last_seen_at = ? WHERE id = ?");

  const issue = (row: PlayerRow) => ({
    token: app.jwt.sign({ typ: "player", sub: row.id, name: row.display_name }, { expiresIn: config.playerTokenTtl }),
    expiresIn: config.playerTokenTtl,
    player: { id: row.id, displayName: row.display_name, createdAt: row.created_at },
  });

  /** Which login providers this backend offers. Guest is always on. */
  app.get("/v1/auth/providers", async () => ({
    providers: [{ name: "guest", label: "Guest" }, ...(config.itchClientId ? [{ name: PROVIDER, label: "itch.io" }] : [])],
  }));

  app.post("/v1/auth/itch/start", async (_request, reply) => {
    if (!config.itchClientId) {
      return reply.code(501).send({ error: "provider_disabled", message: "itch.io login is not configured (ITCH_CLIENT_ID)." });
    }
    sweep();
    if (pending.size >= 5000) return reply.code(429).send({ error: "busy", message: "Too many logins in progress." });

    const state = randomToken(24);
    const verifier = randomToken(32); // 64 characters: inside the 43-128 PKCE limit
    const pollId = randomToken(24);
    pending.set(state, { pollId, verifier, expiresAt: now() + config.itchLoginTtl * 1000 });
    byPollId.set(pollId, state);

    const url = new URL(config.itchAuthorizeUrl);
    url.searchParams.set("client_id", config.itchClientId);
    url.searchParams.set("scope", "profile:me");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", config.itchRedirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
    return { authorizeUrl: url.toString(), pollId, expiresIn: config.itchLoginTtl };
  });

  app.get<{ Params: { pollId: string } }>("/v1/auth/itch/status/:pollId", async (request, reply) => {
    const state = byPollId.get(request.params.pollId);
    const entry = state ? pending.get(state) : undefined;
    if (!state || !entry || entry.expiresAt < now()) {
      if (state) drop(state);
      return reply.code(404).send({ error: "not_found", message: "Unknown or expired login. Start again." });
    }
    if (!entry.result) return { status: "pending" };
    drop(state); // the result is handed out once
    return entry.result.status === "done"
      ? { status: "done", ...entry.result.body }
      : { status: "error", message: entry.result.message };
  });

  async function finish(code: string, entry: Pending): Promise<PlayerRow> {
    const tokenRes = await fetch(`${config.itchApiUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: entry.verifier,
        redirect_uri: config.itchRedirectUri,
        client_id: config.itchClientId,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!tokenRes.ok) throw new Error(`itch.io rejected the login code (${tokenRes.status}).`);
    const accessToken = ((await tokenRes.json()) as { access_token?: string }).access_token;
    if (!accessToken) throw new Error("itch.io returned no access token.");

    const profileRes = await fetch(`${config.itchApiUrl}/profile`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!profileRes.ok) throw new Error(`Could not read the itch.io profile (${profileRes.status}).`);
    const user = ((await profileRes.json()) as { user?: { id?: number | string; username?: string; display_name?: string } }).user;
    if (user?.id === undefined || user.id === null) throw new Error("The itch.io profile has no user id.");
    const subject = String(user.id);

    const known = findIdentity.get(PROVIDER, subject) as { player_id: string } | undefined;
    if (known) {
      touch.run(now(), known.player_id);
      const row = findPlayer.get(known.player_id) as PlayerRow | undefined;
      if (row) return row;
    }
    const id = randomUUID();
    const t = now();
    const name = sanitizeDisplayName(user.display_name || user.username || "") || `itch-${subject}`;
    db.exec("BEGIN");
    try {
      insertPlayer.run(id, name, t, t);
      insertIdentity.run(PROVIDER, subject, id, t);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { id, display_name: name, created_at: t };
  }

  /** itch.io redirects the player's browser here. */
  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    "/v1/auth/itch/callback",
    async (request, reply) => {
      reply.type("text/html; charset=utf-8");
      const { code, state, error } = request.query;
      const entry = state ? pending.get(state) : undefined;
      if (!state || !entry || entry.expiresAt < now()) {
        return reply.code(400).send(page("Login expired", "Go back to the game and start the login again.", false));
      }
      if (entry.result) return reply.code(400).send(page("Already used", "This login link was already used.", false));
      if (error || !code) {
        entry.result = { status: "error", message: request.query.error_description || "The login was cancelled." };
        return page("Login cancelled", "You can close this window and return to the game.", false);
      }
      try {
        const row = await finish(code, entry);
        entry.result = { status: "done", body: issue(row) };
        return page("Logged in", `Welcome, ${row.display_name}! You can close this window and return to the game.`, true);
      } catch (err) {
        app.log.warn({ err }, "itch.io login failed");
        entry.result = { status: "error", message: err instanceof Error ? err.message : "Login failed." };
        return reply.code(502).send(page("Login failed", "Something went wrong talking to itch.io. Return to the game and try again.", false));
      }
    },
  );
}
