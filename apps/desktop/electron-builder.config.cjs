// electron-builder's config entry point. It validates this object against its
// own schema and rejects anything it does not recognise, so this file exports
// a config and nothing else — the variant table and the function over it live
// in scripts/builder-variants.cjs, where they can be imported by a test.
const { configFor } = require("./scripts/builder-variants.cjs");

module.exports = configFor(process.env.LOXAIC_VARIANT);
