import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyServerOptions } from "fastify";
import type { Config } from "./config.js";
import { originMatcher } from "./cors.js";
import { type Db, openDb } from "./db.js";
import authRoutes from "./routes/auth.js";
import itchRoutes from "./routes/itch.js";
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

  // Game clients (UE engine HTTP, browser fetch) often send a Content-Type on body-less POST/DELETE, or a type
  // Fastify doesn't know. Accept an empty JSON body, and ignore bodies of unknown types (schemas still validate).
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    const text = (body as string).trim();
    if (!text) return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(Object.assign(new Error("Body is not valid JSON"), { statusCode: 400 }), undefined);
    }
  });
  app.addContentTypeParser("*", { parseAs: "string" }, (_request, _body, done) => done(null, undefined));

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
  await app.register(itchRoutes);
  await app.register(serverRoutes);
  await app.register(leaderboardRoutes);
  await app.register(saveRoutes);

  return app;
}
