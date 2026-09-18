ALTER TABLE "user_prefs" ALTER COLUMN "max_iterations" SET DEFAULT 100;--> statement-breakpoint
-- A default only applies to rows written after it, so without this every
-- existing account keeps the old ceiling of 20 — and 20 now means something
-- different: it is a check-in cadence, not the point at which the run dies.
-- Twenty check-ins into a planning run is an interruption every couple of
-- minutes, which is worse than the behaviour being replaced.
--
-- Only rows still *at* the old default move. Anyone who deliberately chose a
-- number in Settings keeps it — including anyone who chose 20 on purpose,
-- which is indistinguishable here and is the one case this gets wrong. That is
-- the cheaper mistake: it is one visible setting they can put back, whereas
-- leaving every untouched account on 20 would make the new behaviour feel
-- broken for everybody.
UPDATE "user_prefs" SET "max_iterations" = 100 WHERE "max_iterations" = 20;
