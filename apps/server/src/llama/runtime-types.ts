export interface RuntimeAsset {
  name: string;
  sha256: string;
  size: number;
}

export interface RuntimeBuild {
  asset: RuntimeAsset;
  /** A second archive unpacked into the same directory — Windows CUDA's
   * `cudart` runtime libraries. */
  extra?: RuntimeAsset;
}

export interface RuntimeManifest {
  /** The upstream release tag, e.g. `b11149`. */
  tag: string;
  commit: string | null;
  /** Keyed `<platform>-<arch>-<backend>`, where backend is `metal`, `vulkan`,
   * `cuda12`, `cuda13`, `rocm` or `cpu`. */
  builds: Record<string, RuntimeBuild>;
}
