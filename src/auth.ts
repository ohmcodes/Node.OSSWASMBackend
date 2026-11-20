import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface PlayerClaims {
  typ: "player";
  sub: string;
  name: string;
}

export interface JoinTicketClaims {
  typ: "join";
  sub: string;
  name: string;
  sid: string;
  jti: string;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: PlayerClaims | JoinTicketClaims;
    user: PlayerClaims;
  }
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by requireServer: the authenticated dedicated server id. */
    serverId?: string;
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** preHandler: requires "Authorization: Bearer <player token>". */
export async function requirePlayer(request: FastifyRequest, reply: FastifyReply) {
  try {
    const claims = await request.jwtVerify<PlayerClaims | JoinTicketClaims>();
    if (claims.typ !== "player") throw new Error("wrong token type");
    request.user = claims;
  } catch {
    return reply.code(401).send({ error: "unauthorized", message: "A valid player token is required." });
  }
}

export function serverTokenHeader(request: FastifyRequest): string | undefined {
  const value = request.headers["x-server-token"];
  return typeof value === "string" && value ? value : undefined;
}

export function serverKeyHeader(request: FastifyRequest): string | undefined {
  const value = request.headers["x-server-key"];
  return typeof value === "string" && value ? value : undefined;
}
