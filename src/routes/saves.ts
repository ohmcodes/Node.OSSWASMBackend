import type { FastifyInstance } from "fastify";
import { requirePlayer } from "../auth.js";
import { now } from "../db.js";

const slotParams = {
  type: "object",
  required: ["slot"],
  properties: { slot: { type: "string", pattern: "^[A-Za-z0-9_.-]{1,64}$" } },
} as const;

/**
 * Per-player cloud save slots. `data` is an opaque string; the UE plugin sends a USaveGame
 * serialized to bytes and base64-encoded.
 */
export default async function saveRoutes(app: FastifyInstance) {
  const { db, config } = app;

  const list = db.prepare("SELECT slot, length(data) AS size, updated_at FROM saves WHERE player_id = ? ORDER BY slot");
  const get = db.prepare("SELECT data, updated_at FROM saves WHERE player_id = ? AND slot = ?");
  const put = db.prepare(`
    INSERT INTO saves (player_id, slot, data, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (player_id, slot) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`);
  const del = db.prepare("DELETE FROM saves WHERE player_id = ? AND slot = ?");

  app.get("/v1/saves", { preHandler: requirePlayer }, async (request) => {
    const rows = list.all(request.user.sub) as { slot: string; size: number; updated_at: number }[];
    return { slots: rows.map((r) => ({ slot: r.slot, size: r.size, updatedAt: r.updated_at })) };
  });

  app.get<{ Params: { slot: string } }>(
    "/v1/saves/:slot",
    { preHandler: requirePlayer, schema: { params: slotParams } },
    async (request, reply) => {
      const row = get.get(request.user.sub, request.params.slot) as { data: string; updated_at: number } | undefined;
      if (!row) return reply.code(404).send({ error: "not_found" });
      return { slot: request.params.slot, data: row.data, updatedAt: row.updated_at };
    },
  );

  app.put<{ Params: { slot: string }; Body: { data: string } }>(
    "/v1/saves/:slot",
    {
      preHandler: requirePlayer,
      bodyLimit: config.maxSaveBytes + 1024,
      schema: {
        params: slotParams,
        body: {
          type: "object",
          required: ["data"],
          additionalProperties: false,
          properties: { data: { type: "string", maxLength: config.maxSaveBytes } },
        },
      },
    },
    async (request) => {
      const t = now();
      put.run(request.user.sub, request.params.slot, request.body.data, t);
      return { slot: request.params.slot, updatedAt: t };
    },
  );

  app.delete<{ Params: { slot: string } }>(
    "/v1/saves/:slot",
    { preHandler: requirePlayer, schema: { params: slotParams } },
    async (request, reply) => {
      del.run(request.user.sub, request.params.slot);
      return reply.code(204).send();
    },
  );
}
