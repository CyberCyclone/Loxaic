import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DRIVER_PINS, parseInstalled, planDriver, platformsFor } from './setup-appium.ts';

const pin = DRIVER_PINS.android;

await describe('planDriver', async () => {
  await it('installs a driver that is not there', () => {
    assert.equal(planDriver(pin, undefined), 'install');
  });

  await it('keeps the pinned version', () => {
    assert.equal(planDriver(pin, { pkgName: pin.pkg, version: pin.version }), 'keep');
  });

  await it('replaces any other version, newer or older', () => {
    assert.equal(planDriver(pin, { pkgName: pin.pkg, version: '9.0.1' }), 'reinstall');
    assert.equal(planDriver(pin, { pkgName: pin.pkg, version: '8.6.0' }), 'reinstall');
  });

  await it('replaces a driver of the same name from another package, or one with no version', () => {
    assert.equal(planDriver(pin, { pkgName: 'someone-elses-uiautomator2', version: pin.version }), 'reinstall');
    assert.equal(planDriver(pin, {}), 'reinstall');
  });
});

await describe('platformsFor', async () => {
  await it('means both when none is named', () => {
    assert.deepEqual(platformsFor([]), ['android', 'ios']);
  });

  await it('takes the ones named, once each', () => {
    assert.deepEqual(platformsFor(['android']), ['android']);
    assert.deepEqual(platformsFor(['ios', 'android', 'ios']), ['android', 'ios']);
  });

  await it('refuses a name that is not a platform', () => {
    assert.throws(() => platformsFor(['andriod']), /unknown platform andriod/);
  });
});

await describe('parseInstalled', async () => {
  await it("reads Appium's JSON, past anything printed before it", () => {
    const out = `some banner\n${JSON.stringify({ uiautomator2: { pkgName: pin.pkg, version: '8.7.0' } })}\n`;
    assert.deepEqual(parseInstalled(out), { uiautomator2: { pkgName: pin.pkg, version: '8.7.0' } });
  });

  await it('reads an empty or unreadable listing as nothing installed', () => {
    assert.deepEqual(parseInstalled('{}'), {});
    assert.deepEqual(parseInstalled(''), {});
    assert.deepEqual(parseInstalled('not json {'), {});
  });
});

await describe('the pins', async () => {
  await it('are exact versions', () => {
    for (const p of Object.values(DRIVER_PINS)) assert.match(p.version, /^\d+\.\d+\.\d+$/);
  });
});
