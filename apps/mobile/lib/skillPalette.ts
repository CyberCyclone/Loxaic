import type { PaletteSkill } from '@loxaic/api-client';

/**
 * What the "/" palette shows for what has been typed after the slash (#283).
 *
 * The server sends every skill already in the person's own order, most-used
 * first. Typing narrows it: names that start with the query first, then names
 * that contain it, then skills whose description does — each tier keeping the
 * server's order, so the skill someone reaches for most stays at the top of
 * whichever tier it lands in. A bare "/" lists everything.
 */
export function filterSkills(skills: readonly PaletteSkill[], query: string): PaletteSkill[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...skills];
  const prefix: PaletteSkill[] = [];
  const inName: PaletteSkill[] = [];
  const inDescription: PaletteSkill[] = [];
  for (const s of skills) {
    if (s.name.startsWith(q)) prefix.push(s);
    else if (s.name.includes(q)) inName.push(s);
    else if (s.description.toLowerCase().includes(q)) inDescription.push(s);
  }
  return [...prefix, ...inName, ...inDescription];
}

/** One more use of `name`, as the server will have counted it: the list
 * re-sorted so the palette is already right the next time "/" is typed,
 * rather than a fetch behind. */
export function bumpSkill(skills: readonly PaletteSkill[], name: string): PaletteSkill[] {
  const bumped = skills.map((s) => (s.name === name ? { ...s, uses: s.uses + 1 } : s));
  // Stable: equal counts keep their order, except that the one just used
  // moves ahead of the others it now ties with — it is the most recent.
  return bumped
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.uses - a.s.uses || (a.s.name === name ? -1 : b.s.name === name ? 1 : a.i - b.i))
    .map(({ s }) => s);
}

/** The skill a message invokes ("/name …"), when the name is one the palette
 * knows. */
export function skillNamed(skills: readonly PaletteSkill[], name: string): PaletteSkill | undefined {
  return skills.find((s) => s.name === name.toLowerCase());
}

/**
 * Before the first answer from the server, "/compact" still has to compact:
 * it is how a person rescues an over-full thread, and it used to work with no
 * fetch at all. Replaced by the server's list as soon as one arrives.
 */
export const FALLBACK_SKILLS: readonly PaletteSkill[] = [
  {
    name: 'compact',
    description: 'Summarize the conversation and continue from the summary',
    source: 'builtin',
    argHint: '[guidance]',
    action: 'compact',
    requiresConversation: true,
    uses: 0,
  },
];
