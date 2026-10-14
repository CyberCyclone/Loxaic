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

/**
 * Whether Enter and Tab pick from the palette rather than doing what they do
 * in the box. Only when the query matches a skill's *name*, or the person has
 * moved the highlight themselves: the description tier lists skills a word
 * merely appears in ("/fix" lists `debug`, "/use" lists them all), and a
 * person who typed the one-word message "/fix" and pressed Enter meant to send
 * it — taking Enter there replaced their message with "/debug " and sent
 * nothing.
 */
export function paletteTakesEnter(skills: readonly PaletteSkill[], query: string, moved: boolean): boolean {
  if (moved) return true;
  const q = query.trim().toLowerCase();
  return skills.some((s) => s.name.includes(q));
}

/**
 * Where to scroll the palette so the highlighted row is in view, or null when
 * it already is. Rows keep their own height; the list moves by as little as it
 * takes, so the rows around the highlight stay where the person last saw them.
 */
export function scrollToShow(row: { top: number; height: number }, view: { scrollY: number; height: number }): number | null {
  if (row.top < view.scrollY) return row.top;
  const bottom = row.top + row.height;
  if (bottom > view.scrollY + view.height) return bottom - view.height;
  return null;
}

/**
 * The list `useSkills` shows for a conversation: the last answer only if it
 * was *for that conversation*. A list belongs to its conversation's owner, so
 * one fetched for a thread someone shared must never stand in for another
 * thread — a skill only they have would look usable, and typing it would send
 * "/name" as plain text with nothing saying so. Anything else is
 * FALLBACK_SKILLS until the conversation's own answer arrives.
 */
export function skillsFor(
  held: { for: string | null; skills: readonly PaletteSkill[] } | null,
  conversationId: string | null,
): readonly PaletteSkill[] {
  return held?.for === conversationId ? held.skills : FALLBACK_SKILLS;
}

/**
 * What a Compact choice outside the composer (the context-stage modals) sends:
 * the harness's compaction while `/compact` is still the built-in, else the
 * person's own `/compact` as a message, as typing it would. `command.run`
 * for a name that is no longer the built-in is refused by the server, and
 * nothing would say so.
 */
export function compactRequest(skills: readonly PaletteSkill[]): { kind: 'command' } | { kind: 'message'; text: string } {
  return skillNamed(skills, 'compact')?.action === 'compact' ? { kind: 'command' } : { kind: 'message', text: '/compact' };
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
