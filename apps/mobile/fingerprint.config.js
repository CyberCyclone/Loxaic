// Makes the update-signing certificate part of the runtime version, for the
// variants that embed it.
//
// The fingerprint hashes the app config, the dependency tree and the native
// projects — but `updates.codeSigningCertificate` is only a *path* in the
// config, and the file it points at is not otherwise a fingerprint input. So
// without this, replacing the certificate at that path would leave the runtime
// version unchanged, and an update signed with the new key would be offered to
// every binary carrying the old certificate. Each one would download it,
// reject the signature, and go on rejecting it forever — with no error
// anywhere but the device, and no way out but an update signed by a key those
// binaries no longer have.
//
// Counting the certificate makes rotating it behave like any other native
// change: a new runtime version, so old binaries simply stop being offered
// anything and stay on what they have until their owners install a new build.
//
// Only for a variant that embeds the certificate. The dev app does not (see
// app.config.js), so rotating the key says nothing about a dev build and must
// not cost it a rebuild.
const { variantFor } = require("./app.config.js");

module.exports = {
  extraSources: variantFor(process.env.APP_VARIANT).signed
    ? [
        {
          type: "file",
          filePath: "certs/certificate.pem",
          reasons: ["updates.codeSigningCertificate"],
        },
      ]
    : [],
};
