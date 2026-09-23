// electron-builder's config entry point. It validates this object against its
// own schema and rejects anything it does not recognise, so this file exports
// a config and nothing else — the variant table and the function over it live
// in scripts/builder-variants.cjs, where they can be imported by a test.
const { configFor, missingResources } = require("./scripts/builder-variants.cjs");

const config = configFor(process.env.LOXAIC_VARIANT);

// electron-builder packages on past a missing extraResources source with only
// a log line, which is how an app could ship without its licence notices.
// Refuse here instead, whichever way electron-builder was invoked.
const missing = missingResources(config, __dirname);
if (missing.length > 0) {
  throw new Error(
    `extraResources missing: ${missing.join(", ")}. ` +
      "Run the full `pnpm --filter @loxaic/desktop package` (or package:dir), which builds them — " +
      "the licence files come from build:notices.",
  );
}

module.exports = config;
