# 01 – Deploy the OSSWASM backend

The backend is one Docker container with a SQLite database on a volume. You run your own copy on your own server and domain.
Only the backend runs in Docker. Dedicated game servers run elsewhere (for now: on Windows) and register with it.

Contents:
1. [Test on localhost first](#1-test-on-localhost-first)
2. [Prepare your settings](#2-prepare-your-settings)
3. Install with one of: [plain Docker](#3a-plain-docker-any-linux), [Portainer](#3b-portainer), [TrueNAS SCALE](#3c-truenas-scale)
4. [HTTPS: why you need it and how](#4-https)
5. [Check it works](#5-check-it-works)
6. [Updating and backups](#6-updating-and-backups)

---

## 1. Test on localhost first

Before deploying anywhere, run it on your PC. Needs Node.js 20+.

```powershell
git clone https://github.com/ohmcodes/Node.OSSWASMBackend.git
cd Node.OSSWASMBackend
npm install
npm run dev
```

It listens on `http://localhost:3000`. In dev mode it uses a random token secret and the server key `dev-server-key`.
Browsers treat `localhost` as secure, so a web build served from `http://localhost:8080` can call it without HTTPS.

Check it:

```powershell
Invoke-RestMethod http://localhost:3000/health
```

## 2. Prepare your settings

You need two secrets. Generate each with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

| Variable | What to put |
|---|---|
| `JWT_SECRET` | A generated secret. Keep it the same forever, or all players get logged out. |
| `SERVER_KEYS` | A generated secret. Your dedicated servers start with `-ServerKey=<this>`. Several keys can be comma-separated. |
| `ALLOWED_ORIGINS` | Leave empty for itch.io + localhost. Add your own site if you host the web build yourself, e.g. `https://play.mygame.com`. |
| `HOST_PORT` | Port on the Docker host, default `3000`. |

Everything else has sensible defaults (see `.env.example` and the README).

## 3a. Plain Docker (any Linux)

```bash
git clone https://github.com/ohmcodes/Node.OSSWASMBackend.git
cd Node.OSSWASMBackend
cp .env.example .env
nano .env                        # fill in JWT_SECRET and SERVER_KEYS
docker compose up -d
docker compose logs -f           # look for "OSSWASM backend ready"
```

To build the image on the machine instead of pulling it:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## 3b. Portainer

1. **Stacks → Add stack**, name it `osswasm-backend`.
2. Choose **Web editor** and paste the contents of [`docker-compose.yml`](../docker-compose.yml).
   (Or choose **Repository** with `https://github.com/ohmcodes/Node.OSSWASMBackend` and compose path `docker-compose.yml`.)
3. Under **Environment variables**, add `JWT_SECRET` and `SERVER_KEYS` (and optionally `ALLOWED_ORIGINS`, `HOST_PORT`).
4. **Deploy the stack.**
5. Open the container's **Logs** and look for `OSSWASM backend ready`.

## 3c. TrueNAS SCALE

TrueNAS SCALE 24.10 and later run apps on Docker and accept compose YAML.

1. **Apps → Discover Apps → ⋮ (top right) → Install via YAML.**
2. Name: `osswasm-backend`.
3. Paste this, with your own values in place of the `<...>` (the TrueNAS YAML screen has no `.env` file, so values go in directly):

   ```yaml
   services:
     osswasm-backend:
       image: ghcr.io/ohmcodes/osswasm-backend:latest
       restart: unless-stopped
       ports:
         - "3000:3000"
       environment:
         JWT_SECRET: "<your generated secret>"
         SERVER_KEYS: "<your server key>"
         ALLOWED_ORIGINS: ""
         TRUST_PROXY: "true"
       volumes:
         - /mnt/<your-pool>/apps/osswasm:/data
   ```

4. Create the dataset `/mnt/<your-pool>/apps/osswasm` first and make it writable by UID 1000 (the container runs as the `node` user, UID 1000).
5. **Save**, then open the app's logs and look for `OSSWASM backend ready`.

## 4. HTTPS

itch.io pages are HTTPS, and browsers block any `http://` or `ws://` request from an HTTPS page. So players' browsers must reach the backend (and your game servers) through **HTTPS / WSS with a valid certificate**. The backend itself speaks plain HTTP; something in front of it handles the certificate. Pick one:

### Option A – Cloudflare Tunnel (easiest at home)
No port forwarding, hides your home IP, free. Your domain must use Cloudflare DNS.

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** (type *Cloudflared*), name it.
2. Copy the token and run the connector on the same Docker host. In Portainer/compose add this service next to the backend (same stack, so it can reach it by name):

   ```yaml
     cloudflared:
       image: cloudflare/cloudflared:latest
       restart: unless-stopped
       command: tunnel --no-autoupdate run --token ${CLOUDFLARE_TUNNEL_TOKEN}
   ```

3. In the tunnel, add a **Public hostname**: `api.yourdomain.com` → service `http://osswasm-backend:3000`
   (if cloudflared runs outside the stack, use `http://<docker-host-ip>:3000`).
4. Done: `https://api.yourdomain.com/health` should answer.

### Option B – Nginx Proxy Manager
Use this if you already run NPM or prefer opening ports. Forward ports **80 and 443** on your router to the NPM host, and point a DNS `A` record (`api.yourdomain.com`) at your public IP (use dynamic DNS if your IP changes).

1. NPM → **Hosts → Proxy Hosts → Add Proxy Host**.
2. Domain: `api.yourdomain.com`; Scheme `http`; Forward host: Docker host IP (or `osswasm-backend` if on the same Docker network); Port `3000`.
3. Turn on **Websockets Support** and **Block Common Exploits**.
4. **SSL** tab → *Request a new SSL Certificate*, turn on **Force SSL** and **HTTP/2**, agree, save.

Keep `TRUST_PROXY=true` with either option so rate limiting sees real player IPs.

## 5. Check it works

From any machine outside your network (phone on mobile data works):

```bash
curl https://api.yourdomain.com/health
# {"ok":true,"version":"0.1.0"}
```

Register a fake server and list it:

```bash
curl -X POST https://api.yourdomain.com/v1/servers/register \
  -H "content-type: application/json" -H "x-server-key: <your server key>" \
  -d '{"name":"Test","version":"1.0","connectUrl":"wss://game.yourdomain.com","maxPlayers":8}'
curl https://api.yourdomain.com/v1/servers
```

It disappears from the list after 30 seconds (no heartbeats).

Then in the UE project set `BackendUrl=https://api.yourdomain.com` (guide 02).

**Browser errors and what they mean:**

| Console message | Fix |
|---|---|
| `blocked by CORS policy` | Add the page's origin to `ALLOWED_ORIGINS` (check the exact origin in the error). |
| `Mixed Content ... requested an insecure resource 'http://...'` | Use the `https://` URL in `BackendUrl`, and `wss://` for game servers. |
| `ERR_CERT_...` | Certificate not issued yet or wrong domain in NPM/Cloudflare. |

## 6. Updating and backups

- **Update:** Portainer → stack → *Pull and redeploy*; TrueNAS → app → *Update*; plain Docker → `docker compose pull && docker compose up -d`.
- **Backup:** stop the container, copy the database out of the volume, start it again:
  `docker compose stop && docker run --rm -v osswasm-backend_osswasm-data:/data -v "$PWD":/backup alpine cp /data/osswasm.db /backup/ && docker compose start`
  (On TrueNAS, snapshot the dataset instead.)

## 7. Optional: "Log in with itch.io"

Guest login always works. To also let players log in with their itch.io account (same player on every device and
browser, name taken from itch):

1. On itch.io open **Dashboard → Settings → OAuth applications** (itch.io/user/settings/oauth-apps) and create an app.
   - **Redirect URI**: `https://api.yourdomain.com/v1/auth/itch/callback` (your `PUBLIC_URL` + `/v1/auth/itch/callback`;
     it must be https on a real domain). For a local test use `http://localhost:3000/v1/auth/itch/callback` if itch
     accepts it for your app (loopback addresses are allowed).
   - Copy the **Client ID**. There is no client secret: the login uses PKCE.
2. In the backend settings add `ITCH_CLIENT_ID=<client id>` and `PUBLIC_URL=https://api.yourdomain.com`
   (Portainer: Stack → Environment variables), then redeploy.
3. Check `https://api.yourdomain.com/v1/auth/providers`: it must list `itch`.
4. In the game: Project Settings → Plugins → OSS WASM → **Login Providers → Enable Itch Login**, and add
   `Button_ItchLogin` to the main menu (guide 05) or call the *Login With Provider* node with `itch`.

How it works: the game opens itch.io in a new browser tab, the player approves, itch.io sends the browser back to
your backend's callback page, the backend swaps the code for the itch profile (id, name) and gives the game its normal
player token. The game only polls the backend, so there is nothing to host or configure on the game side.
Pending logins live in the backend's memory (10 minutes), so run one backend instance.
