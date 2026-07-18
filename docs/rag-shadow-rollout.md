# RAG reranking shadow rollout

The shadow worker compares `rerank-rag-v1` evidence with the evidence already
used by `baseline-rag-v1`. It never generates a second answer and cannot change
the response returned to the reader. The API sends only user, book,
conversation, and message identifiers through Redis; the worker reloads and
reauthorizes those records before retrieval.

## Deployment and controls

Deploy the API and worker with the shadow sample rate at zero. The source of
truth is the CloudFormation parameter file, because image-only ECS deployments
retain the previous task-definition environment.

```json
{ "ParameterKey": "RagRerankShadowSampleRate", "ParameterValue": "0" }
{ "ParameterKey": "RagRerankShadowRateLimitPerMinute", "ParameterValue": "30" }
```

Apply parameter changes with:

```bash
CFN_ARTIFACT_BUCKET=<artifact-bucket> ./scripts/deploy-cloudformation.sh
```

`RagRerankShadowSampleRate` is a decimal from `0` to `1`. Sampling is a stable
hash of the saved assistant-message ID, highlighted requests are excluded, and
the default rate is zero. The worker runs two jobs concurrently and the BullMQ
limiter permits 30 reranker calls per minute by default. Each job has one
attempt, so a failed job remains available for inspection without silently
repeating a paid model call.

Set the sample rate back to zero immediately if an authorization failure,
cross-book mismatch, repeated cost or latency breach, or systematic retrieval
degradation appears. Production chat remains on `baseline-rag-v1` throughout
this phase.

## PostgreSQL evidence

This query summarizes completed shadow comparisons. It keeps fallback, latency,
cost, and source divergence separate so one healthy aggregate cannot hide a
different failure mode.

```sql
WITH samples AS (
  SELECT execution_metadata->'shadow' AS shadow
  FROM messages
  WHERE execution_metadata->'shadow' IS NOT NULL
    AND execution_metadata->'shadow'->>'version' = 'rag-shadow-v1'
)
SELECT
  count(*) AS successful_samples,
  count(*) FILTER (
    WHERE shadow->'candidate'->'reranker'->>'status' = 'fallback'
  )::float / NULLIF(count(*), 0) AS fallback_rate,
  percentile_cont(0.95) WITHIN GROUP (
    ORDER BY (shadow->'candidate'->'reranker'->>'durationMs')::numeric
  ) AS reranker_p95_ms,
  max((shadow->'candidate'->'reranker'->'estimatedCost'->>'amount')::numeric)
    AS max_known_reranker_cost_usd,
  avg((shadow->'comparison'->>'sourceSetJaccard')::numeric)
    AS average_source_set_jaccard
FROM samples;
```

Review the 20 largest divergences by stable source IDs and ranks. This query
does not return excerpts or user text.

```sql
SELECT
  id AS assistant_message_id,
  execution_metadata->'shadow'->'baseline'->'sources' AS baseline_sources,
  execution_metadata->'shadow'->'candidate'->'sources' AS candidate_sources,
  execution_metadata->'shadow'->'comparison'->>'sourceSetJaccard'
    AS source_set_jaccard,
  execution_metadata->'shadow'->'comparison'->>'exactRankMatches'
    AS exact_rank_matches
FROM messages
WHERE execution_metadata->'shadow' IS NOT NULL
ORDER BY
  (execution_metadata->'shadow'->'comparison'->>'sourceSetJaccard')::numeric,
  (execution_metadata->'shadow'->'comparison'->>'exactRankMatches')::integer
LIMIT 20;
```

## CloudWatch evidence

Use this Logs Insights query against `/ecs/reader-prod/worker` to count queue
outcomes. It selects the structured processor log so BullMQ's event log does
not double-count the same job.

```text
fields @timestamp, @message
| filter @message like /"message":"RAG shadow job completed"/
    or @message like /"message":"RAG shadow job failed"/
| parse @message /"message":"RAG shadow job (?<outcome>completed|failed)"/
| stats count(*) as jobs by outcome
```

Authorization failures are security failures, while other failed jobs count
toward the queue-failure rate. Find them directly with:

```text
fields @timestamp, @message
| filter @message like /"message":"RAG shadow job failed"/
| filter @message like /"errorName":"RagShadowAuthorizationError"/
```

Langfuse traces use service name `reader-worker`, carry the baseline trace ID as
link metadata, and force metadata-only capture. Redis, PostgreSQL shadow
metadata, and worker logs contain no question text or book excerpts.

## Promotion gate

1. Run at 5% for at least 24 hours and collect at least 25 successful samples.
2. Increase to 20% only when fallback is at most 2%, queue failure is below 1%,
   reranker p95 is at most 2.5 seconds, every known call costs at most $0.015,
   and there are no authorization or cross-book failures.
3. Continue until there are at least 200 successful samples and seven calendar
   days have elapsed since the first 5% sample.
4. Review the 20 lowest-overlap comparisons and confirm there is no systematic
   degradation before proposing the canary PR.

Issue #22 remains open during the soak. Do not create the sticky-canary branch
until these gates pass and the next checkpoint is explicitly approved.
