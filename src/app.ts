import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyServerOptions } from "fastify";
import type { Config } from "./config.js";
import { originMatcher } from "./cors.js";
import { type Db, openDb } from "./db.js";
import authRoutes from "./routes/auth.js";
import leaderboardRoutes from "./routes/leaderboards.js";
import saveRoutes from "./routes/saves.js";
import serverRoutes from "./routes/servers.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    config: Config;
  }
}

export const VERSION = "0.1.0";

export async function buildApp(config: Config, options: FastifyServerOptions = {}) {
  const app = Fastify({ trustProxy: config.trustProxy, ...options });
  const db = openDb(config.databasePath);
  app.decorate("db", db);
  app.decorate("config", config);
  app.addHook("onClose", async () => db.close());

  const allowOrigin = originMatcher(config.allowedOrigins);
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || allowOrigin(origin)),
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Server-Key", "X-Server-Token", "X-Server-Id"],
    maxAge: 600,
  });
  await app.register(rateLimit, { max: config.rateLimitPerMinute, timeWindow: "1 minute" });
  await app.register(jwt, { secret: config.jwtSecret });

  app.get("/health", async () => ({ ok: true, version: VERSION }));

  await app.register(authRoutes);
  await app.register(serverRoutes);
  await app.register(leaderboardRoutes);
  await app.register(saveRoutes);

  return app;
}
