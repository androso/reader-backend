# RAG evaluation and metadata rollout

The required CI gate uses the checksum-pinned Alice EPUB fixture. It is a focused
regression gate for the current EPUB ingestion, retrieval, answer-generation,
and judging path. PDF and broader corpus coverage belong in separate changes so
this gate remains small and diagnosable.

The report's `Source revision` identifies the upstream Standard Ebooks fixture
revision. The fixture checksum identifies the exact bytes evaluated; it is not
the Reader repository commit SHA. GitHub Actions already records the tested
Reader merge SHA on the workflow run.

## Existing-book metadata policy

Migration `0013_stiff_jigsaw.sql` deliberately adds nullable chunk metadata
without rewriting existing indexes. Books processed after the migration receive
EPUB chapter metadata. Existing books continue to work with excerpt citations,
but chapter labels remain absent until those books are processed again.

There is no automatic bulk reindex during deployment. Reindexing can invoke
OpenAI embeddings, Chroma writes, object-storage reads, and database writes, so
it must be handled as a separately monitored operational migration. Until that
work exists, the supported rollout policy is:

- preserve existing chunks and their `null` metadata;
- tolerate missing chapter labels in API responses;
- populate metadata on every new or explicitly reprocessed book;
- do not claim historical books have chapter-level citation metadata.

## Gate behavior

- Standard tests and builds run before the paid live RAG gate.
- Answer generation runs the full dataset against every chat model exposed by
  Reader's UI, using temperature zero where the model supports it and bounded
  retries and timeouts.
- Every dataset case is judged; the command fails instead of silently applying
  a first-N truncation.
- Langfuse publication is best-effort observability and cannot change the local
  retrieval or answer-quality decision.
