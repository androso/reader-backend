# Reader Platform

Reader Platform is a pnpm workspace for the Reader API, web app, background
worker, and shared ingestion packages.

## Layout

- `apps/api`: NestJS API (Express adapter) for auth, books, chat, progress, storage, and current ingestion flow.
- `apps/web`: Next.js frontend for the library, reader, auth, and chat UI.
- `apps/worker`: BullMQ worker that processes uploaded books outside the API request path.
- `packages/epub`: shared EPUB parsing utilities.
- `packages/jobs`: shared Redis/BullMQ queue definitions.
- `packages/processing`: shared PDF/EPUB ingestion pipeline.
- `packages/providers`: shared storage, vector store, and provider integrations.
- `drizzle.config.ts`: root Drizzle config pointing at the API schema and migrations.

## Setup

Use Node.js 22 (matching the production Dockerfiles) and the repository-pinned
pnpm 10.11.1 through Corepack. From this repository root:

```bash
corepack enable pnpm
corepack pnpm install --frozen-lockfile
corepack pnpm dev:env
```

Enable the pnpm shim once: workspace scripts invoke `pnpm` internally, so
calling Corepack alone without the shim is not enough.

`dev:env` creates missing root and web `.env` files, generates a local JWT secret,
and never overwrites existing files. Configure a dedicated local `reader_dev`
database and its credentials in the root `.env` before applying migrations.

```bash
corepack pnpm dev:services:up
corepack pnpm db:migrate
corepack pnpm dev
```

The application runs locally with code reload. Docker runs pinned Redis and
Chroma containers with persistent storage and no automatic restart. PostgreSQL
is an existing shared service, configured through `DATABASE_URL`; the setup
commands never create, stop, or modify it. OpenAI credentials are needed for
book ingestion and document chat.

For local auth, the API supports `/api/auth/dev` through `DEV_USER_EMAIL` and
`DEV_USER_NAME`. Google OAuth values are still required for production.

See [Local development](docs/local-development.md) for database setup,
manual service control, ports, and troubleshooting.

## Commands

- `pnpm dev`: run the API, web app, and Redis-backed worker in development mode.
- `pnpm dev:env`: create missing local environment files without overwriting them.
- `pnpm dev:services:setup`: create missing pinned Redis/Chroma containers, stopped.
- `pnpm dev:services:up`: provision and manually start Redis/Chroma, then wait for readiness.
- `pnpm dev:services:down`: stop Redis/Chroma without deleting containers or data.
- `pnpm dev:services:status`: report the shared PostgreSQL and Reader container states.
- `pnpm test:dev`: test setup scripts without Docker or a live database.
- `pnpm build`: compile the backend packages, API app, and worker app.
- `pnpm test`: run package, API, and worker tests.
- `pnpm api:dev`: run only the API app on port `3000`.
- `pnpm worker:dev`: run the Redis-backed book processing worker in development.
- `pnpm web:dev`: run the Next.js web app on port `3001`.
- `pnpm web:build`: build the Next.js web app.
- `pnpm web:lint`: run the web lint script.
- `pnpm db:generate`: generate Drizzle migrations from the API schema.
- `pnpm db:migrate`: apply Drizzle migrations using `.env`.
- `pnpm --filter @reader/api <script>`: run an API-specific script directly.
- `pnpm --filter @reader/web <script>`: run a web-specific script directly.
- `pnpm --filter @reader/worker <script>`: run a worker-specific script directly.

## Development Flow

Use `pnpm dev` for the normal full-stack loop. It starts:

- `@reader/api` with `ts-node-dev`.
- `@reader/web` with Next.js on port `3001`.
- `@reader/worker` with `ts-node-dev`.

The API listens on `PORT` from `.env`, defaulting to `3000`. The web app calls
the API through `NEXT_PUBLIC_API_URL` from `apps/web/.env`.

Book uploads are processed asynchronously. The API stores the uploaded file,
inserts a `processing` book row, enqueues a Redis/BullMQ job, and returns
immediately while `apps/worker` finishes PDF/EPUB ingestion. Set `REDIS_URL` for
both the API and worker.

### Book lifecycle API

Authenticated book routes list the caller's books (`GET /api/books`), return
processing status (`GET /api/books/:id/status`), retry a `failed` or
`queue_failed` book (`POST /api/books/:id/retry`, accepted with `202`), and
delete a book (`DELETE /api/books/:id`, completed with `204`). Status and delete
distinguish a missing book (`404`) from a book owned by another user (`403`);
retry intentionally returns `404` for both cases. Retry conflicts return
`409`, while queue or lifecycle-lock unavailability returns `503`. Deletion
marks the row as `deleting` before cleanup so a failed cleanup can be retried;
files and collections still referenced by another live book are retained.
Lifecycle advisory-lock sessions share a FIFO capacity limit across all
adapters using the same PostgreSQL pool (defaulting to half the pool maximum,
at least one; later adapters can lower the limit). Pool connections time out
after 10 seconds and use keepalive. If a lock session disconnects, its callback
is aborted and awaited until in-flight work settles; lifecycle state writes
stop, then only that attempt's isolated artifacts are cleaned.
Each processing attempt uses a unique collection. Publication points the book
at the new collection, clears caches for both old and new names, and best-effort
removes the previous collection only when no other live book references it.

### Chat API

Chat message validation, history-window selection, highlight normalization, and
finish-reason mapping are framework-free domain policies. Conversation reads and
streaming writes use application workflows with Drizzle adapters. SSE sessions
serialize frames, wait for backpressure to clear, and cancel the shared request
signal on a premature client disconnect; `[DONE]` is emitted only by the
transport adapter. `pnpm test:integration:chat` verifies the HTTP stream against
temporary local PostgreSQL and Redis with fake retrieval and generation.

### Shared RAG engine

Retrieval/ranking, grounded prompt generation, usage accounting, and shadow
comparison are application workflows with portable domain contracts. API
infrastructure supplies database, lexical/vector/reranker/model, tracing, and
queue adapters. The `@reader/api/rag`, `ai-usage`, and `rag-shadow`
compatibility barrels remain the entry points for chat, worker, and evaluation
callers. `pnpm test:integration:rag` checks owner-scoped retrieval, atomic
shadow persistence/replay/concurrency, and worker wiring with fake providers.

## AWS infrastructure

CloudFormation is the source of truth for a clean AWS rebuild. Follow
`docs/aws-cloudformation-rebuild.md`; the console guide is retained only as
historical operational reference.
