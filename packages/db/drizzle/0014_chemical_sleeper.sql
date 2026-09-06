ALTER TABLE "usage_records" ALTER COLUMN "cached_tokens" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "usage_records" ALTER COLUMN "cached_tokens" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "reusable_tokens" integer;--> statement-breakpoint
-- Historical rows stored "the backend told us nothing" as 0, which is what
-- held the stats screen's cache-hit rate at a permanent 0%. There is no way
-- to tell those apart from a genuine cold-prompt 0 after the fact, so they
-- all become NULL ("not reported"). That is the conservative direction: a
-- llama.cpp deployment loses a handful of true zeroes to "unknown", rather
-- than every LM Studio deployment keeping a fabricated one.
UPDATE "usage_records" SET "cached_tokens" = NULL WHERE "cached_tokens" = 0;
