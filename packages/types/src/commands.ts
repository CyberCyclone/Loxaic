/**
 * Slash commands: the one registry both sides read.
 *
 * The client's palette filters this list as the user types; the server's WS
 * dispatch validates `command.run` names against the same list. Keeping them
 * in one place is what stops the palette offering something the server will
 * reject (or the server accepting something the palette never shows).
 */

/** "skill" is reserved for user-defined commands, later — the palette and
 * dispatch are written against the union so that lands without a schema
 * change. */
export type CommandKind = "command" | "skill";

export type CommandSurface = "chat" | "agent";

export type SlashCommand = {
  name: string;
  kind: CommandKind;
  description: string;
  /** Shown muted after the name in the palette, e.g. "[guidance]". */
  argHint?: string;
  surfaces: CommandSurface[];
  /** True when the command acts on an existing thread — nothing to compact in
   * a conversation that hasn't started. */
  requiresConversation: boolean;
};

export const BUILT_IN_COMMANDS: SlashCommand[] = [
  {
    name: "compact",
    kind: "command",
    description: "Summarize the conversation and continue from the summary",
    argHint: "[guidance]",
    surfaces: ["chat", "agent"],
    requiresConversation: true,
  },
];

/** Names are typed lowercase; matching ignores case so "/Compact" still hits. */
export function findCommand(name: string): SlashCommand | undefined {
  const lower = name.toLowerCase();
  return BUILT_IN_COMMANDS.find((c) => c.name === lower);
}

/** A command name (or prefix of one) still being typed: slash, then only name
 * characters, nothing else. The instant a space lands the user is writing
 * arguments (or prose), so the palette must close. */
const QUERY_RE = /^\/([a-z0-9-]*)$/i;

/**
 * The prefix being typed after "/", or null when the palette must not be open.
 * "" (bare "/") means "show everything".
 */
export function commandQuery(text: string): string | null {
  const m = QUERY_RE.exec(text);
  return m ? m[1].toLowerCase() : null;
}

const COMMAND_RE = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i;

/**
 * Parse a would-be invocation at send time. Returns null for anything that
 * isn't shaped like one — and callers must ALSO check the name against the
 * registry: an unknown "/foo bar" is deliberately sent as ordinary text,
 * because people do start messages with a slash.
 */
export function parseCommand(text: string): { name: string; args: string } | null {
  const m = COMMAND_RE.exec(text.trim());
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] ?? "").trim() };
}
