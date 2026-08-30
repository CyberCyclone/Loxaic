// Imported FIRST by admin-role.test.ts so ../index.ts sees ADMIN_EMAILS when
// it builds its module-load-time Set — mirrors
// mcp/__tests__/force-mock-inference.ts. ESM hoists import evaluation ahead
// of any of the importing file's own top-level statements, so setting
// process.env directly in the test file (before its own `import ../index.ts`
// line) would run too late; a separate side-effect-only module doesn't have
// that problem since its body *is* the first thing that runs.
export const ADMIN_EMAIL = `admin-emails-${String(Date.now())}@example.test`;
process.env.ADMIN_EMAILS = ADMIN_EMAIL;
