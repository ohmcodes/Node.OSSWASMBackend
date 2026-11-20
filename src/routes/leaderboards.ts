import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type PlayerClaims, safeEqual, serverTokenHeader, sha256 } from "../auth.js";
import { now } from "../db.js";

const boardParams = {
  type: "object",
  required: ["board"],
  properties: { board: { type: "string", pattern: "^[A-Za-z0-9_.-]{1,64}$" } },
} as const;

interface ScoreRow {
  rank: number;
  player_id: string;
  display_name: string;
  score: number;
  updated_at: number;
}

const toEntry = (r: ScoreRow) => ({
  rank: r.rank,
  playerId: r.player_id,
  displayName: r.display_name,
  score: r.score,
  updatedAt: r.updated_at,
});

/**
 * One best score per player per board; higher is better.
 * Scores can be posted by the player (if CLIENT_SCORE_SUBMIT=true) or by a registered dedicated
 * server on behalf of a player (x-server-id + x-server-token headers, body.playerId).
 */
export default async function leaderboardRoutes(app: FastifyInstance) {
  const { db, config } = app;

  const upsert = db.prepare(`
    INSERT INTO scores (board, player_id, score, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (board, player_id) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at
    WHERE excluded.score > scores.score`);
  const playerExists = db.prepare("SELECT 1 FROM players WHERE id = ?");
  const serverHash = db.prepare("SELECT token_hash FROM servers WHERE id = ?");
  const ranked = `
    SELECT RANK() OVER (ORDER BY s.score DESC) AS rank, s.player_id, p.display_name, s.score, s.updated_at
    FROM scores s JOIN players p ON p.id = s.player_id WHERE s.board = ?`;
  const top = db.prepare(`${ranked} ORDER BY s.score DESC, s.updated_at ASC LIMIT ? OFFSET ?`);
  const one = db.prepare(`SELECT * FROM (${ranked}) WHERE player_id = ?`);
  const count = db.prepare("SELECT COUNT(*) AS n FROM scores WHERE board = ?");

  /** Who is submitting: a server (for body.playerId) or a player (for themselves). */
  const resolveSubmitter = async (
    request: FastifyRequest<{ Body: { score: number; playerId?: string } }>,
    reply: FastifyReply,
  ): Promise<string | undefined> => {
    const serverId = request.headers["x-server-id"];
    const token = serverTokenHeader(request);
    if (typeof serverId === "string" && token) {
      const row = serverHash.get(serverId) as { token_hash: string } | undefined;
      if (!row || !safeEqual(sha256(token), row.token_hash)) {
        reply.code(401).send({ error: "unauthorized", message: "Bad server credentials." });
        return undefined;
      }
      if (!request.body.playerId) {
        reply.code(400).send({ error: "bad_request", message: "playerId is required when a server submits." });
        return undefined;
      }
      return request.body.playerId;
    }
    if (!config.clientScoreSubmit) {
      reply.code(403).send({ error: "forbidden", message: "Only dedicated servers may submit scores." });
      return undefined;
    }
    try {
      const claims = await request.jwtVerify<PlayerClaims>();
      if (claims.typ !== "player") throw new Error();
      return claims.sub;
    } catch {
      reply.code(401).send({ error: "unauthorized", message: "A valid player token is required." });
      return undefined;
    }
  };

  app.post<{ Params: { board: string }; Body: { score: number; playerId?: string } }>(
    "/v1/leaderboards/:board/scores",
    {
      schema: {
        params: boardParams,
        body: {
          type: "object",
          required: ["score"],
          additionalProperties: false,
          properties: {
            score: { type: "number" },
            playerId: { type: "string", format: "uuid" },
          },
        },
      },
    },
    async (request, reply) => {
      const playerId = await resolveSubmitter(request, reply);
      if (!playerId) return reply;
      if (!playerExists.get(playerId)) return reply.code(404).send({ error: "player_not_found" });
      const result = upsert.run(request.params.board, playerId, request.body.score, now());
      const entry = one.get(request.params.board, playerId) as ScoreRow | undefined;
      return { improved: Number(result.changes) > 0, entry: entry ? toEntry(entry) : null };
    },
  );

  app.get<{ Params: { board: string }; Querystring: { limit: number; offset: number } }>(
    "/v1/leaderboards/:board",
    {
      schema: {
        params: boardParams,
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
      },
    },
    async (request) => {
      const { board } = request.params;
      const rows = top.all(board, request.query.limit, request.query.offset) as unknown as ScoreRow[];
      const total = (count.get(board) as { n: number }).n;
      return { board, total, entries: rows.map(toEntry) };
    },
  );

  app.get<{ Params: { board: string; playerId: string } }>(
    "/v1/leaderboards/:board/players/:playerId",
    {
      schema: {
        params: {
          type: "object",
          required: ["board", "playerId"],
          properties: { ...boardParams.properties, playerId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const { board, playerId } = request.params;
      const row = one.get(board, playerId) as ScoreRow | undefined;
      if (!row) return reply.code(404).send({ error: "not_found" });
      return toEntry(row);
    },
  );
}
