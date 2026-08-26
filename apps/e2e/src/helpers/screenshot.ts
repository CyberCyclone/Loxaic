/**
 * Named screenshots, written into a gitignored artifacts directory.
 *
 * These are the evidence a PR is expected to carry (see AGENTS.md, "End-to-end
 * tests"): capture at the moments that actually show the feature working, then
 * drag the PNGs into the PR description. They are never committed.
 *
 * Files are numbered in capture order so the directory reads as a storyboard
 * of the run rather than an unordered pile.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browser } from '@wdio/globals';
import { platform } from './selectors.ts';

const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** One directory per run, so consecutive runs don't overwrite each other. */
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');

let counter = 0;

export function runDir(): string {
  return path.join(E2E_DIR, 'artifacts', platform(), RUN_ID);
}

/** Captures the current screen as `NN-<name>.png`; returns the file path. */
export async function shot(name: string): Promise<string> {
  counter += 1;
  const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const file = path.join(runDir(), `${String(counter).padStart(2, '0')}-${slug}.png`);
  mkdirSync(path.dirname(file), { recursive: true });
  await browser.saveScreenshot(file);
  return file;
}
