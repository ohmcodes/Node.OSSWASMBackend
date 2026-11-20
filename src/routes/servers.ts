import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type JoinTicketClaims,
  randomToken,
  requirePlayer,
  safeEqual,
  serverKeyHeader,
  serverTokenHeader,
  sha256,
} from "../auth.js";
import { now } from "../db.js";

interface ServerRow {
  id: string;
  token_hash: string;
  name: string;
  region: string;
  map: string;
  mode: string;
  version: string;
  connect_url: string;
  max_players: number;
  players: number;
  state: string;
  metadata: string;
  created_at: number;
  last_heartbeat: number;
}

export function toPublicServer(row: ServerRow) {
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    map: row.map,
    mode: row.mode,
    version: row.version,
    connectUrl: row.connect_url,
    players: row.players,
    maxPlayers: row.max_players,
    state: row.state,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    lastHeartbeat: row.last_heartbeat,
  };
}

const STATES = ["open", "in_progress", "full", "closed"] as const;

const serverFields = {
  name: { type: "string", minLength: 1, maxLength: 64 },
  region: { type: "string", minLength: 1, maxLength: 32 },
  map: { type: "string", maxLength: 128 },
  mode: { type: "string", maxLength: 64 },
  version: { type: "string", minLength: 1, maxLength: 32 },
  connectUrl: { type: "string", pattern: "^wss?://", maxLength: 256 },
  maxPlayers: { type: "integer", minimum: 1, maximum: 1000 },
  players: { type: "integer", minimum: 0, maximum: 1000 },
  state: { type: "string", enum: STATES },
  metadata: { type: "object", maxProperties: 32 },
} as const;

interface RegisterBody {
  name: string;
  region?: string;
  map?: string;
  mode?: string;
  version: string;
  connectUrl: string;
  maxPlayers: number;
  players?: number;
  state?: (typeof STATES)[number];
  metadata?: Record<string, unknown>;
}

type HeartbeatBody = Partial<Omit<RegisterBody, "version" | "connectUrl">>;

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;

export default async function serverRoutes(app: FastifyInstance) {
  const { db, config } = app;

  const getServer = db.prepare("SELECT * FROM servers WHERE id = ?");
  const insertServer = db.prepare(`
    INSERT INTO servers (id, token_hash, name, region, map, mode, version, connect_url,
                         max_players, players, state, metadata, created_at, last_heartbeat)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const deleteServer = db.prepare("DELETE FROM servers WHERE id = ?");
  const deleteExpired = db.prepare("DELETE FROM servers WHERE last_heartbeat < ?");
  const deleteUsedTickets = db.prepare("DELETE FROM used_tickets WHERE expires_at < ?");
  const insertTicket = db.prepare("INSERT OR IGNORE INTO used_tickets (jti, expires_at) VALUES (?, ?)");

  const isAlive = (row: ServerRow) => row.last_heartbeat >= now() - config.serverTtl * 1000;
  const metadataJson = (m: Record<string, unknown> | undefined) => {
    const json = JSON.stringify(m ?? {});
    if (json.length > 4096) throw Object.assign(new Error("metadata too large (max 4 KB)"), { statusCode: 400 });
    return json;
  };

  /** Remove expired servers and used tickets. Runs on a timer and before listing. */
  const sweep = () => {
    deleteExpired.run(now() - config.serverTtl * 1000);
    deleteUsedTickets.run(now());
  };
  const timer = setInterval(sweep, Math.max(5, config.serverTtl / 2) * 1000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));

  /** preHandler for server-owned routes: x-server-token must match the server in :id. */
  const requireServer = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const token = serverTokenHeader(request);
    const row = getServer.get(request.params.id) as ServerRow | undefined;
    if (!token || !row || !safeEqual(sha256(token), row.token_hash)) {
      return reply.code(401).send({ error: "unauthorized", message: "Unknown server or bad x-server-token." });
    }
    request.serverId = row.id;
  };

  // ---- Dedicated server side --------------------------------------------------------------

  app.post<{ Body: RegisterBody }>(
    "/v1/servers/register",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "version", "connectUrl", "maxPlayers"],
          additionalProperties: false,
          properties: serverFields,
        },
      },
    },
    async (request, reply) => {
      const key = serverKeyHeader(request);
      if (!key || !config.serverKeys.some((k) => safeEqual(k, key))) {
        return reply.code(401).send({ error: "unauthorized", message: "Missing or wrong x-server-key." });
      }
      const b = request.body;
      const id = randomUUID();
      const token = randomToken();
      const t = now();
      insertServer.run(
        id, sha256(token), b.name, b.region ?? "default", b.map ?? "", b.mode ?? "", b.version,
        b.connectUrl, b.maxPlayers, b.players ?? 0, b.state ?? "open", metadataJson(b.metadata), t, t,
      );
      request.log.info({ serverId: id, name: b.name, connectUrl: b.connectUrl }, "server registered");
      return reply.code(201).send({
        serverId: id,
        serverToken: token,
        heartbeatIntervalSeconds: Math.max(1, Math.floor(config.serverTtl / 3)),
        ttlSeconds: config.serverTtl,
      });
    },
  );

  app.post<{ Params: { id: string }; Body: HeartbeatBody }>(
    "/v1/servers/:id/heartbeat",
    {
      preHandler: requireServer,
      schema: {
        params: idParams,
        body: {
          type: ["object", "null"],
          additionalProperties: false,
          properties: {
            name: serverFields.name,
            region: serverFields.region,
            map: serverFields.map,
            mode: serverFields.mode,
            maxPlayers: serverFields.maxPlayers,
            players: serverFields.players,
            state: serverFields.state,
            metadata: serverFields.metadata,
          },
        },
      },
    },
    async (request) => {
      const row = getServer.get(request.params.id) as unknown as ServerRow; // requireServer checked it exists
      const b = request.body ?? {};
      db.prepare(`
        UPDATE servers SET name = ?, region = ?, map = ?, mode = ?, max_players = ?, players = ?,
                           state = ?, metadata = ?, last_heartbeat = ?
        WHERE id = ?`).run(
        b.name ?? row.name, b.region ?? row.region, b.map ?? row.map, b.mode ?? row.mode,
        b.maxPlayers ?? row.max_players, b.players ?? row.players, b.state ?? row.state,
        b.metadata ? metadataJson(b.metadata) : row.metadata, now(), row.id,
      );
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/v1/servers/:id",
    { preHandler: requireServer, schema: { params: idParams } },
    async (request, reply) => {
      deleteServer.run(request.params.id);
      request.log.info({ serverId: request.params.id }, "server unregistered");
      return reply.code(204).send();
    },
  );

  /** The dedicated server checks a player's join ticket (from PreLogin). Each ticket works once. */
  app.post<{ Params: { id: string }; Body: { ticket: string } }>(
    "/v1/servers/:id/verify-ticket",
    {
      preHandler: requireServer,
      schema: {
        params: idParams,
        body: {
          type: "object",
          required: ["ticket"],
          additionalProperties: false,
          properties: { ticket: { type: "string", minLength: 1, maxLength: 4096 } },
        },
      },
    },
    async (request) => {
      let claims: JoinTicketClaims;
      try {
        const decoded = app.jwt.verify<JoinTicketClaims | { typ: string }>(request.body.ticket);
        if (decoded.typ !== "join") throw new Error("wrong token type");
        claims = decoded as JoinTicketClaims;
      } catch {
        return { valid: false, reason: "invalid_or_expired" };
      }
      if (claims.sid !== request.params.id) return { valid: false, reason: "wrong_server" };
      const used = insertTicket.run(claims.jti, now() + config.joinTicketTtl * 1000);
      if (used.changes === 0) return { valid: false, reason: "already_used" };
      return { valid: true, playerId: claims.sub, displayName: claims.name };
    },
  );

  // ---- Player side ------------------------------------------------------------------------

  app.get<{ Querystring: { version?: string; region?: string; includeFull?: boolean } }>(
    "/v1/servers",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            version: { type: "string", maxLength: 32 },
            region: { type: "string", maxLength: 32 },
            includeFull: { type: "boolean", default: true },
          },
        },
      },
    },
    async (request) => {
      sweep();
      const { version, region, includeFull } = request.query;
      const where = ["state != 'closed'"];
      const params: string[] = [];
      if (version) { where.push("version = ?"); params.push(version); }
      if (region) { where.push("region = ?"); params.push(region); }
      if (!includeFull) where.push("players < max_players AND state != 'full'");
      const rows = db
        .prepare(`SELECT * FROM servers WHERE ${where.join(" AND ")} ORDER BY players DESC, name ASC LIMIT 500`)
        .all(...params) as unknown as ServerRow[];
      return { servers: rows.map(toPublicServer) };
    },
  );

  app.get<{ Params: { id: string } }>("/v1/servers/:id", { schema: { params: idParams } }, async (request, reply) => {
    const row = getServer.get(request.params.id) as ServerRow | undefined;
    if (!row || !isAlive(row)) return reply.code(404).send({ error: "not_found" });
    return toPublicServer(row);
  });

  /** Player asks to join: returns where to connect plus a one-time ticket for the server. */
  app.post<{ Params: { id: string } }>(
    "/v1/servers/:id/join",
    { preHandler: requirePlayer, schema: { params: idParams } },
    async (request, reply) => {
      const row = getServer.get(request.params.id) as ServerRow | undefined;
      if (!row || !isAlive(row) || row.state === "closed") return reply.code(404).send({ error: "not_found" });
      if (row.players >= row.max_players || row.state === "full") return reply.code(409).send({ error: "server_full" });
      const ticket = app.jwt.sign(
        { typ: "join", sub: request.user.sub, name: request.user.name, sid: row.id, jti: randomUUID() },
        { expiresIn: config.joinTicketTtl },
      );
      return { connectUrl: row.connect_url, ticket, expiresIn: config.joinTicketTtl };
    },
  );
}
