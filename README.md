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

Install dependencies from the repository root:

```bash
pnpm install
```

Create local environment files:

```bash
cp .env.template .env
cp apps/web/.env.template apps/web/.env
```

Local development expects these services to be available:

- PostgreSQL, matching `DATABASE_URL`.
- Redis, matching `REDIS_URL`.
- Chroma, matching `CHROMA_URL`, for vector search.
- OpenAI credentials, via `OPENAI_API_KEY`, when ingesting books or chatting with document context.

For local auth, the API supports `/api/auth/dev` through `DEV_USER_EMAIL` and
`DEV_USER_NAME`. Google OAuth values are still required for production.

## Commands

- `pnpm dev`: run the API, web app, and Redis-backed worker in development mode.
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

## AWS infrastructure

CloudFormation is the source of truth for a clean AWS rebuild. Follow
`docs/aws-cloudformation-rebuild.md`; the console guide is retained only as
historical operational reference.
