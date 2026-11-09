/**
 * The fixed line every progress review request ends its system prompt with
 * (progress-review.ts). Its own module, importing nothing, so the mock backend
 * in inference/provider.ts can recognise a review without importing the
 * reviewer, which imports the provider.
 */
export const REVIEW_OUTPUT_CONTRACT =
  'Reply with only a JSON object and nothing else: {"verdict": "progressing" | "stuck" | "finished", "reason": "<one sentence>"}';
