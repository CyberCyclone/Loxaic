/** How every permission check's instruction starts (check.ts), and how the
 * mock model recognises one. Its own module so the provider, which the check
 * imports, can read it without an import cycle. */
export const PERMISSION_CHECK_MARKER = "Permission check:";
