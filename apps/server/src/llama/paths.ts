import path from "node:path";

/**
 * Where the managed llama.cpp runtime keeps its files.
 *
 * `LLAMA_DIR` unset falls back to `<cwd>/llama` — in a checkout that is
 * `apps/server/llama`, inside the working tree and gitignored for exactly
 * that reason, the same arrangement as `UPLOADS_DIR`. The desktop supervisor
 * and Compose both set it explicitly, beside the rest of their data, and never
 * inside an installed bundle an update would replace.
 *
 * Read at call time: the supervisor builds the child's environment late, and
 * tests point it at a temporary directory per suite.
 */
export function llamaDir(): string {
  const configured = process.env.LLAMA_DIR;
  return configured ? path.resolve(configured) : path.resolve(process.cwd(), "llama");
}

/** Downloaded weights, one directory per HuggingFace repo. */
export function modelsDir(): string {
  return path.join(llamaDir(), "models");
}

/** Installed llama.cpp builds, one directory per `<tag>-<backend>`. */
export function runtimeDir(): string {
  return path.join(llamaDir(), "runtime");
}

/** The preset file the router reads. The only file admin input reaches the
 * router through — see load-settings.ts. */
export function presetPath(): string {
  return path.join(llamaDir(), "models.ini");
}

/**
 * The on-disk directory for a repo's files. `repo` is validated as
 * `owner/name` before it gets here, so joining it cannot climb out of the
 * models directory — asserted anyway, because this path is also the one a
 * delete removes.
 */
export function repoDir(repo: string): string {
  const root = modelsDir();
  const dir = path.resolve(root, ...repo.split("/"));
  if (!dir.startsWith(root + path.sep)) throw new Error(`Refusing a model path outside ${root}`);
  return dir;
}

/** Where one of a repo's files lives. HuggingFace paths may contain
 * subdirectories (a quant per folder is common for split models). */
export function modelFilePath(repo: string, file: string): string {
  const dir = repoDir(repo);
  const full = path.resolve(dir, ...file.split("/"));
  if (!full.startsWith(dir + path.sep)) throw new Error(`Refusing a model file outside ${dir}`);
  return full;
}
