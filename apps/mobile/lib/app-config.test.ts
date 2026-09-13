import { X509Certificate } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * app.config.js is what makes dev, beta and production three separate apps, and
 * every one of its outputs is load-bearing in a way that fails silently: a
 * wrong bundle identifier installs over the wrong app, and a wrong channel
 * header produces a build that receives updates nobody published to it. None
 * of that shows up until a real device has the wrong thing on it, so it is
 * asserted here instead.
 */
const require_ = createRequire(import.meta.url);
interface AppConfig {
  expo: Record<string, unknown>;
}
type ConfigFn = (args: { config: Record<string, unknown> }) => Record<string, unknown>;

const appJson = require_('../app.json') as AppConfig;
const configFn = require_('../app.config.js') as ConfigFn;

/** The shape Expo passes in: app.json's `expo` block, already parsed. */
function build(variant?: string) {
  if (variant === undefined) delete process.env.APP_VARIANT;
  else process.env.APP_VARIANT = variant;
  return configFn({ config: { ...appJson.expo } });
}

afterEach(() => {
  delete process.env.APP_VARIANT;
});

describe('app variants', () => {
  it.each([
    ['production', 'Loxaic', 'com.loxaic.app', 'loxaic', 'production'],
    ['beta', 'Loxaic Beta', 'com.loxaic.app.beta', 'loxaic-beta', 'beta'],
    ['dev', 'Loxaic Dev', 'com.loxaic.app.dev', 'loxaic-dev', 'dev'],
  ])('%s is its own app', (variant, name, id, scheme, channel) => {
    const config = build(variant);
    expect(config.name).toBe(name);
    expect(config.scheme).toBe(scheme);
    // Both platforms, because installing over the wrong app is the failure
    // this exists to prevent and it is per-platform.
    expect((config.ios as { bundleIdentifier: string }).bundleIdentifier).toBe(id);
    expect((config.android as { package: string }).package).toBe(id);
    expect((config.updates as { requestHeaders: Record<string, string> }).requestHeaders).toEqual({
      'expo-channel-name': channel,
    });
  });

  it('builds production when nothing asked for a variant', () => {
    // `expo start`, Expo Go, and a plain `expo export` all arrive here.
    const config = build(undefined);
    expect(config.name).toBe('Loxaic');
    expect((config.ios as { bundleIdentifier: string }).bundleIdentifier).toBe('com.loxaic.app');
  });

  it('refuses a variant it does not know rather than guessing', () => {
    // A typo in a build profile must not quietly ship as production.
    expect(() => build('prod')).toThrow(/APP_VARIANT="prod"/);
  });

  it.each(['constructor', 'toString', 'valueOf'])(
    'refuses %s, which a plain lookup would have found on the prototype',
    (key) => {
      // A prototype hit produced an app named `undefined`, the identifier
      // `com.loxaic.appundefined`, and — the one that costs a release — no
      // `expo-channel-name` header at all: a build following no channel, which
      // receives no updates for its whole life and says nothing about it.
      expect(() => build(key)).toThrow(/is not one of/);
    },
  );

  it('refuses an empty APP_VARIANT rather than defaulting it to production', () => {
    // What a declared-but-unset CI variable expands to. Defaulting it would
    // embed `production` in a build whose update CI publishes to `beta` — an
    // update that reaches nobody, silently. See the note in app.config.js.
    expect(() => build('')).toThrow(/APP_VARIANT=""/);
  });

  it('derives identifiers from app.json rather than repeating the base', () => {
    // app.json is the file that looks like the source of truth for identity;
    // hard-coding the base here made its copy dead, so a rename there would
    // have changed nothing while prebuild kept using the old identifier.
    const base = (appJson.expo.ios as { bundleIdentifier: string }).bundleIdentifier;
    const config = configFn({
      config: { ...appJson.expo, ios: { bundleIdentifier: 'com.example.renamed' } },
    });
    expect((config.ios as { bundleIdentifier: string }).bundleIdentifier).toBe(
      'com.example.renamed',
    );
    expect(base).not.toBe('com.example.renamed');
  });

  it('passes version through untouched, which is the release stamp contract', () => {
    // apps/desktop/scripts/stamp-version.mjs writes the tag into app.json and
    // nothing else; if this file ever computed a version, the stamp would be
    // writing to a field no build reads.
    expect(build('beta').version).toBe(appJson.expo.version);
  });

  it('keeps one slug and one EAS project across all three', () => {
    // Three slugs would mean three EAS projects, three sets of credentials,
    // and three places to publish an update to.
    for (const variant of ['production', 'beta', 'dev']) {
      const config = build(variant);
      expect(config.slug).toBe(appJson.expo.slug);
      expect((config.updates as { url: string }).url).toBe(
        (appJson.expo.updates as { url: string }).url,
      );
    }
  });

  it('records which variant it is, for anything that needs to ask at runtime', () => {
    expect((build('dev').extra as { variant: string }).variant).toBe('dev');
  });
});

/**
 * Update code signing: what a build will accept, and what publishing one costs.
 *
 * A build carrying the certificate runs an update only if the manifest was
 * signed by the matching private key — which lives in a password manager and a
 * GitHub environment secret, and never here. Getting any of this wrong is
 * silent on the machine that does it and loud only on someone's phone, weeks
 * later, so it is asserted rather than trusted.
 */
describe('update code signing', () => {
  const certPath = require_.resolve('../certs/certificate.pem');
  const certPem = readFileSync(certPath, 'utf8');

  it.each(['production', 'beta'])('%s embeds the certificate', (variant) => {
    const updates = build(variant).updates as Record<string, unknown>;
    expect(updates.codeSigningCertificate).toBe('./certs/certificate.pem');
    expect(updates.codeSigningMetadata).toEqual({ keyid: 'main', alg: 'rsa-v1_5-sha256' });
  });

  it('leaves the dev variant carrying no certificate key at all', () => {
    // Not `undefined` — absent. eas-cli decides whether a publish must be
    // signed by asking whether the resolved config *has* the key, so a
    // `codeSigningCertificate: undefined` left in place would make every dev
    // publish refuse to run without a private key the dev workflow
    // deliberately does not have.
    const updates = build('dev').updates as Record<string, unknown>;
    expect('codeSigningCertificate' in updates).toBe(false);
    expect('codeSigningMetadata' in updates).toBe(false);
  });

  it('points at a certificate that is actually there', () => {
    // The path is resolved twice by two different things — prebuild embeds the
    // file's contents, and eas update reads it to check the key it was handed
    // — and both fail late. Missing it here is the cheap place.
    const cert = new X509Certificate(certPem);
    expect(cert.subject).toContain('CN=Loxaic');
  });

  it('has years of validity left on the certificate', () => {
    // An expired certificate is the worst failure this file can produce: every
    // installed beta and production app stops accepting updates, and the only
    // fix is a new certificate, which needs a new native build and an app
    // store round trip. Two years of warning is enough to do that calmly; this
    // test going red is the warning.
    const validTo = new Date(new X509Certificate(certPem).validTo);
    const twoYears = Date.now() + 2 * 365 * 24 * 60 * 60 * 1000;
    expect(validTo.getTime()).toBeGreaterThan(twoYears);
  });

  it('keeps the private key out of the committed directory', () => {
    // `codesigning:generate` writes the key pair and the certificate into two
    // directories a flag apart, and only one of them is ignored. Committing
    // the private key would hand anyone who reads this repository the power to
    // publish an update every install runs — and no rotation is possible
    // without a new build of every app.
    for (const entry of readdirSync(dirname(certPath))) {
      const contents = readFileSync(join(dirname(certPath), entry), 'utf8');
      expect(contents).not.toContain('PRIVATE KEY');
    }
  });

  it('counts the certificate as a fingerprint source for signed variants only', () => {
    // Rotating the certificate has to move the runtime version, or an update
    // signed by the new key is offered to binaries carrying the old one, which
    // download and reject it forever. The config is per variant because the
    // dev app embeds no certificate and must not be rebuilt for a rotation
    // that cannot affect it.
    const fingerprintConfig = () => {
      // Uncached each time: it reads APP_VARIANT at require time, and
      // CommonJS would otherwise hand back whichever variant asked first.
      // Reflect.deleteProperty rather than `delete` on a computed key, which
      // the lint rules refuse — same operation, no escape hatch needed.
      Reflect.deleteProperty(require_.cache, require_.resolve('../fingerprint.config.js'));
      return require_('../fingerprint.config.js') as { extraSources: { filePath: string }[] };
    };
    for (const variant of ['production', 'beta']) {
      process.env.APP_VARIANT = variant;
      expect(fingerprintConfig().extraSources.map((s) => s.filePath)).toContain(
        'certs/certificate.pem',
      );
    }
    process.env.APP_VARIANT = 'dev';
    expect(fingerprintConfig().extraSources).toEqual([]);
  });
});
