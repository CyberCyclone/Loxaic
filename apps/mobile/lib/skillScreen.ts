/**
 * What the Skills screen says about overriding a built-in (#283). A person
 * cannot edit a built-in; adding their own skill of the same name supersedes
 * it, and deleting that skill brings the built-in back. Compaction is the one
 * whose override changes what a command does, so it says more.
 */
export function overrideNote(name: string): string {
  if (name === 'compact') {
    return 'This replaces the built-in compact: /compact will send your skill as a message instead of compacting. ' +
      'Loxaic still compacts by itself when a conversation fills up.';
  }
  return `This replaces the built-in ${name} for you. Delete it to get the built-in back.`;
}

/** The confirmation for deleting one of a person's own skills. */
export function deleteSkillMessage(skill: { name: string; overridesBuiltin: boolean }): string {
  return skill.overridesBuiltin
    ? `Delete your ${skill.name} skill? The built-in ${skill.name} comes back in its place.`
    : `Delete your ${skill.name} skill? Conversations that already used it keep what it said.`;
}
