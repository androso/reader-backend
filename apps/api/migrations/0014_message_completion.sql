CREATE TYPE "public"."message_completion_status" AS ENUM('complete', 'truncated', 'cancelled', 'failed');
ALTER TABLE "messages" ADD COLUMN "completion_status" "message_completion_status";
ALTER TABLE "messages" ADD COLUMN "finish_reason" text;
UPDATE "messages" SET "completion_status" = 'complete' WHERE "role" = 'assistant';
