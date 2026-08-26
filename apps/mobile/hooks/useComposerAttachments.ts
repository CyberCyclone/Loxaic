import { useCallback, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import {
  uploadAttachment,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  ATTACHMENT_MIMES,
  type AttachmentRef,
} from '@shannon/api-client';
import { useToastHelper } from './useToastHelper';

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

/** Fetches a local/blob URI into a Blob carrying exactly `mime` as its type
 * — the one thing that has to be right for the server's multipart mime
 * check, and not something `fetch`'s own type-sniffing can be trusted for
 * with a local file:// URI. Works identically on native (RN's fetch/Blob
 * support file:// and content:// URIs) and web. */
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
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
  return { uri: saved.uri, mime: 'image/jpeg' };
}

export function useComposerAttachments() {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const { showToast } = useToastHelper();

  const upload = useCallback(async (localUri: string, uri: string, mime: string) => {
    try {
      const blob = await readAsBlob(uri, mime);
      if (blob.size > MAX_ATTACHMENT_BYTES) {
        setItems((prev) => prev.filter((i) => i.localUri !== localUri));
        showToast('That image is over 10 MB even after resizing');
        return;
      }
      const uploaded = await uploadAttachment(blob);
      setItems((prev) =>
        prev.map((i) => (i.localUri === localUri ? { ...i, ref: uploaded.ref, mime: uploaded.mime, status: 'ready' } : i)),
      );
    } catch (err) {
      setItems((prev) =>
        prev.map((i) => (i.localUri === localUri ? { ...i, status: 'error', error: (err as Error).message } : i)),
      );
    }
  }, [showToast]);

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
    setItems((prev) => prev.filter((i) => i.localUri !== localUri));
  }, []);

  const reset = useCallback(() => { setItems([]); }, []);

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
