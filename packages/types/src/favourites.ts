/**
 * Favourite questions: what a person keeps on the new-chat screen, one tap to
 * send. The server and every client check a question with the same rules, so
 * a client can say what is wrong before asking.
 */

/** Longest favourite question, in characters, after trimming. */
export const FAVOURITE_QUESTION_MAX_CHARS = 300;

/** Most favourite questions one person keeps. */
export const MAX_FAVOURITE_QUESTIONS = 12;

/** What every person starts with, in this order. Given once (the server's
 * `favourites_seeded_at`): removing them all leaves an empty list. */
export const DEFAULT_FAVOURITE_QUESTIONS: readonly string[] = [
  "What's the weather like today?",
  "What's the top news for my area and around the world?",
  "Tell me a fun fact about a random topic.",
  "Tell me a joke.",
];

export interface FavouriteQuestion {
  id: string;
  text: string;
  /** ISO 8601. */
  createdAt: string;
}

/**
 * A favourite question as it is stored (trimmed), or what is wrong with it.
 * Inner line breaks are kept: a question may be a short prompt.
 */
export function checkFavouriteQuestion(value: unknown): { text: string } | { error: string } {
  if (typeof value !== "string") return { error: "Type a question." };
  const text = value.trim();
  if (!text) return { error: "Type a question." };
  if (text.length > FAVOURITE_QUESTION_MAX_CHARS) {
    return { error: `Keep it to ${String(FAVOURITE_QUESTION_MAX_CHARS)} characters.` };
  }
  return { text };
}
