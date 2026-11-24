# OSSWASM Backend

Self-hostable backend for the **OnlineSubsystemWASM** Unreal Engine 5.9 plugin ([UE59.OSSWASM](https://github.com/ohmcodes/UE59.OSSWASM)).
Each game developer runs their own copy on their own server and domain.

- **Server list** – dedicated servers register, send heartbeats, and disappear when they stop.
- **Guest login** – one player per browser/device, JWT tokens.
- **Join tickets** – one-time tickets the dedicated server checks when a player connects.
- **Leaderboards** – best score per player, ranked.
- **Cloud saves** – per-player save slots.
- CORS preset for itch.io (`*.itch.zone`, `*.hwcdn.net`) and localhost. SQLite storage, no other services needed.

Deploying (plain Docker, Portainer, TrueNAS SCALE, HTTPS): **[docs/01-deploy-backend.md](docs/01-deploy-backend.md)**

## Run locally

```powershell
npm install
npm run dev        # http://localhost:3000, dev defaults: random JWT secret, server key "dev-server-key"
```

```powershell
./scripts/test-backend.ps1   # typecheck + tests, summary in scripts/out/test-backend.summary.txt
```

## Configuration (environment variables)

| Variable | Default | Notes |
|---|---|---|
| `JWT_SECRET` | random (dev only) | **Required in production.** Signs player tokens and join tickets. |
| `SERVER_KEYS` | `dev-server-key` (dev only) | **Required in production.** Comma-separated keys dedicated servers use to register. |
| `ALLOWED_ORIGINS` | itch.io, `*.itch.zone`, `*.hwcdn.net`, localhost | Comma-separated, `*` wildcard. Add your own site if you host the web build elsewhere. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | |
| `DATABASE_PATH` | `./data/osswasm.db` (`/data/osswasm.db` in Docker) | SQLite file. |
| `TRUST_PROXY` | `false` (`true` in compose) | Set when behind a reverse proxy or tunnel. |
| `CLIENT_SCORE_SUBMIT` | `true` | `false` = only dedicated servers can post scores (anti-cheat). |
| `SERVER_TTL_SECONDS` | `30` | Server removed from the list after this long without a heartbeat. |
| `PLAYER_TOKEN_TTL_SECONDS` | `2592000` (30 days) | |
| `JOIN_TICKET_TTL_SECONDS` | `60` | |
| `ITCH_CLIENT_ID` | empty = off | itch.io OAuth app client id (public; PKCE, no secret). Turns on `/v1/auth/itch/*`. |
| `PUBLIC_URL` | `http://localhost:<PORT>` | Public https address of this backend. The itch.io redirect URI is `<PUBLIC_URL>/v1/auth/itch/callback` (or set `ITCH_REDIRECT_URI`). |
| `ITCH_LOGIN_TTL_SECONDS` | `600` | How long a started itch.io login may take. |
| `MAX_SAVE_BYTES` | `1048576` | Max size of one save slot. |
| `RATE_LIMIT_PER_MINUTE` | `300` | Per IP. |
| `LOG_LEVEL` | `info` | |

## API (v1)

Auth headers: players send `Authorization: Bearer <token>`; dedicated servers send `x-server-key` (register) or `x-server-token` (everything after).

### Players
| Method | Path | Auth | Body → Response |
|---|---|---|---|
| POST | `/v1/auth/guest` | – | `{deviceId?, displayName?}` → `{token, expiresIn, player:{id, displayName, createdAt}}`. Same `deviceId` returns the same player. |
| GET | `/v1/auth/providers` | – | → `{providers:[{name:"guest"},{name:"itch",label}]}` (itch only when `ITCH_CLIENT_ID` is set) |
| POST | `/v1/auth/itch/start` | – | → `{authorizeUrl, pollId, expiresIn}`. The game opens `authorizeUrl` in a browser tab. 501 when itch is off. |
| GET | `/v1/auth/itch/status/:pollId` | – | → `{status:"pending"}`, or once `{status:"done", token, expiresIn, player}`, or `{status:"error", message}`. 404 when unknown/expired. |
| GET | `/v1/auth/itch/callback` | – | itch.io redirects the player's browser here (`code`, `state`); shows a small "you can close this window" page. |
| GET | `/v1/me` | player | → `{id, displayName, createdAt}` |
| PATCH | `/v1/me` | player | `{displayName}` → new `{token, player}` |

### Server list
| Method | Path | Auth | Body → Response |
|---|---|---|---|
| POST | `/v1/servers/register` | `x-server-key` | `{name, version, connectUrl (UDP host:port such as 203.0.113.5:7777, or a ws:// / wss:// URL), maxPlayers, region?, map?, mode?, players?, state?, metadata?}` → `{serverId, serverToken, heartbeatIntervalSeconds, ttlSeconds}` |
| POST | `/v1/servers/:id/heartbeat` | `x-server-token` | `{players?, state?, map?, mode?, name?, region?, maxPlayers?, metadata?}` → `{ok}` |
| DELETE | `/v1/servers/:id` | `x-server-token` | → 204 |
| POST | `/v1/servers/:id/verify-ticket` | `x-server-token` | `{ticket}` → `{valid, playerId, displayName}` or `{valid:false, reason}` |
| GET | `/v1/servers?version=&region=&includeFull=` | – | → `{servers:[{id, name, region, map, mode, version, connectUrl, players, maxPlayers, state, metadata, lastHeartbeat}]}` |
| GET | `/v1/servers/:id` | – | → one server |
| POST | `/v1/servers/:id/join` | player | → `{connectUrl, ticket, expiresIn}`; 409 if full |

`state` is one of `open`, `in_progress`, `full`, `closed`.

### Leaderboards (`:board` = `[A-Za-z0-9_.-]{1,64}`, higher score wins)
| Method | Path | Auth | Body → Response |
|---|---|---|---|
| POST | `/v1/leaderboards/:board/scores` | player, or `x-server-id` + `x-server-token` | `{score, playerId (server only)}` → `{improved, entry}` |
| GET | `/v1/leaderboards/:board?limit=10&offset=0` | – | → `{board, total, entries:[{rank, playerId, displayName, score, updatedAt}]}` |
| GET | `/v1/leaderboards/:board/players/:playerId` | – | → entry |

### Cloud saves (`:slot` = `[A-Za-z0-9_.-]{1,64}`)
| Method | Path | Auth | Body → Response |
|---|---|---|---|
| GET | `/v1/saves` | player | → `{slots:[{slot, size, updatedAt}]}` |
| GET | `/v1/saves/:slot` | player | → `{slot, data, updatedAt}` |
| PUT | `/v1/saves/:slot` | player | `{data}` (string, base64 for binary) → `{slot, updatedAt}` |
| DELETE | `/v1/saves/:slot` | player | → 204 |

### Other
`GET /health` → `{ok, version}`

## License
MIT
