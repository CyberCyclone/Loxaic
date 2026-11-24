import * as Location from 'expo-location';
import { Platform } from 'react-native';
import type { DeviceUnavailableReason } from '@loxaic/api-client';
import { reasonFromError } from './deviceRequest';

/**
 * This device's position for a location request (`get_location`), asking the
 * OS for permission the first time. Always answers: a position, or why there
 * is none — the model is told either way. Low accuracy is all the server
 * keeps (about a kilometre), and is quicker and gentler on a phone; GPS is
 * the fallback when that fails.
 *
 * On the web, browsers share a position only with a secure page (https or
 * localhost); Electron grants it, and on Linux has no source, which surfaces
 * as a timeout or an error.
 */
export type DevicePosition = { ok: true; lat: number; lon: number } | { ok: false; reason: DeviceUnavailableReason };

const POSITION_TIMEOUT_MS = 10_000;

function platformSupport(): { supported: boolean; secureContext: boolean } {
  if (Platform.OS !== 'web') return { supported: true, secureContext: true };
  const supported = typeof navigator !== 'undefined' && 'geolocation' in navigator;
  const secureContext = typeof window !== 'undefined' && window.isSecureContext;
  return { supported, secureContext };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('Location request timed out')); }, ms);
    work.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

export async function getDevicePosition(): Promise<DevicePosition> {
  const support = platformSupport();
  if (!support.supported || !support.secureContext) return { ok: false, reason: reasonFromError(null, support) };
  try {
    // Asked only when not already granted: on Android the request opens a
    // system activity even then, which sends the app to the background and
    // replaces its socket while the position is found.
    const current = await Location.getForegroundPermissionsAsync();
    const permission = current.status === Location.PermissionStatus.GRANTED ? current : await Location.requestForegroundPermissionsAsync();
    if (permission.status !== Location.PermissionStatus.GRANTED) return { ok: false, reason: 'permission_denied' };
    // Never Google Play's "improve location accuracy" dialog: it covers the
    // app, and the answer would wait on a screen nobody asked for. A phone
    // that cannot fix a position says so instead.
    const pos = await withTimeout(
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low, mayShowUserSettingsDialog: false }),
      POSITION_TIMEOUT_MS,
    );
    return { ok: true, lat: pos.coords.latitude, lon: pos.coords.longitude };
  } catch (err) {
    if (Platform.OS !== 'web') {
      // Low accuracy is a network fix, which a phone with network location
      // off (or an emulator) cannot give; GPS can, once.
      const precise = await withTimeout(
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High, mayShowUserSettingsDialog: false }),
        POSITION_TIMEOUT_MS,
      ).catch(() => null);
      if (precise) return { ok: true, lat: precise.coords.latitude, lon: precise.coords.longitude };
      // A phone indoors can take long to fix; a recent position is as good at
      // a kilometre. Not on the web, which has no such cache to ask.
      const last = await withTimeout(Location.getLastKnownPositionAsync({ maxAge: 10 * 60_000 }), 5_000).catch(() => null);
      if (last) return { ok: true, lat: last.coords.latitude, lon: last.coords.longitude };
    }
    return { ok: false, reason: reasonFromError(err, support) };
  }
}

/** This device's IANA zone, for the local time the model is told. */
export function deviceZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** What the OS says about location permission, for the settings screen. Never
 * asks. `unsupported`: no location on this device or page. */
export async function locationPermissionStatus(): Promise<'granted' | 'denied' | 'undetermined' | 'unsupported'> {
  const support = platformSupport();
  if (!support.supported || !support.secureContext) return 'unsupported';
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status === Location.PermissionStatus.GRANTED) return 'granted';
    if (status === Location.PermissionStatus.DENIED) return 'denied';
    return 'undetermined';
  } catch {
    return 'unsupported';
  }
}
