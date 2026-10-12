# Reader Platform — agent notes

## Commands

- `pnpm --filter @reader/api build` — compile the API (`tsc -p tsconfig.json`, output `build/`).
- `pnpm --filter @reader/api test` — compile `tsconfig.test.json` then `node --test` the output in `.tmp/apps-api-test`.
- `pnpm --filter @reader/api dev` — `ts-node-dev --transpile-only`; requires `.env` at repo root.
- `pnpm test` / `pnpm build` — whole-workspace gates.
- `pnpm --filter @reader/worker build` — the worker consumes built `@reader/api/*` subpath exports (`rag`, `ai-usage`, `book-processing`, `rag-shadow`); keep those barrels functional.

## API architecture (apps/api)

NestJS 11 on `@nestjs/platform-express` (Express 5). Entry point stays `src/index.ts` -> `build/index.js` — `Dockerfile.api` depends on it.

- `src/bootstrap.ts` — `createApp()`: CORS -> body parsers -> request logger -> CSRF -> `AllExceptionsFilter` -> swagger at `/api-docs` (JSON: `/api-docs-json`). Keep this order.
- `src/index.ts` — `import "./observability/bootstrap"` must remain the first import (OTel init order).
- Feature modules in `src/{auth,user,health,books,chat,tracker}/`; shared infra in `src/common/` (guards, middleware, filter, decorators) and `src/database/database.module.ts` (`DRIZZLE` token, `@Global`).
- `src/app.module.ts` import order matters: `Books` before `Chat` before `Tracker` (`GET /api/books/*` must beat `GET /api/:rid/progress`; mirrors the old Express mount order). `test/routeInventory.test.ts` enforces the full route set + ordering.

### Rules

- **Always use explicit `@Inject(TOKEN)`** on constructor params. Dev runs `ts-node-dev --transpile-only`, which cannot emit metadata for interface-typed params.
- Preserve response shapes: `throw new HttpException({ error|message: "..." }, status)` — controllers return values, `@HttpCode` for non-200 statuses (Nest defaults POST to 201).
- SSE endpoints use `@Req()`/`@Res()` and raw `res.write` — never `@Sse()`.
- Domain services in `src/services/` stay functional modules (worker/evals import them via `@reader/api/*`).

### Tests

- `node --test` against `tsc` output — no jest/supertest. Use `test/helpers/nestApp.ts` `createTestApp()` + global `fetch`.
- Unit tests do not use live Postgres/Redis: mock the `DRIZZLE` provider (`overrideProvider`/`useValue`). Only `pnpm test:integration:books` starts temporary local containers. Rate-limit guards no-op without `REDIS_URL`; set `process.env.JWT_SECRET ??=` before importing anything that pulls in `AuthService` (env must precede `require()` since imports hoist).

## Clean Architecture (book processing slice)

- The dependency direction is `apps/api` and `apps/worker` → `@reader/application` → `@reader/domain`. Infrastructure adapters live in `apps/api/src/infrastructure/books`; core packages do not import app infrastructure, frameworks, or SDKs.
- Run `pnpm check:architecture` to enforce the domain/application import boundaries.
- Compatibility exports remain available from the existing `@reader/api/*` modules. The worker continues to load book processing through `@reader/api/book-processing`.
- Lifecycle writes are guarded by owner and current processing state; retry and processing share a per-book PostgreSQL advisory lock. Lock sessions share one FIFO capacity limiter per PostgreSQL pool across all adapter instances, defaulting to half the configured maximum (minimum one; default pool maximum ten); later adapters can only lower that capacity. The pool has a 10-second connection timeout and keepalive. A disconnected lock session aborts its callback, waits for in-flight work to settle, retires its connection, and prevents later lifecycle writes; only that attempt's isolated artifacts are cleaned afterward.
- Each ingestion attempt writes to its own collection. A successful publication stores that collection name, clears old/new search caches, and best-effort removes an unreferenced previous collection; failed or lock-lost attempts clean only their own vector collection and search chunks.
- Deletion marks a book `deleting` before best-effort queue removal and resumable cleanup. Artifact reference counts exclude deleting rows so shared legacy files and collections remain available to live books.
- Keep queue names, deterministic job IDs, attempt/backoff defaults, route ordering, response bodies, chunk metadata, default collection naming for existing callers/evals, and worker shutdown behavior unchanged. Lifecycle ingestion uses attempt-scoped collections. `pnpm test:integration:books` runs the lifecycle scenarios against temporary local PostgreSQL and Redis containers.
- Chat POST routes delegate to application use cases. The SSE adapter owns framing, backpressure, disconnect cancellation, and the `[DONE]` marker; keep `chat-stream.ts` compatibility exports as delegates. `pnpm test:integration:chat` reuses the temporary PostgreSQL/Redis harness and exercises real HTTP SSE with fake retrieval and generation.
- The shared RAG slice keeps retrieval/ranking, grounded generation, cost accounting, and shadow comparison workflows in `@reader/application`. API infrastructure owns Drizzle, MiniSearch, Chroma, OpenAI, Langfuse, and queue adapters; keep `@reader/api/{rag,ai-usage,rag-shadow}` compatibility barrels stable for worker and eval callers. `pnpm test:integration:rag` exercises owner-scoped retrieval, atomic shadow replay/concurrency, and worker barrel wiring with fake providers.
- Reading progress uses application-owned validation and use cases. Saves lock the live owner book row before upserting so deletion races are deterministic; omitted chapter preserves an existing value, while explicit `null` clears it. `pnpm test:integration:progress` uses PostgreSQL only.
