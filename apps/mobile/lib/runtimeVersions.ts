import type {
  CustomRuntimeBuild,
  LocalModelsSettings,
  LocalRuntimeView,
  RuntimeReleaseRow,
  RuntimeVersionDownload,
  RuntimeVersionsView,
} from '@loxaic/api-client';

/**
 * Every decision the llama.cpp version picker makes, as functions of what the
 * server said — the components only draw them. Which row may be switched to,
 * which may be downloaded and why not, what the card says about the version
 * that is running, and what a switch does.
 */

/** Said wherever a version other than the bundled one can be chosen. */
export const VERSION_CAVEAT =
  'Loxaic is tested with the bundled version. Another version may not start, may ignore some model settings, ' +
  'and shows no memory placement detail. You can switch back at any time.';

/** What follows "llama.cpp" on the runtime card. */
export function versionLabel(runtime: Pick<LocalRuntimeView, 'tag' | 'version'>): string {
  const v = runtime.version;
  // An older server has only the one version, and says it in `tag`.
  if (!v) return runtime.tag;
  if (v.kind === 'external') return "the container's own build";
  if (v.kind === 'custom') return `${v.name ?? 'a third-party build'} (third-party)`;
  if (v.kind === 'official') return `${v.tag ?? runtime.tag} (chosen)`;
  return v.tag ?? runtime.tag;
}

export interface ChangeVersionControl {
  /** Whether the button is drawn at all. */
  show: boolean;
  disabled: boolean;
  /** Why it cannot be used, or why there is no button. */
  note: string | null;
}

/**
 * Whether the card offers "Change version". Not from a server that predates
 * it; not where the server does not run llama.cpp itself, with the reason; and
 * read-only, with the reason, where the operator pinned the version.
 */
export function changeVersionControl(
  runtime: Pick<LocalRuntimeView, 'mode' | 'version'>,
  settings?: Pick<LocalModelsSettings, 'envOverrides'>,
): ChangeVersionControl {
  const v = runtime.version;
  if (!v) return { show: false, disabled: true, note: null };
  if (runtime.mode === 'attach' || v.kind === 'external') {
    return {
      show: false,
      disabled: true,
      note: "This server uses a separate llama.cpp container, so its version is that container's image. Change it in Compose.",
    };
  }
  if (runtime.mode !== 'managed') return { show: false, disabled: true, note: null };
  if (v.envPinned || settings?.envOverrides.runtime) {
    return { show: true, disabled: true, note: 'The version is set by the LLAMA_RUNTIME_TAG environment variable.' };
  }
  return { show: true, disabled: false, note: null };
}

/** The card's line when Loxaic's own version has moved past the chosen one. */
export function bundledNewerNote(runtime: Pick<LocalRuntimeView, 'version'>): string | null {
  const v = runtime.version;
  if (!v?.bundledNewer) return null;
  return `The bundled version is now ${v.bundledTag}, newer than the one chosen here.`;
}

/** Whether the card offers "Switch back to the bundled version": only when
 * the chosen build is what stands between the admin and a working runtime. */
export function offersRevert(runtime: Pick<LocalRuntimeView, 'state' | 'version' | 'restart'>): boolean {
  return runtime.state === 'error' && !runtime.restart && runtime.version?.canRevert === true;
}

export type RowAction =
  /** Running, or set to run. */
  | { kind: 'in-use' }
  | { kind: 'switch' }
  | { kind: 'downloading'; percent: number | null }
  | { kind: 'download'; retry: boolean }
  /** Cannot be installed here; `reason` says why. */
  | { kind: 'unavailable'; reason: string };

function percent(d: RuntimeVersionDownload): number | null {
  if (d.totalBytes <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((d.doneBytes / d.totalBytes) * 100)));
}

export function downloadForTag(downloads: readonly RuntimeVersionDownload[] | undefined, tag: string): RuntimeVersionDownload | null {
  return downloads?.find((d) => d.kind === 'official' && d.tag === tag) ?? null;
}

export function downloadForCustom(downloads: readonly RuntimeVersionDownload[] | undefined, id: string): RuntimeVersionDownload | null {
  return downloads?.find((d) => d.kind === 'custom' && d.customId === id) ?? null;
}

const UNAVAILABLE: Record<Exclude<RuntimeReleaseRow['availability'], 'ok'>, string> = {
  'no-build': 'No build for this machine',
  'no-checksum': 'No checksum published',
};

/** What an official release's row offers. A live download wins over what the
 * list said, which may be a few seconds older. */
export function releaseAction(row: ListedRelease, downloads: readonly RuntimeVersionDownload[] | undefined): RowAction {
  if (row.inUse) return { kind: 'in-use' };
  const d = downloadForTag(downloads, row.tag);
  if (d?.active) return { kind: 'downloading', percent: percent(d) };
  if (row.downloaded) return { kind: 'switch' };
  if (row.availability !== 'ok') return { kind: 'unavailable', reason: UNAVAILABLE[row.availability] };
  return { kind: 'download', retry: Boolean(d?.error) };
}

export function customAction(build: CustomRuntimeBuild, downloads: readonly RuntimeVersionDownload[] | undefined): RowAction {
  if (build.inUse) return { kind: 'in-use' };
  const d = downloadForCustom(downloads, build.id);
  if (d?.active) return { kind: 'downloading', percent: percent(d) };
  if (build.downloaded) return { kind: 'switch' };
  return { kind: 'download', retry: Boolean(d?.error) };
}

/** May this row's files be removed? Not what is in use, and not the bundled
 * release, which is what switching back needs. */
export function canDeleteRelease(row: ListedRelease): boolean {
  return row.downloaded && !row.inUse && !row.bundled;
}

/** A release as the picker lists it. `prerelease` is null for a release known
 * only from the disk: GitHub's flag is the only thing that says, and it was
 * not asked. */
export type ListedRelease = Omit<RuntimeReleaseRow, 'prerelease'> & { prerelease: boolean | null };

/**
 * The releases to list: the page(s) loaded, plus any downloaded release not
 * among them — what can be switched to must be visible without paging to it.
 * Those are shown first, as bare rows: all that is known is that they are on
 * this machine.
 *
 * One row per tag. Page one is asked for again whenever a download starts or
 * ends while older pages are kept, so a release published in between moves
 * the page boundary and the same tag arrives on two pages (found in review).
 */
export function releaseRows(view: RuntimeVersionsView, loaded: readonly RuntimeReleaseRow[], searching: boolean): ListedRelease[] {
  const selectedTag = view.selected.kind === 'official' ? view.selected.tag : null;
  // What is on disk and in use is from the newest answer, whichever page a
  // row first arrived on.
  const onDisk = new Set(view.official.downloadedTags);
  const have = new Set<string>();
  const rows: ListedRelease[] = [];
  for (const r of loaded) {
    if (r.bundled || have.has(r.tag)) continue;
    have.add(r.tag);
    rows.push({ ...r, downloaded: onDisk.has(r.tag), inUse: r.tag === selectedTag });
  }
  if (searching) return rows;
  const extra: ListedRelease[] = view.official.downloadedTags
    .filter((tag) => !have.has(tag) && tag !== view.bundled.tag)
    .map((tag) => ({
      tag,
      publishedAt: null,
      prerelease: null,
      availability: 'ok' as const,
      sizeBytes: null,
      bundled: false,
      downloaded: true,
      inUse: tag === selectedTag,
    }));
  return [...extra, ...rows];
}

/**
 * Whether "Pre-release" is said per row or once for the list.
 *
 * GitHub's flag is the only thing that says a release is a preview, and
 * llama.cpp sets it on every build it publishes (all thirty of the newest
 * page, checked against the real list). A pill on every row marks nothing, so
 * when every listed release carries the flag it is said once above the list;
 * when only some do, those rows are the ones labelled. Only rows whose flag
 * is known are counted: a downloaded release listed from the disk alone is
 * neither, and counting it as "not a pre-release" put a pill back on every
 * other row (found in review).
 */
export function prereleaseLabelling(rows: readonly Pick<ListedRelease, 'prerelease'>[]): { perRow: boolean; note: string | null } {
  const known = rows.filter((r) => r.prerelease !== null);
  const flagged = known.filter((r) => r.prerelease).length;
  if (flagged === 0) return { perRow: false, note: null };
  if (flagged === known.length && known.length > 1) {
    return { perRow: false, note: 'llama.cpp publishes every one of these builds marked as a pre-release.' };
  }
  return { perRow: true, note: null };
}

/** What to say about a list GitHub would not refresh. */
export function staleNote(stale: RuntimeVersionsView['official']['stale']): string | null {
  if (!stale) return null;
  const at = stale.retryAt ? new Date(stale.retryAt) : null;
  const when = at && !Number.isNaN(at.getTime()) ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  return when
    ? `GitHub is not answering right now, so this list may be out of date. Try again after ${when}.`
    : 'GitHub is not answering right now, so this list may be out of date.';
}

/** What switching does, said before it is done. */
export function switchWarning(target: { kind: 'bundled' } | { kind: 'official'; tag: string } | { kind: 'custom'; name: string }): {
  title: string;
  message: string;
  confirm: string;
} {
  const restart = 'The runtime restarts and every loaded model is unloaded; replies in progress on host models are cut off.';
  if (target.kind === 'bundled') {
    return {
      title: 'Switch back to the bundled version?',
      message: restart,
      confirm: 'Switch back',
    };
  }
  if (target.kind === 'custom') {
    return {
      title: `Switch to ${target.name}?`,
      message: `${restart} This is a third-party build: Loxaic has not tested it and cannot vouch for it. It may not start, or may behave differently.`,
      confirm: 'Switch',
    };
  }
  return {
    title: `Switch to llama.cpp ${target.tag}?`,
    message: `${restart} This version has not been tested with Loxaic: it may not start, or may ignore some model settings.`,
    confirm: 'Switch',
  };
}

/** The first eight and last four characters of a hash, enough to compare. */
export function shortHash(sha256: string | null | undefined): string | null {
  if (!sha256) return null;
  return sha256.length > 16 ? `${sha256.slice(0, 8)}…${sha256.slice(-4)}` : sha256;
}

/** Whether a third-party build's form can be sent, and why not. */
export function customBuildProblem(form: { name: string; url: string; sha256: string }): string | null {
  if (!form.name.trim()) return 'Give the build a name.';
  if (form.name.trim().length > 60) return 'The name can be at most 60 characters.';
  // The server decides what it will fetch from (https; it says so when it
  // refuses). This only catches what is plainly not a link.
  if (!/^https?:\/\/\S+$/i.test(form.url.trim())) return 'Enter the https:// link to the build\'s archive.';
  const sha = form.sha256.trim().toLowerCase().replace(/^sha256:/, '');
  if (sha && !/^[0-9a-f]{64}$/.test(sha)) return 'The SHA-256 must be 64 hexadecimal characters, or left empty.';
  return null;
}

/**
 * Which answers to the picker's list requests still count.
 *
 * Two kinds of request run side by side: the head of the list (page one, or a
 * search), asked again whenever a download starts or ends, and an older page
 * the admin asked for. One counter for both threw away a "Load older versions"
 * answer whenever a download started or finished meanwhile, with no error and
 * nothing to retry (found in review). Each kind now has its own latest
 * request, and the list's facts (what is downloaded and in use) are taken from
 * the newest answer of either kind.
 */
export interface ListRequest {
  readonly n: number;
  readonly axis: string;
}

export class ListRequests {
  private issued = 0;
  private latest = new Map<string, number>();
  private viewFrom = 0;

  start(opts: { page: number; q: string }): ListRequest {
    const axis = opts.q || opts.page === 1 ? 'head' : `page:${String(opts.page)}`;
    const n = ++this.issued;
    this.latest.set(axis, n);
    return { n, axis };
  }

  /** Whether nothing newer of the same kind has been asked since. */
  current(r: ListRequest): boolean {
    return this.latest.get(r.axis) === r.n;
  }

  /** Whether this answer is the newest one to describe the list. */
  takeView(r: ListRequest): boolean {
    if (!this.current(r) || r.n < this.viewFrom) return false;
    this.viewFrom = r.n;
    return true;
  }

  /** Everything asked so far no longer counts (the picker closed). */
  reset(): void {
    this.latest.clear();
    this.viewFrom = this.issued;
  }
}
