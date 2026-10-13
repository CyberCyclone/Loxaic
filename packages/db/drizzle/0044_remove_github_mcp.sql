-- The built-in GitHub MCP server is gone: agents reach GitHub with git and gh
-- in their workspace, through the server's egress proxy. Its rows were made
-- from a GitHub connection and stored no credential of their own. Matched on
-- builtin_key, so a server someone added by hand under the slug `github`
-- survives. Conversations' mcp_overrides may still name a deleted id; the
-- registry only resolves ids of servers that exist, so that is inert.
DELETE FROM "mcp_servers" WHERE "builtin_key" = 'github';
