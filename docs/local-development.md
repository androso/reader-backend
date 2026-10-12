# Local development

Run the API, worker, and frontend on the host for code reload and debugging.
Use Docker for Redis and Chroma. Reuse the shared `postgresql` container with a
dedicated Reader database and login; do not reuse another application's database.
The production Dockerfiles are unchanged and are not needed for this workflow.

## Prerequisites

- Node.js 22, matching the production Dockerfiles.
- Corepack, using `pnpm@10.11.1` from `package.json`.
- Docker Engine running, with permission to use it without `sudo`.
- A running local PostgreSQL service. The shared installation currently uses
  PostgreSQL 17.5; its container and version are managed separately from Reader.

All commands below run from the `reader-backend-nestjs` repository root.
If `pnpm` is already available, it can replace `corepack pnpm`.

## First-time setup

```bash
corepack enable pnpm
corepack pnpm install --frozen-lockfile
corepack pnpm dev:env
```

Enabling the pnpm shim is required because workspace scripts invoke `pnpm`
internally. If the Node installation is not writable, install the shim in a
user-writable directory already on `PATH`, for example
`corepack enable --install-directory "$HOME/.local/bin" pnpm` after creating
that directory. Do not use `sudo` to install project dependencies.

Environment setup creates only missing `.env` and `apps/web/.env` files.
It generates a random JWT secret for a new root `.env`, uses owner-only file
permissions, and leaves existing configuration untouched. Never commit secrets.

### Shared PostgreSQL

If necessary, manually start your existing container:

```bash
docker start postgresql
```

Using your PostgreSQL administrator account, create a dedicated role and database
**once**. For a container whose administrator is `postgres`:

```bash
docker exec -it postgresql psql -U postgres
```

Then enter:

```sql
CREATE ROLE reader LOGIN;
```

Use the psql command `\password reader` to set a password without putting it in
shell history, then create the database:

```sql
CREATE DATABASE reader_dev OWNER reader;
```

If the role or database already exists, inspect it instead of recreating it.
Reader's scripts never run this SQL or alter shared databases.

Edit the root `.env` to use that database and password:

```dotenv
NODE_ENV=development
DATABASE_URL=postgresql://reader:<url-encoded-password>@localhost:5432/reader_dev
REDIS_URL=redis://localhost:6379
CHROMA_URL=http://localhost:8000
STORAGE_DRIVER=local
```

Keep the generated `JWT_SECRET`, or set a strong local secret if `.env` already
existed. Leave Google, S3, and Langfuse credentials empty unless you use them.
Set `OPENAI_API_KEY` for ingestion and document chat; basic auth, library, and
progress development do not need OpenAI.

### Reader services and migrations

```bash
corepack pnpm dev:services:up
corepack pnpm db:migrate
```

Before migrating, verify that `DATABASE_URL` targets the local `reader_dev`
database, not production or another application's database. Migrations are
explicit and never run as part of service startup.

## Daily workflow

```bash
corepack pnpm dev:services:up
corepack pnpm dev
```

Use `Ctrl+C` to stop the application processes, then stop Reader's services:

```bash
corepack pnpm dev:services:down
```

This leaves the shared PostgreSQL container alone and retains all service data.
There is no boot-time automation: Reader containers use `restart=no`.

To provision containers without starting them:

```bash
corepack pnpm dev:services:setup
```

Check their state:

```bash
corepack pnpm dev:services:status
```

## Versions, ports, and persistence

| Service           | Image                   | Host port        | Storage                                      |
| ----------------- | ----------------------- | ---------------- | -------------------------------------------- |
| Shared PostgreSQL | Externally managed      | `5432`           | Existing PostgreSQL storage                  |
| `reader-redis`    | `redis:7.4.9-alpine`    | `127.0.0.1:6379` | `reader-redis-data`, append-only persistence |
| `reader-chroma`   | `chromadb/chroma:0.6.3` | `127.0.0.1:8000` | `reader-chroma-data` at `/chroma/chroma`     |

Image versions are defined in `scripts/dev.mjs`. Setup compares existing
containers' image IDs against the pinned images and requires `restart=no`.
It never deletes or replaces an existing container. Resolve mismatches manually
after preserving data. Only one service can use each host port.

Chroma 0.6.3 is tested with the API's `chromadb@1.9.4` JavaScript client. The
client uses v2 collection endpoints; the local readiness check uses the pinned
server's v1 heartbeat endpoint. A heartbeat alone does not establish client
compatibility. Upgrade the client and server together after testing actual
collection operations; do not use `latest`.
Do not mount data from a newer Chroma release into this older server.

The previous Chroma 1.4.4 container is retained locally as
`reader-chroma-backup-1.4.4`, stopped with `restart=no`. Its existing
`/home/androso/dev/chroma-data` bind mount is untouched. This is a local rollback
copy, not a file backup. Do not start it alongside `reader-chroma`, since both
use port 8000. The new server has a fresh volume; existing books' vector
collections are not automatically migrated.

## Application URLs

- Frontend: <http://localhost:3001>
- API: <http://localhost:3000>
- Swagger: <http://localhost:3000/api-docs>
- Health: <http://localhost:3000/health> (process health, not dependency readiness)

`apps/web/.env` points `NEXT_PUBLIC_API_URL` to `http://localhost:3000`.
Use development sign-in, backed by `POST /api/auth/dev`; Google OAuth is
optional locally. `NODE_ENV=production` disables development sign-in.

For API-only work, use `corepack pnpm api:dev`. Upload processing additionally
requires `corepack pnpm worker:dev`; `corepack pnpm dev` starts all three apps.
API and worker startup build their shared packages. After editing a shared
package, restart the affected dev processes so its built exports are refreshed.

## Troubleshooting and validation

- An existing `.env` is never updated by `dev:env`. Review it against the template.
- Port conflicts: inspect `docker ps` and other locally running services.
- Service startup failure: inspect `docker logs reader-redis` or
  `docker logs reader-chroma`. The startup command checks Redis PONG and a valid
  Chroma v1 heartbeat, with bounded retries.
- Database errors: verify PostgreSQL is running, credentials are correct, and
  migrations have been applied to the intended database.
- Redis and Chroma are unauthenticated local services, bound to localhost on
  newly created containers. These settings are not suitable for deployment.

### Missing original book files

PostgreSQL stores book metadata and storage keys, not the uploaded PDF/EPUB
bytes. With `STORAGE_DRIVER=local`, those bytes live under `LOCAL_STORAGE_DIR`
(default: this repository's `.local-storage`). Keep that directory backed up
alongside the database. Restoring or copying a database alone does not restore
its books' files, and switching from S3 to local storage does not download them.

If a live book's original is missing, the file endpoint returns `404` with
`code=BOOK_FILE_MISSING`. Restore the exact original from a trusted backup at
its existing storage key to retain the same book ID and reading progress, or
upload the book again to create a new record. Do not substitute another book's
file or remove database records as an automatic repair.

Books marked `deleting` are no longer readable, even if their original file
still exists. Retry deletion through the library if cleanup was interrupted;
do not reset the database state just to make the reader open the book.

```bash
corepack pnpm test:dev
corepack pnpm build
```

Setup-script tests use mocked Docker responses and temporary environment files,
not live PostgreSQL, Redis, or Chroma.
