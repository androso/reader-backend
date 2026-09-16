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
- No live Postgres/Redis in tests: mock the `DRIZZLE` provider (`overrideProvider`/`useValue`), rate-limit guards no-op without `REDIS_URL`, and set `process.env.JWT_SECRET ??=` before importing anything that pulls in `AuthService` (env must precede `require()` since imports hoist).
