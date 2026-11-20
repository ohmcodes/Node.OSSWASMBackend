import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requirePlayer, sha256 } from "../auth.js";
import { now } from "../db.js";
import { randomGuestName, sanitizeDisplayName } from "../names.js";

interface PlayerRow {
  id: string;
  display_name: string;
  created_at: number;
}

const displayName = { type: "string", minLength: 1, maxLength: 32 } as const;

export default async function authRoutes(app: FastifyInstance) {
  const { db, config } = app;

  const findByDevice = db.prepare("SELECT id, display_name, created_at FROM players WHERE device_hash = ?");
  const findById = db.prepare("SELECT id, display_name, created_at FROM players WHERE id = ?");
  const insert = db.prepare(
    "INSERT INTO players (id, display_name, device_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
  );
  const touch = db.prepare("UPDATE players SET last_seen_at = ? WHERE id = ?");
  const rename = db.prepare("UPDATE players SET display_name = ? WHERE id = ?");

  const issue = (row: PlayerRow) => ({
    token: app.jwt.sign(
      { typ: "player", sub: row.id, name: row.display_name },
      { expiresIn: config.playerTokenTtl },
    ),
    expiresIn: config.playerTokenTtl,
    player: { id: row.id, displayName: row.display_name, createdAt: row.created_at },
  });

  /**
   * Guest login. The client sends a stable deviceId (browser: random id kept in browser storage;
   * PC: derived from the machine), so the same browser / PC gets the same player back.
   * New players get a random friendly name ("SwiftOtter4821") unless they send one.
   * Names are sanitized; a name that is empty after cleaning is ignored.
   */
  app.post<{ Body: { deviceId?: string; displayName?: string } }>(
    "/v1/auth/guest",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            deviceId: { type: "string", minLength: 16, maxLength: 128 },
            displayName,
          },
        },
      },
    },
    async (request) => {
      const { deviceId, displayName: rawName } = request.body ?? {};
      const name = rawName ? sanitizeDisplayName(rawName) || undefined : undefined;
      const deviceHash = deviceId ? sha256(deviceId) : null;

      let row = deviceHash ? (findByDevice.get(deviceHash) as PlayerRow | undefined) : undefined;
      if (row) {
        touch.run(now(), row.id);
        if (name && name !== row.display_name) {
          rename.run(name, row.id);
          row = { ...row, display_name: name };
        }
      } else {
        const id = randomUUID();
        const t = now();
        const finalName = name ?? randomGuestName();
        insert.run(id, finalName, deviceHash, t, t);
        row = { id, display_name: finalName, created_at: t };
      }
      return issue(row);
    },
  );

  app.get("/v1/me", { preHandler: requirePlayer }, async (request, reply) => {
    const row = findById.get(request.user.sub) as PlayerRow | undefined;
    if (!row) return reply.code(404).send({ error: "not_found" });
    return { id: row.id, displayName: row.display_name, createdAt: row.created_at };
  });

  /** Rename and get a fresh token carrying the new name. */
  app.patch<{ Body: { displayName: string } }>(
    "/v1/me",
    {
      preHandler: requirePlayer,
      schema: {
        body: {
          type: "object",
          required: ["displayName"],
          additionalProperties: false,
          properties: { displayName },
        },
      },
    },
    async (request, reply) => {
      const clean = sanitizeDisplayName(request.body.displayName);
      if (!clean) return reply.code(400).send({ error: "bad_request", message: "Display name is empty after removing invalid characters." });
      rename.run(clean, request.user.sub);
      const row = findById.get(request.user.sub) as PlayerRow | undefined;
      if (!row) return reply.code(404).send({ error: "not_found" });
      return issue(row);
    },
  );
}
