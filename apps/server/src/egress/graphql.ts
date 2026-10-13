/**
 * Just enough of a GraphQL reader for the egress proxy (rules.ts) to tell a
 * query from a mutation, and to name a mutation's top-level fields and the
 * variables their arguments come from — which is how `gh` writes
 * (`mutation PullRequestCreate($input: …) { createPullRequest(input: $input) … }`).
 *
 * The body comes from code in a sandbox, so it is hostile input: one pass
 * over a token stream with no backtracking, a size cap, and anything outside
 * the shape it understands (an inline literal argument, a fragment spread at
 * a mutation's top level) is reported as such and refused upstream.
 */

export const MAX_GRAPHQL_CHARS = 65_536;

export type ArgValue = { kind: "variable"; name: string } | { kind: "literal" };

export interface GraphqlField {
  name: string;
  args: Partial<Record<string, ArgValue>>;
}

export interface GraphqlOperation {
  type: "query" | "mutation" | "subscription";
  /** Top-level fields. For queries they are read but never acted on. */
  fields: GraphqlField[];
  /** A fragment spread or inline fragment at the top level: its fields are
   * not known here, so a mutation carrying one is refused. */
  hasTopLevelFragment: boolean;
}

type Token = { kind: "punct"; value: string } | { kind: "name"; value: string } | { kind: "value" };

class GraphqlError extends Error {}

function tokenize(doc: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < doc.length) {
    const c = doc[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "," || c === "﻿") {
      i++;
    } else if (c === "#") {
      while (i < doc.length && doc[i] !== "\n") i++;
    } else if (c === '"') {
      if (doc.startsWith('"""', i)) {
        // A block string's only escape is \""", which does not end it. Ending
        // at one would read the rest of the string as code GitHub never runs —
        // or the reverse — so it is honoured exactly.
        let j = i + 3;
        for (;;) {
          const end = doc.indexOf('"""', j);
          if (end === -1) throw new GraphqlError("unterminated block string");
          if (doc[end - 1] === "\\") {
            j = end + 3;
            continue;
          }
          i = end + 3;
          break;
        }
      } else {
        i++;
        while (i < doc.length && doc[i] !== '"') {
          if (doc[i] === "\\") i++;
          if (doc[i] === "\n") throw new GraphqlError("unterminated string");
          i++;
        }
        if (i >= doc.length) throw new GraphqlError("unterminated string");
        i++;
      }
      tokens.push({ kind: "value" });
    } else if (doc.startsWith("...", i)) {
      tokens.push({ kind: "punct", value: "..." });
      i += 3;
    } else if ("{}()[]:$!=@|&".includes(c)) {
      tokens.push({ kind: "punct", value: c });
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < doc.length && /[A-Za-z0-9_]/.test(doc[j])) j++;
      tokens.push({ kind: "name", value: doc.slice(i, j) });
      i = j;
    } else if (/[-0-9]/.test(c)) {
      let j = i + 1;
      while (j < doc.length && /[0-9.eE+-]/.test(doc[j])) j++;
      tokens.push({ kind: "value" });
      i = j;
    } else {
      throw new GraphqlError(`unexpected character ${JSON.stringify(c)}`);
    }
  }
  return tokens;
}

class Reader {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  done(): boolean {
    return this.i >= this.tokens.length;
  }

  peek(): Token | undefined {
    return this.tokens[this.i];
  }

  isPunct(value: string): boolean {
    const t = this.peek();
    return t?.kind === "punct" && t.value === value;
  }

  next(): Token {
    const t = this.tokens.at(this.i);
    if (!t) throw new GraphqlError("unexpected end of document");
    this.i++;
    return t;
  }

  expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== "punct" || t.value !== value) throw new GraphqlError(`expected ${value}`);
  }

  name(): string {
    const t = this.next();
    if (t.kind !== "name") throw new GraphqlError("expected a name");
    return t.value;
  }

  /** Skips a balanced group opened by the current token (`(`, `{` or `[`). */
  skipGroup(): void {
    const open = this.next();
    if (open.kind !== "punct" || !"({[".includes(open.value)) throw new GraphqlError("expected a group");
    let depth = 1;
    while (depth > 0) {
      const t = this.next();
      if (t.kind !== "punct") continue;
      if ("({[".includes(t.value)) depth++;
      else if (")}]".includes(t.value)) depth--;
    }
  }

  skipDirectives(): void {
    while (this.isPunct("@")) {
      this.next();
      this.name();
      if (this.isPunct("(")) this.skipGroup();
    }
  }

  /** One argument value: a variable reference, or a literal of any shape. */
  value(): ArgValue {
    if (this.isPunct("$")) {
      this.next();
      return { kind: "variable", name: this.name() };
    }
    if (this.isPunct("{") || this.isPunct("[")) this.skipGroup();
    else this.next();
    return { kind: "literal" };
  }
}

function readSelectionSet(r: Reader): { fields: GraphqlField[]; hasTopLevelFragment: boolean } {
  r.expectPunct("{");
  const fields: GraphqlField[] = [];
  let hasTopLevelFragment = false;
  while (!r.isPunct("}")) {
    if (r.isPunct("...")) {
      r.next();
      hasTopLevelFragment = true;
      const t = r.peek();
      if (t?.kind === "name" && t.value === "on") {
        r.next();
        r.name();
      } else if (t?.kind === "name") {
        r.next();
      }
      r.skipDirectives();
      if (r.isPunct("{")) r.skipGroup();
      continue;
    }
    let name = r.name();
    if (r.isPunct(":")) {
      r.next();
      name = r.name();
    }
    const args: Record<string, ArgValue> = {};
    if (r.isPunct("(")) {
      r.next();
      while (!r.isPunct(")")) {
        const arg = r.name();
        r.expectPunct(":");
        args[arg] = r.value();
      }
      r.next();
    }
    r.skipDirectives();
    if (r.isPunct("{")) r.skipGroup();
    fields.push({ name, args });
  }
  r.next();
  return { fields, hasTopLevelFragment };
}

/** The operations in a document, or why it could not be read. */
export function parseGraphql(doc: string): GraphqlOperation[] | { error: string } {
  if (doc.length > MAX_GRAPHQL_CHARS) return { error: "too large to check" };
  try {
    const r = new Reader(tokenize(doc));
    const ops: GraphqlOperation[] = [];
    while (!r.done()) {
      if (r.isPunct("{")) {
        ops.push({ type: "query", ...readSelectionSet(r) });
        continue;
      }
      const keyword = r.name();
      if (keyword === "fragment") {
        r.name();
        if (r.name() !== "on") throw new GraphqlError("expected on");
        r.name();
        r.skipDirectives();
        r.skipGroup();
        continue;
      }
      if (keyword !== "query" && keyword !== "mutation" && keyword !== "subscription") {
        throw new GraphqlError(`unexpected ${keyword}`);
      }
      if (r.peek()?.kind === "name") r.next();
      if (r.isPunct("(")) r.skipGroup();
      r.skipDirectives();
      ops.push({ type: keyword, ...readSelectionSet(r) });
    }
    return ops;
  } catch (err) {
    if (err instanceof GraphqlError) return { error: err.message };
    throw err;
  }
}
