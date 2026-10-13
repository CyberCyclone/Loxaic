import { describe, expect, it } from "vitest";
import { MAX_GRAPHQL_CHARS, parseGraphql, type GraphqlOperation } from "../graphql.ts";

function ops(doc: string): GraphqlOperation[] {
  const parsed = parseGraphql(doc);
  if (!Array.isArray(parsed)) throw new Error(`did not parse: ${parsed.error}`);
  return parsed;
}

const fieldNames = (doc: string) => ops(doc).map((o) => [o.type, o.fields.map((f) => f.name)]);

describe("parseGraphql", () => {
  it("reads gh's own pr create mutation", () => {
    // As recorded from gh 2.101 (GH_DEBUG=api).
    const doc =
      "mutation PullRequestCreate($input:CreatePullRequestInput!){createPullRequest(input: $input){pullRequest{id,url}}}";
    expect(ops(doc)).toEqual([
      { type: "mutation", fields: [{ name: "createPullRequest", args: { input: { kind: "variable", name: "input" } } }], hasTopLevelFragment: false },
    ]);
  });

  it("tells a query from a mutation, including the shorthand query", () => {
    expect(fieldNames("{ viewer { login } }")).toEqual([["query", ["viewer"]]]);
    expect(fieldNames("query Q($n: Int) { repository(owner: \"o\", name: \"r\") { id } }")).toEqual([["query", ["repository"]]]);
    expect(fieldNames("subscription { x }")).toEqual([["subscription", ["x"]]]);
  });

  it("names the real field behind an alias", () => {
    const [op] = ops("mutation { harmless: mergePullRequest(input: $i) { clientMutationId } }");
    expect(op.fields[0].name).toBe("mergePullRequest");
  });

  it("finds every top-level field, and every operation in the document", () => {
    expect(
      fieldNames("query A { viewer { login } } mutation B($a: X, $b: Y) { addComment(input: $a) { clientMutationId } deleteRef(input: $b) { clientMutationId } }"),
    ).toEqual([
      ["query", ["viewer"]],
      ["mutation", ["addComment", "deleteRef"]],
    ]);
  });

  it("records a literal argument as literal, never as a variable", () => {
    const [op] = ops('mutation { deleteRef(input: { refId: "R_1" }) { clientMutationId } }');
    expect(op.fields[0].args.input).toEqual({ kind: "literal" });
  });

  it("flags a fragment at a mutation's top level, whose fields it cannot see", () => {
    const [op] = ops("fragment F on Mutation { deleteRef(input: $i) { clientMutationId } } mutation M($i: X) { ...F }");
    expect(op.hasTopLevelFragment).toBe(true);
    const [inline] = ops("mutation M($i: X) { ... on Mutation { deleteRef(input: $i) { clientMutationId } } }");
    expect(inline.hasTopLevelFragment).toBe(true);
  });

  it("skips fragment definitions, which gh's RepositoryInfo query uses", () => {
    expect(fieldNames("query RepositoryInfo($owner: String!) { repository(owner: $owner) { ...repo } } fragment repo on Repository { id name }")).toEqual([
      ["query", ["repository"]],
    ]);
  });

  it("does not read a mutation out of a string, a block string or a comment", () => {
    const doc = [
      "query {",
      '  a(x: "mutation { deleteRef(input: $i) }")',
      '  b(x: """ } mutation { deleteRef(input: $i) } """)',
      "  # mutation { deleteRef(input: $i) }",
      "}",
    ].join("\n");
    expect(fieldNames(doc)).toEqual([["query", ["a", "b"]]]);
  });

  it("does not end a block string at its escaped triple quote", () => {
    // Ended at the escape, the rest would read as a second block string and the
    // mutation inside the first would be lost to the check — or the reverse.
    const doc = 'query { a(x: """ \\""" } mutation M { deleteRef(input: $i) { id } } """) }';
    expect(fieldNames(doc)).toEqual([["query", ["a"]]]);
    const outside = 'query { a(x: """ \\""" """) } mutation M($i: X) { deleteRef(input: $i) { id } }';
    expect(fieldNames(outside)).toEqual([
      ["query", ["a"]],
      ["mutation", ["deleteRef"]],
    ]);
  });

  it("refuses what it cannot read rather than guessing", () => {
    for (const doc of [
      "mutation { createPullRequest(input: $i) ",
      'query { a(x: "unterminated) }',
      'query { a(x: """ never closed ) }',
      "mutation  { x }",
      "nonsense { x }",
      "query { a(x: $) }",
    ]) {
      expect(parseGraphql(doc), doc).toHaveProperty("error");
    }
  });

  it("refuses a document over the size cap", () => {
    expect(parseGraphql(`query { a }${" ".repeat(MAX_GRAPHQL_CHARS)}`)).toEqual({ error: "too large to check" });
  });

  it("stays linear on hostile input", () => {
    const deep = `query { ${"a { ".repeat(10_000)}${"} ".repeat(10_000)} }`.slice(0, MAX_GRAPHQL_CHARS - 1);
    const quotes = `query { a(x: """${'\\"""'.repeat(15_000)}""") }`;
    const started = Date.now();
    parseGraphql(deep);
    expect(Array.isArray(parseGraphql(quotes))).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
