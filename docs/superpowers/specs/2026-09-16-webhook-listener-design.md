# Webhook Listener — Design Spec

Date: 2026-09-16

## Purpose

A self-hosted, dockerized service (similar to webhook.site / RequestBin) that lets a
user create a unique webhook endpoint via a web UI, send payloads to that endpoint
from any external system, and view the history of received payloads in the UI.

## User flow

1. Visit the web page.
2. Click "create new webhook listener" → a UUID-scoped endpoint is generated.
3. The endpoint immediately starts accepting requests and responds `200 OK`.
4. Payloads sent to the endpoint are captured and stored.
5. The web page shows the history of payloads received for that listener, updating
   automatically while the page is open (polling).
6. The user can delete a listener (and its history) when done with it.

## Access model

No authentication. The UUID in the listener's URL is the access control — anyone
with the URL can view or delete that listener, matching tools like webhook.site.
Not intended for public internet exposure of sensitive data.

## Architecture

Two containers, orchestrated via `docker-compose.yml`:

- **backend** — Node.js + TypeScript + Fastify. Owns all business logic and the
  SQLite database (`better-sqlite3`). Exposes a REST API and the raw webhook
  capture route. The SQLite file lives on a named Docker volume so history
  survives container restarts.
- **frontend** — React + Vite, built to static assets and served by Nginx. Nginx
  reverse-proxies `/api/*` and `/hook/*` to the backend service, so the browser
  only ever talks to one origin (no CORS configuration needed). This is the only
  container exposed to the host.

```
Browser → Nginx (frontend container, port 8080→80)
             ├── / and static assets → served directly
             ├── /api/*  → proxy_pass → backend:PORT
             └── /hook/* → proxy_pass → backend:PORT
Backend (Node/Fastify) → SQLite file on named volume
```

## Data model (SQLite)

```sql
CREATE TABLE listeners (
  id TEXT PRIMARY KEY,           -- UUID v4
  created_at TEXT NOT NULL       -- ISO 8601
);

CREATE TABLE requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listener_id TEXT NOT NULL REFERENCES listeners(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  headers TEXT NOT NULL,         -- JSON-encoded object
  query_params TEXT NOT NULL,    -- JSON-encoded object
  body TEXT,                     -- raw body as received (may be empty)
  content_type TEXT,
  source_ip TEXT,
  received_at TEXT NOT NULL      -- ISO 8601
);

CREATE INDEX idx_requests_listener_received
  ON requests(listener_id, received_at DESC);
```

**Retention:** after each insert into `requests`, delete rows for that
`listener_id` beyond the most recent 200 (ordered by `received_at DESC`), keeping
the table bounded with no separate cleanup job. Listeners themselves are never
auto-expired — deletion is manual only (see API).

## API (backend)

All JSON unless noted.

| Method | Path | Description |
|---|---|---|
| POST | `/api/listeners` | Create a listener. Returns `{ id, hookUrl }`. |
| GET | `/api/listeners/:id` | Listener metadata. 404 if not found. |
| GET | `/api/listeners/:id/requests` | Recent captured requests for the listener, newest first, capped at 200. 404 if listener not found. |
| DELETE | `/api/listeners/:id` | Deletes the listener and all its requests (cascade). |
| ALL | `/hook/:id` | Captures method, headers, query params, raw body, and source IP for any HTTP method. Stores it, then responds `200 OK` with an empty body. Responds `404` if `:id` doesn't correspond to an existing listener. |

`hookUrl` is built from a configurable base URL (env var) + `/hook/:id`, so the
frontend can show a copy-pasteable absolute URL without hardcoding host/port.

## Frontend (React + Vite)

- **Home page** (`/`): "Create new listener" button → `POST /api/listeners` →
  redirect to `/listener/:id`.
- **Listener page** (`/listener/:id`):
  - Shows the webhook URL with a copy-to-clipboard button.
  - Delete button (with confirmation) → `DELETE /api/listeners/:id` → redirect home.
  - List of received payloads, polling `GET /api/listeners/:id/requests` every 3
    seconds while the page is open.
  - Each row shows method, timestamp, and content-type at a glance; expands to
    show full headers, query params, and body (pretty-printed if valid JSON).

## Error handling

- Backend: standard Fastify error responses (`400`/`404`/`500` with a JSON error
  body); `/hook/:id` always returns `200` for a valid listener id regardless of
  payload shape — the whole point is to accept anything.
- Frontend: shows an inline error state if a fetch fails (e.g. listener not
  found, network error), and stops polling on repeated 404 (listener was
  deleted).

## Testing

- **Backend unit tests** (Vitest): listener creation/lookup/deletion, request
  capture (`/hook/:id` for various methods/content-types), and the 200-row
  retention cap.
- **Manual/E2E via Docker**: `docker compose up`, then:
  ```
  curl -X POST http://localhost:8080/api/listeners
  curl -X POST http://localhost:8080/hook/<id> -H 'Content-Type: application/json' -d '{"foo":"bar"}'
  ```
  Confirm the payload appears in the UI within ~3s, and confirm the payload
  survives `docker compose restart backend` (volume persistence check).

## Out of scope (explicitly not building)

- Authentication / multi-user accounts.
- Real-time push (SSE/WebSockets) — polling is sufficient for this tool's scope.
- Listener expiry/TTL — only manual deletion.
- Cloud-specific deployment config — local `docker compose up` is the only
  deployment target for this iteration.
