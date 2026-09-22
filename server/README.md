# Agent proxy (issue #22)

Zero-dependency Node service that turns a player strategy + compressed game
state into tower-defense actions via DeepSeek. It exists for two reasons:

- the provider key must never reach the browser;
- player browsers in mainland China cannot reach the provider directly, only the
  server can (`docs/PRODUCT_CONCEPT.md` §14).

No framework is used because the backend stack is not chosen yet.

## Run locally

```bash
npm run server     # listens on 127.0.0.1:8787 by default
npm run dev        # Vite dev server proxies /api -> 127.0.0.1:8787
```

Then open the Vite URL (default http://localhost:5173/). Without a key,
`/api/health` still answers and `/api/agent/decide` returns
`PROVIDER_NOT_CONFIGURED`. To exercise the real provider, put a key in `.env`
(never commit it).

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | Provider key. Ops sets this in the systemd `EnvironmentFile`. |
| `AGENT_PROXY_PORT` | `8787` | Listen port. |
| `AGENT_PROXY_HOST` | `127.0.0.1` | Bind address. Keep loopback; nginx terminates TLS. |
| `AGENT_PROXY_ALLOWED_ORIGIN` | empty | Dev-only CORS origin. Leave empty in production. |

## API

```
GET  /api/health          -> { ok, providerConfigured }
POST /api/agent/decide
     { strategy, state }  -> { ok: true,  actions: [{ name, arguments }], usage }
                          | { ok: false, error, message }
```

The system prompt and the tool schema live in `agentProxy.js` and are never sent
by the client, so a tampered client cannot see or widen them. The player's
strategy is placed in the user message only — it is never concatenated into the
system prompt (`AGENTS.md`: system instructions and player text stay separate).

## Production

nginx reverse-proxies `/api/` to this service and rate-limits that location;
systemd owns the process and the key:

```ini
[Service]
EnvironmentFile=/etc/prompt-defense/agent-proxy.env
ExecStart=/usr/bin/node /srv/prompt-defense/server/index.js
```

Builds do not run on the server (`docs/PRODUCT_CONCEPT.md` §14): only the static
`dist/` output and this service are deployed.

## Tests

```bash
node tests/agent/proxy.test.js
```

No network: the provider is replaced by a fake `fetch`, so these cover request
validation, system/player separation, action normalization, error mapping and
rate limiting.
