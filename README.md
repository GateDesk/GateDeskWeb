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
| `POST` | `/api/event` | Receives one outbound event notification from a controlled machine (`{"event","device_id","session_id","peer_id","ts","extra"}`) and broadcasts it over WebSocket to that device's room. `400` without `device_id` or `event`. See “Outbound event notification” below. |
| `GET` | `/api/event` | Query: `?deviceId=`, `?limit=` (default 50). In-memory only — for smoke-testing and debugging, not a record. |

Every machine also keeps a local JSON-Lines fallback at `<log dir>/audit.log`, so events survive an audit-server outage.

## Outbound event notification (interface doc §6.10)

Polling `GET /sessions` on the local API (127.0.0.1:21120) is how a page discovers that a peer is waiting to be let in or is asking for a permission. That works, but the decision window for a control request is **60 seconds**, so a slow poll can miss it outright.

The controlled machine can instead *push*. With `[options] event-server-url = 'http://<operator-ip>:${PORT}/api/event'` set, the desktop posts a small hint (`login.pending`, `control.pending`, `session.open`, `session.close`) the moment the state changes; this service broadcasts it to the browsers of that device, and the pages immediately re-read `/sessions`.

Three things worth knowing before relying on it:

- **It is a hint, not state.** A notification can be dropped, duplicated or arrive after the request was already answered by hand. The pages always go back to `GET /sessions`; the notification only decides *when* they look.
- **Nothing is sent until the option is set.** It is empty by default and the `start*.sh` scripts do not write it — set it by hand on the controlled machine (and restart GateDesk). No option, no events, and the pages fall back to plain polling.
- **It is not the audit trail.** `/api/audit` is the record (retried, with a local fallback); `/api/event` is a doorbell (3 second cap, no retry, nothing on disk).

Because a page cannot tell whether the machine it talks to has the option set, both pages poll at **2 seconds** until they have seen at least one event, then relax to **30 seconds**. So an unconfigured machine behaves exactly as before.

Self-contained check that does not need a desktop client:

```bash
curl -X POST "http://localhost:${PORT}/api/event" -H 'Content-Type: application/json' \
  -d '{"event":"control.pending","device_id":"123456789","session_id":3,"peer_id":"987654321","ts":0,"extra":{"permission":""}}'
curl "http://localhost:${PORT}/api/event?limit=10"
```


```sh
npm ci
npm run audit:selftest
```

## Notes

- `api-token` is cached at GateDesk startup — after the first token write, restart GateDesk before re-running.
- macOS path for the GateDesk config: `~/Library/Preferences/com.carriez.GateDesk/GateDesk2.toml`.
- **Auth model**: the `api-token` never appears in a URL or browser history. `start.sh` / `start-client.sh` mint a single-use, 5-minute launch ticket (`POST /api/launch`); the page exchanges it for an HttpOnly session cookie (`POST /api/auth/exchange`), then fetches the token in memory via `GET /api/me`. Refreshing keeps the session via the cookie.
- PoC scope: `/api/launch` is unauthenticated (anyone on the LAN can open the pages — acceptable since the token only reaches each machine's loopback `127.0.0.1:21120`), roles are still front-end declared, and the REST/WS control plane is not session-gated. Production hardening (real auth on launch, TLS, per-device tokens) is future work.

