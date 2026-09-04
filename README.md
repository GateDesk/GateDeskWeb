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

It ensures an `api-token` in the GateDesk config, launches GateDesk, starts `server.js` (default `PORT=3000`), prints both URLs, and opens the operator console. Mode override: `./start.sh employee|admin|both`.

**Customer machine** — lightweight launcher:

```sh
./start-client.sh <api-token> [server-ip]
```

Writes the shared token into the local GateDesk config, starts GateDesk, and opens the customer page pointed at the operator machine (default `server-ip=127.0.0.1` for single-machine debugging).

See `GateDesk_客户端集成设计方案1.2.md` for the design (roles, state machine, REST/WS contract, PoC simplifications).

## Notes

- `api-token` is cached at GateDesk startup — after the first token write, restart GateDesk before re-running.
- macOS path for the GateDesk config: `~/Library/Preferences/com.carriez.GateDesk/GateDesk2.toml`.
- PoC scope: in-memory state, no auth/rate-limit/audit yet.
