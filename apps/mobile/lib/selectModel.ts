/**
 * Which model the composer is pointed at.
 *
 * Pure, and shared by the chat and agent screens, because the order matters
 * more than it looks: one branch of it decides whether someone's next message
 * is billed to an API key.
 *
 * 1. The conversation's own model — while the list is still loading, or when
 *    the list still offers it.
 * 2. For a conversation that **does not exist yet**: what the user picked in
 *    the picker, then what they last sent with.
 * 3. The default (the built-in backend's, by `useModels`' own ordering).
 *
 * The recents branch is gated on there being no conversation, not on the
 * conversation lacking a stored model. Those are different sets: a thread from
 * before `model_pref` was written, or one created by another client, has an id
 * and no pref — and "the last model you used anywhere" would silently move
 * that old local-model thread onto a paid provider the first time its owner
 * tried one in a different chat, with nothing on screen saying it had moved.
 * A conversation that exists falls through to the default instead, which is
 * what it showed before recents existed.
 *
 * Gating on the id is safe for the thread being started, too: on both surfaces
 * a conversation only acquires an id as part of its first send, and that send
 * records its model on the conversation — so the composer does not flip when
 * the new conversation stops being new.
 */
export function pickSelectedModel(input: {
  /** The conversation's stored model, if it has one. */
  prefModel: string | null | undefined;
  /** Whether a conversation is open — false on the empty "new chat" screen. */
  hasConversation: boolean;
  /** Chosen in the picker before any conversation exists. */
  pendingModel: string | null;
  /** This user's most recently sent-with models, newest first. */
  recentModels: string[];
  /** False until the model list has arrived; nothing is "known" before then. */
  modelsLoaded: boolean;
  isKnown: (ref: string) => boolean;
  defaultModelId: string | null | undefined;
}): string {
  const { prefModel, hasConversation, pendingModel, recentModels, modelsLoaded, isKnown, defaultModelId } = input;
  // An unloaded list cannot say a stored model is gone, so it is kept.
  if (prefModel && (!modelsLoaded || isKnown(prefModel))) return prefModel;
  if (!hasConversation) {
    if (pendingModel) return pendingModel;
    // Skipped when no longer offered — its provider was deleted, or an admin
    // disallowed it — which is also why the list has to have loaded first.
    const recent = modelsLoaded ? recentModels.find((ref) => isKnown(ref)) : undefined;
    if (recent) return recent;
  }
  return defaultModelId ?? '';
}
