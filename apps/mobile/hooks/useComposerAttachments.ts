import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import {
  uploadAttachment,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  ATTACHMENT_MIMES,
  type AttachmentRef,
  type UploadedAttachment,
} from '@shannon/api-client';
import { useToastHelper } from './useToastHelper';
import { nativeAttachmentFile } from '@/lib/attachmentUpload';

/** Longest edge an attached image is allowed to keep — larger originals are
 * downscaled client-side before upload. */
const MAX_EDGE = 2048;

export interface PendingAttachment {
  /** Stable key for this item — the local file URI it was picked from. */
  localUri: string;
  mime: string;
  ref?: string;
  status: 'uploading' | 'ready' | 'error';
  error?: string;
}

/** Web only (see `upload` below) — fetches a blob: URI into a Blob carrying
 * exactly `mime` as its type, which has to be right for the server's
 * multipart mime check and isn't something `fetch`'s own type-sniffing can
 * be trusted for. */
async function readAsBlob(uri: string, mime: string): Promise<Blob> {
  const res = await fetch(uri);
  const raw = await res.blob();
  return raw.type === mime ? raw : new Blob([raw], { type: mime });
}

/** Resizes/converts a picked asset so it satisfies the server's accepted
 * mimes and the max-edge cap. GIFs are left alone — resizing would strip
 * the animation, and the size cap below still applies to them. */
async function normalize(asset: ImagePicker.ImagePickerAsset): Promise<{ uri: string; mime: string }> {
  const mime = asset.mimeType;
  if (mime === 'image/gif') return { uri: asset.uri, mime };

  const longestEdge = Math.max(asset.width, asset.height);
  const isAllowedMime = !!mime && (ATTACHMENT_MIMES as readonly string[]).includes(mime);
  if (isAllowedMime && longestEdge <= MAX_EDGE) return { uri: asset.uri, mime };

  // Either too large or in a format the server won't accept (e.g. iOS HEIC)
  // — re-encode as JPEG, resizing only if it's actually oversized.
  let ctx = ImageManipulator.manipulate(asset.uri);
  if (longestEdge > MAX_EDGE) {
    ctx = asset.width >= asset.height ? ctx.resize({ width: MAX_EDGE }) : ctx.resize({ height: MAX_EDGE });
  }
  const rendered = await ctx.renderAsync();
  // base64: true rather than re-reading saved.uri off disk afterward — that
  // second read is a `fetch()` of the manipulator's own cache file, and it
  // was observed failing with "Network request failed" on-device (iOS,
  // Expo Go), plausibly the same memory pressure that also intermittently
  // kills and relaunches Expo Go around a large camera photo. A data URI
  // comes back in the same call, no disk round-trip to go stale.
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.85, base64: true });
  if (!saved.base64) throw new Error('Image processing did not return image data');
  return { uri: `data:image/jpeg;base64,${saved.base64}`, mime: 'image/jpeg' };
}

export function useComposerAttachments() {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const { showToast } = useToastHelper();

  /** Object URLs minted by addWebFiles, which are the only local URIs here
   * that own anything — a blob: URL pins its File's bytes in memory until it
   * is revoked, and nothing revokes it on navigation. Kept in a ref rather
   * than derived from `items` so remove()/reset() can release without taking
   * `items` as a dependency and changing identity on every render. Native
   * URIs are file:// paths and never land in this set, so the web-only
   * revokeObjectURL is never reached off web. */
  const objectUrls = useRef<Set<string>>(new Set());

  const release = useCallback((localUri: string) => {
    if (!objectUrls.current.delete(localUri)) return;
    URL.revokeObjectURL(localUri);
  }, []);

  const releaseAll = useCallback(() => {
    for (const uri of objectUrls.current) URL.revokeObjectURL(uri);
    objectUrls.current.clear();
  }, []);

  // Unmounting the composer with images still pending would otherwise leak
  // every one of them for the life of the page.
  useEffect(() => releaseAll, [releaseAll]);

  const upload = useCallback(async (localUri: string, uri: string, mime: string) => {
    try {
      let uploaded: UploadedAttachment;
      if (Platform.OS === 'web') {
        // Web: a real Blob via fetch(uri).blob() is the standard, reliable
        // path — browsers stream a Blob through FormData/fetch natively.
        const blob = await readAsBlob(uri, mime).catch((e: unknown) => {
          throw new Error(`reading image: ${(e as Error).message}`);
        });
        if (blob.size > MAX_ATTACHMENT_BYTES) {
          release(localUri);
          setItems((prev) => prev.filter((i) => i.localUri !== localUri));
          showToast('That image is over 10 MB even after resizing');
          return;
        }
        uploaded = await uploadAttachment(blob).catch((e: unknown) => {
          throw new Error(`uploading (${String(blob.size)} bytes): ${(e as Error).message}`);
        });
      } else {
        // Native: hand the {uri, name, type} shape straight to FormData —
        // RN's own networking module streams the file (or decodes a data:
        // URI) directly. Building a Blob via fetch(uri).blob() first and
        // uploading *that* is the well-documented unreliable RN path (fails
        // client-side with the same generic "Network request failed" this
        // hook was hitting, with no request ever reaching the server). The
        // 10 MB pre-check is skipped here — normalize() already resizes to
        // MAX_EDGE, and the server enforces the real cap regardless.
        uploaded = await uploadAttachment(nativeAttachmentFile(uri, mime)).catch((e: unknown) => {
          throw new Error(`uploading: ${(e as Error).message}`);
        });
      }
      setItems((prev) =>
        prev.map((i) => (i.localUri === localUri ? { ...i, ref: uploaded.ref, mime: uploaded.mime, status: 'ready' } : i)),
      );
    } catch (err) {
      const message = (err as Error).message;
      setItems((prev) =>
        prev.map((i) => (i.localUri === localUri ? { ...i, status: 'error', error: message } : i)),
      );
      // Long enough to actually read a backend/runtime error message, not
      // just a short confirmation — same duration as the chat/agent error
      // toasts in useChatSession/useAgentSession.
      showToast(`Couldn't attach that image: ${message}`, 6000);
    }
  }, [showToast, release]);

  const addAssets = useCallback(
    async (assets: ImagePicker.ImagePickerAsset[]) => {
      for (const asset of assets) {
        setItems((prev) => {
          if (prev.length >= MAX_ATTACHMENTS) return prev;
          return [...prev, { localUri: asset.uri, mime: asset.mimeType ?? 'image/jpeg', status: 'uploading' }];
        });
        const { uri, mime } = await normalize(asset);
        void upload(asset.uri, uri, mime);
      }
    },
    [upload],
  );

  const pickFromLibrary = useCallback(async () => {
    if (items.length >= MAX_ATTACHMENTS) {
      showToast(`You can attach up to ${String(MAX_ATTACHMENTS)} images`);
      return;
    }
    // No permission request on iOS: PHPickerViewController (what
    // launchImageLibraryAsync uses there) never touches the photo library
    // directly — the OS hands back only what the user picks — so it needs
    // none. Android's picker still requires it. (Web has its own path via
    // AttachButton.web.tsx's file input and never reaches this function.)
    if (Platform.OS === 'android') {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        showToast('Photo library access is off — enable it in Settings to attach images');
        return;
      }
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: 'images',
      allowsMultipleSelection: true,
      selectionLimit: MAX_ATTACHMENTS - items.length,
    });
    if (!result.canceled) await addAssets(result.assets);
  }, [items.length, addAssets, showToast]);

  /** Web-only counterpart of addAssets: takes browser Files straight from
   * AttachButton.web.tsx's file input rather than an ImagePicker asset, so
   * there's no width/height to resize against — the server's own size and
   * mime checks still apply via `upload`. A plain counter (not a closure
   * flag mutated inside the setItems updater) is what decides whether a slot
   * is free: TS can't see through the updater to know it runs synchronously,
   * so a flag set there reads as permanently unset everywhere else. */
  const addWebFiles = useCallback(
    (files: File[]) => {
      let slots = MAX_ATTACHMENTS - items.length;
      for (const file of files) {
        if (slots <= 0) {
          showToast(`You can attach up to ${String(MAX_ATTACHMENTS)} images`);
          break;
        }
        if (!(ATTACHMENT_MIMES as readonly string[]).includes(file.type)) {
          showToast('Only JPEG, PNG, WebP, and GIF images are supported');
          continue;
        }
        slots -= 1;
        const localUri = URL.createObjectURL(file);
        objectUrls.current.add(localUri);
        setItems((prev) => [...prev, { localUri, mime: file.type, status: 'uploading' }]);
        void upload(localUri, localUri, file.type);
      }
    },
    [items.length, upload, showToast],
  );

  const takePhoto = useCallback(async () => {
    if (items.length >= MAX_ATTACHMENTS) {
      showToast(`You can attach up to ${String(MAX_ATTACHMENTS)} images`);
      return;
    }
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      showToast('Camera access is off — enable it in Settings to attach a photo');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: 'images' });
    if (!result.canceled) await addAssets(result.assets);
  }, [items.length, addAssets, showToast]);

  const remove = useCallback((localUri: string) => {
    release(localUri);
    setItems((prev) => prev.filter((i) => i.localUri !== localUri));
  }, [release]);

  const reset = useCallback(() => {
    releaseAll();
    setItems([]);
  }, [releaseAll]);

  const readyAttachments: AttachmentRef[] = useMemo(
    () =>
      items
        .filter((i): i is PendingAttachment & { ref: string } => i.status === 'ready' && !!i.ref)
        .map((i) => ({ ref: i.ref, mime: i.mime })),
    [items],
  );
  const uploading = items.some((i) => i.status === 'uploading');

  return { items, pickFromLibrary, takePhoto, addWebFiles, remove, reset, readyAttachments, uploading };
}
