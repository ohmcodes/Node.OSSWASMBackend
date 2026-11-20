import { randomBytes } from "node:crypto";

export interface Config {
  host: string;
  port: number;
  production: boolean;
  /** Path to the SQLite file, or ":memory:" (tests). */
  databasePath: string;
  jwtSecret: string;
  /** Lifetime of a guest player token, in seconds. */
  playerTokenTtl: number;
  /** Keys a dedicated server must send (x-server-key) to register. */
  serverKeys: string[];
  /** A server disappears from the list when it hasn't sent a heartbeat for this many seconds. */
  serverTtl: number;
  /** Lifetime of a join ticket, in seconds. */
  joinTicketTtl: number;
  /** Origin patterns allowed by CORS. "*" matches any characters, e.g. https://*.itch.zone */
  allowedOrigins: string[];
  /** Let players post their own scores (easy, but cheatable). Servers can always post. */
  clientScoreSubmit: boolean;
  maxSaveBytes: number;
  rateLimitPerMinute: number;
  /** Set when running behind Nginx Proxy Manager / Cloudflare Tunnel so client IPs are correct. */
  trustProxy: boolean;
}

export const DEFAULT_ALLOWED_ORIGINS = [
  "https://itch.io",
  "https://*.itch.io",
  "https://*.itch.zone",
  "https://*.hwcdn.net",
  "http://localhost:*",
  "http://127.0.0.1:*",
];

function list(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const n = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const production = env.NODE_ENV === "production";
  const warnings: string[] = [];

  let jwtSecret = env.JWT_SECRET ?? "";
  if (!jwtSecret) {
    if (production) throw new Error("JWT_SECRET must be set when NODE_ENV=production");
    jwtSecret = randomBytes(32).toString("hex");
    warnings.push("JWT_SECRET not set: using a random secret, player tokens reset on restart.");
  }

  let serverKeys = list(env.SERVER_KEYS) ?? [];
  if (serverKeys.length === 0) {
    if (production) throw new Error("SERVER_KEYS must be set when NODE_ENV=production");
    serverKeys = ["dev-server-key"];
    warnings.push('SERVER_KEYS not set: dedicated servers can register with "dev-server-key".');
  }

  const config: Config = {
    host: env.HOST ?? "0.0.0.0",
    port: int(env.PORT, 3000),
    production,
    databasePath: env.DATABASE_PATH ?? "./data/osswasm.db",
    jwtSecret,
    playerTokenTtl: int(env.PLAYER_TOKEN_TTL_SECONDS, 60 * 60 * 24 * 30),
    serverKeys,
    serverTtl: int(env.SERVER_TTL_SECONDS, 30),
    joinTicketTtl: int(env.JOIN_TICKET_TTL_SECONDS, 60),
    allowedOrigins: list(env.ALLOWED_ORIGINS) ?? DEFAULT_ALLOWED_ORIGINS,
    clientScoreSubmit: bool(env.CLIENT_SCORE_SUBMIT, true),
    maxSaveBytes: int(env.MAX_SAVE_BYTES, 1024 * 1024),
    rateLimitPerMinute: int(env.RATE_LIMIT_PER_MINUTE, 300),
    trustProxy: bool(env.TRUST_PROXY, false),
    ...overrides,
  };

  for (const w of warnings) console.warn(`[config] ${w}`);
  return config;
}
