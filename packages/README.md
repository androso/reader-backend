# Shared Packages

This directory is reserved for shared monorepo packages.

Current packages:

- `domain`: framework-free book processing types, state references, errors, MIME types, and upload keys.
- `application`: use cases and ports for book upload, enqueue, and ingestion lifecycle orchestration.
- `epub`: shared EPUB metadata, spine, ToC, href, and text-block processing.
- `providers`: storage and vector search adapters shared by backend packages.
- `processing`: PDF/EPUB ingestion orchestration for search indexing.

Deferred packages:

- `db`: Drizzle schema, migrations, and repositories.
- `contracts`: request/response schemas and generated API types.
- `db`: Drizzle schema, migrations, and repositories.
