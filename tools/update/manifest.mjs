// tools/update/manifest.mjs — file manifests for the self-update channel.
//
// A manifest describes one installed tree: `{ manifestVersion, version, files: { rel: { sha256, bytes } } }`.
// It is written by scripts/make-windows-bundle.mjs (the whole app\ tree) and
// scripts/make-update-package.mjs (code + dependencies only), and is what lets
// applyStaged() know which files the new version ships, which files the old one
// had (→ the deletion list) and which files belong to the user's machine.
//
// The PRESERVED rules below are the safety net of the whole feature: apply/rollback never touch a
// preserved path, so user-local state — downloaded art, fonts, local 3D-board extractions, .env,
// caches, logs, the staging/backup dirs themselves — survives every update untouched.

import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const MANIFEST_VERSION = 1;

/**
 * Paths the updater must never overwrite, delete or extract into. Directory entries end with '/' and
 * match by prefix, file entries match exactly. Relative, posix separators, app-root relative.
 */
const PRESERVED = Object.freeze([
  'public/assets/',          // ~330 MB of art/audio fetched by tools/setup.mjs on the player's machine
  'public/fonts/',           // fetched fonts (rarely change; a version that ships new fonts re-runs setup)
  'data/local-assets.json',  // local 3D-board extraction manifest (only exists on machines that extracted)
  '.cache/',                 // download ledgers / node zip cache (source installs)
  '.env',                    // local configuration
  'scripts/service.env.cmd', // written by scripts/install-service-windows.ps1
  'logs/',                   // run-server.cmd service logs
  '.update-staging/',        // the updater's own scratch space
  '.update-backup/',         // the updater's rollback copy
  'manifest.json',           // rewritten by applyStaged() itself, never by a package entry
]);

/** @param {string} rel app-root relative posix path */
export function isPreservedRel(rel) {
  const p = String(rel);
  return PRESERVED.some((rule) => (rule.endsWith('/') ? p.startsWith(rule) : p === rule));
}

/**
 * Turn a zip entry name into a safe app-root-relative posix path, or null when it is not one.
 * Rejects directories, absolute paths, drive letters, and any '..' / '.' / empty segment — the
 * zip-slip guard: nothing extracted from an untrusted archive may leave the target directory.
 * @param {string} name
 * @returns {string|null}
 */
export function sanitizeRel(name) {
  const rel = String(name).replaceAll('\\', '/');
  if (!rel || rel.endsWith('/') || rel.includes('\0')) return null;
  if (/^[a-zA-Z]:/.test(rel) || rel.startsWith('/')) return null;
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return parts.join('/');
}

/** Normalize an on-disk relative path (already trusted) to the posix form used everywhere here. */
export function toPosixRel(rel) {
  return path.normalize(String(rel)).split(path.sep).join('/');
}

/** Read a manifest file, throwing when it does not look like one (old bundles have none). */
export async function readManifest(file) {
  const j = JSON.parse(await fsp.readFile(file, 'utf8'));
  if (!j || j.manifestVersion !== MANIFEST_VERSION || typeof j.version !== 'string'
    || !j.files || typeof j.files !== 'object') {
    throw new Error(`不是有效的更新清单（manifestVersion ${j?.manifestVersion}，版本 ${j?.version ?? '?'}）：${file}`);
  }
  return j;
}

/**
 * Hash every file under `dir` into a manifest. Skips `manifest.json` itself and the updater's own
 * `.update-*` dirs, so a manifest never describes its own hash or staged downloads.
 * @param {string} dir tree root (absolute)
 * @param {{ version?: string }} [o]
 */
export async function buildManifest(dir, { version = '' } = {}) {
  const files = {};
  const walk = async (abs, rel) => {
    for (const e of await fsp.readdir(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (childRel.startsWith('.update-')) continue;
        await walk(path.join(abs, e.name), childRel);
        continue;
      }
      if (!e.isFile() || childRel === 'manifest.json') continue;
      const buf = await fsp.readFile(path.join(abs, e.name));
      files[childRel] = { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
    }
  };
  await walk(dir, '');
  return { manifestVersion: MANIFEST_VERSION, version, files };
}
