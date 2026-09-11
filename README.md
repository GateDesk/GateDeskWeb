# GateDeskWeb

Web console for GateDesk remote assistance — customer/operator pages, device-centric state machine, chat & control signaling, plus start.sh / start-client.sh launchers.

## Overview

Two roles work through two web pages against one Node service (`server.js`, in-memory state):

- **Customer (用户端 / 受控方)** — `public/employee.html` reads the local GateDesk ID and registers it automatically (no manual ID entry), then asks for help with one click.
- **Operator (运维端 / 控制方)** — `public/admin.html` lists customer devices, starts / force-controls a remote session, and chats.

Control itself happens in the native GateDesk client, driven through its local HTTP API on `127.0.0.1:21120`.

## Quick start

**Operator machine** — one service set:

```sh
./start.sh
```

It ensures an `api-token` in the GateDesk config, launches GateDesk, starts `server.js` (default `PORT=3000`) with `API_TOKEN` set, mints one-time launch tickets, prints both URLs, and opens the operator console. Mode override: `./start.sh employee|admin|both`.

**Customer machine** — lightweight launcher:

```sh
./start-client.sh <api-token> [server-ip]
```

Writes the shared token into the local GateDesk config, starts GateDesk, mints its own ticket from the operator's server, and opens the customer page pointed at the operator machine (default `server-ip=127.0.0.1` for single-machine debugging).

See `GateDesk_客户端集成设计方案1.2.md` for the design (roles, state machine, REST/WS contract, PoC simplifications).

## Operation-level audit (closed loop)

The desktop client records operation-level audit events (connect / voice / recording / privacy / input lock / restart / auth) and, when `[options] audit-server-url` is set, forwards each one with a plain `POST` (`Content-Type: application/json`, single JSON object) to that URL. Both `start.sh` and `start-client.sh` write this option automatically:

| Machine | `audit-server-url` |
|---------|--------------------|
| Operator (runs `server.js`) | `http://localhost:${PORT}/api/audit` |
| Customer | `http://<operator-ip>:${PORT}/api/audit` |

Endpoints on this service:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/audit` | Receives events — single object, array, or JSON Lines. Entries without an `action` are rejected (`400`). |
| `GET` | `/api/audit` | Query: `?action=`, `?deviceId=`, `?limit=` (default 200). |
| `POST` | `/api/audit/clear` | Reset the in-memory buffer (tests / demos). |
| `GET` | `/audit` | Live dashboard (`public/audit.html`) — filter, count-by-action, optional 3s auto-refresh. |

Every machine also keeps a local JSON-Lines fallback at `<log dir>/audit.log`, so events survive an audit-server outage.

Self-contained closed-loop test (starts its own `server.js` on `TEST_PORT`, default 3210, posts desktop-shaped payloads, asserts the query results, then shuts it down):

```sh
npm ci
npm run audit:selftest
```

## Notes

- `api-token` is cached at GateDesk startup — after the first token write, restart GateDesk before re-running.
- macOS path for the GateDesk config: `~/Library/Preferences/com.carriez.GateDesk/GateDesk2.toml`.
- **Auth model**: the `api-token` never appears in a URL or browser history. `start.sh` / `start-client.sh` mint a single-use, 5-minute launch ticket (`POST /api/launch`); the page exchanges it for an HttpOnly session cookie (`POST /api/auth/exchange`), then fetches the token in memory via `GET /api/me`. Refreshing keeps the session via the cookie.
- PoC scope: `/api/launch` is unauthenticated (anyone on the LAN can open the pages — acceptable since the token only reaches each machine's loopback `127.0.0.1:21120`), roles are still front-end declared, and the REST/WS control plane is not session-gated. Production hardening (real auth on launch, TLS, per-device tokens) is future work.

