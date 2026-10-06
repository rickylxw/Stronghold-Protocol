// tools/update/apply.mjs — the part of the updater that touches the installed tree.
//
// The flow, in the order the launcher drives it:
//   stageUpdate()   unzip a verified package into app/.update-staging/pkg (zip-slip guarded),
//                   recording a ready.json marker — nothing outside the staging dir is touched yet.
//   applyStaged()   swap the staged tree into app/: old files that get overwritten or removed are
//                   copied to app/.update-backup first, the new files are copied over, files the new
//                   version no longer ships are deleted, the new manifest is written last. Files
//                   matching the PRESERVED rules (manifest.mjs) are never touched, so downloaded
//                   art, fonts, .env, caches and logs survive every update.
//   rollbackUpdate()  restore exactly the pre-apply tree from .update-backup (meta.json carries the
//                   old manifest, so even the manifest itself comes back).
//   finishUpdate()  delete backup + staging after the new server answered /healthz.
//
// Everything here runs BEFORE the server starts (scripts/launch.mjs): a running server never has
// its files swapped underneath it, and a failed apply is just a boot that reports and continues.

import { unzip } from 'fflate';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  buildManifest, isPreservedRel, readManifest, sanitizeRel,
} from './manifest.mjs';
import { compareVersions } from '../../shared/update.js';

const promisifyUnzip = (buf) => new Promise((resolve, reject) =>
  unzip(buf, (err, data) => (err ? reject(err) : resolve(data))));

const STAGING = '.update-staging';
const BACKUP = '.update-backup';
const MANIFEST = 'manifest.json';

const stagingDir = (appRoot) => path.join(appRoot, STAGING);
const pkgDir = (appRoot) => path.join(appRoot, STAGING, 'pkg');
const backupDir = (appRoot) => path.join(appRoot, BACKUP);

/**
 * Remove directories that deleting `rels` emptied, walking up the tree. Preserved dirs are never
 * pruned: their files are never deleted, so they cannot empty through this path anyway.
 */
async function pruneEmptyDirs(appRoot, rels) {
  for (const d of new Set(rels.map((rel) => path.dirname(rel)))) {
    for (let cur = d; cur && cur !== '.'; cur = path.dirname(cur) === cur ? '' : path.dirname(cur)) {
      if (isPreservedRel(`${cur}/`)) break;
      const abs = path.join(appRoot, cur);
      let entries;
      try { entries = await fsp.readdir(abs); } catch { break; }
      if (entries.length) break;
      await fsp.rm(abs, { recursive: true, force: true });
    }
  }
}

/**
 * Whether a fully downloaded package is waiting to be applied.
 * @param {string} appRoot
 */
export async function hasStagedUpdate(appRoot) {
  try {
    const j = JSON.parse(await fsp.readFile(path.join(stagingDir(appRoot), 'ready.json'), 'utf8'));
    return typeof j.version === 'string' && !!j.version;
  } catch {
    return false;
  }
}

/** The staged version, or null (used for the "detected a staged update" console line). */
export async function stagedVersion(appRoot) {
  try {
    const j = JSON.parse(await fsp.readFile(path.join(stagingDir(appRoot), 'ready.json'), 'utf8'));
    return typeof j.version === 'string' ? j.version : null;
  } catch {
    return null;
  }
}

/** The installed tree's version from manifest.json, or null (bundles from before the updater have none). */
export async function installedVersion(appRoot) {
  try {
    const j = JSON.parse(await fsp.readFile(path.join(appRoot, MANIFEST), 'utf8'));
    return typeof j.version === 'string' ? j.version : null;
  } catch {
    return null;
  }
}

/**
 * Unzip a sha256-verified update package into the staging directory.
 * @param {{ zipFile: string, appRoot: string, zipSha256: string }} o
 * @returns {Promise<{ version: string }>}
 */
export async function stageUpdate(o) {
  const pkg = pkgDir(o.appRoot);
  await fsp.rm(stagingDir(o.appRoot), { recursive: true, force: true });
  await fsp.mkdir(pkg, { recursive: true });

  const entries = await promisifyUnzip(await fsp.readFile(o.zipFile));
  let files = 0;
  for (const [name, content] of Object.entries(entries)) {
    const rel = sanitizeRel(name);
    if (!rel) continue;                                     // dir entry or unsafe path: skip, never follow
    const dest = path.join(pkg, rel);
    if (!dest.startsWith(pkg + path.sep) && dest !== pkg) continue;   // belt and braces under any path quirks
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, content);
    files++;
  }
  if (!files) throw new Error('更新包是空的');

  let manifest;
  try {
    manifest = await readManifest(path.join(pkg, MANIFEST));          // throws when the package has none
  } catch {
    throw new Error('更新包里没有有效的 manifest.json —— 它不是 make-update-package / make-windows-bundle 的产物，拒绝应用');
  }
  const staged = { version: manifest.version, stagedAt: new Date().toISOString(), zipSha256: o.zipSha256 };
  await fsp.writeFile(path.join(stagingDir(o.appRoot), 'ready.json'), JSON.stringify(staged));
  return { version: manifest.version };
}

/**
 * Swap the staged tree into `appRoot`. Requires the installed tree to have a manifest (a bundle
 * without one predates the updater and must not be mutated by guesswork).
 * @param {{ appRoot: string, log?: (msg: string) => void }} o
 * @returns {Promise<{ from: string, to: string, updated: number, added: number, deleted: number,
 *                     assetsChanged: boolean }>}
 */
export async function applyStaged(o) {
  const log = o.log || (() => {});
  const appRoot = o.appRoot;
  const next = await readManifest(path.join(pkgDir(appRoot), MANIFEST));
  const cur = await readManifest(path.join(appRoot, MANIFEST));
  if (compareVersions(next.version, cur.version) <= 0) {
    throw new Error(`拒绝应用更新：包版本 v${next.version} 不比已安装的 v${cur.version} 新`);
  }

  const updated = [];
  const added = [];
  for (const rel of Object.keys(next.files)) {
    if (isPreservedRel(rel)) continue;                      // a package that lists user files is not trusted for them
    (cur.files[rel] ? updated : added).push(rel);
  }
  const deleted = Object.keys(cur.files).filter((rel) => !next.files[rel] && !isPreservedRel(rel));

  // 1) everything the swap will overwrite or remove goes to .update-backup first
  const backup = backupDir(appRoot);
  await fsp.rm(backup, { recursive: true, force: true });
  let backedUp = 0;
  for (const rel of [...updated, ...deleted]) {
    const src = path.join(appRoot, rel);
    let st;
    try { st = await fsp.stat(src); } catch { continue; }    // already gone (crash between steps): nothing to save
    if (!st.isFile()) continue;
    const dst = path.join(backup, 'files', rel);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
    backedUp++;
  }
  const meta = {
    from: cur.version, to: next.version, updated, added, deleted,
    prevManifest: cur, appliedAt: new Date().toISOString(),
  };
  await fsp.writeFile(path.join(backup, 'meta.json'), JSON.stringify(meta));

  // 2) copy the new tree over
  for (const rel of [...updated, ...added]) {
    const dst = path.join(appRoot, rel);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(path.join(pkgDir(appRoot), rel), dst);
  }

  // 3) remove what the new version no longer ships (backed up already), then prune the directories
  //    the deletions emptied — node_modules churn would otherwise accumulate empty husks forever.
  for (const rel of deleted) {
    await fsp.rm(path.join(appRoot, rel), { force: true });
  }
  await pruneEmptyDirs(appRoot, deleted);

  // 4) the manifest is the swap's commit point — write it last
  await fsp.writeFile(path.join(appRoot, MANIFEST), JSON.stringify(next));
  log(`已应用更新 v${cur.version} → v${next.version}（更新 ${updated.length}，新增 ${added.length}，移除 ${deleted.length}，备份 ${backedUp}）`);

  const oldAssets = cur.files['data/assets.json'];
  const newAssets = next.files['data/assets.json'];
  const assetsChanged = !oldAssets || !newAssets || oldAssets.sha256 !== newAssets.sha256;
  return { from: cur.version, to: next.version, updated: updated.length, added: added.length, deleted: deleted.length, assetsChanged };
}

/**
 * Undo the last applyStaged() from .update-backup: restore every overwritten/deleted file, remove
 * the files the new version had added, put the old manifest back.
 * @returns {Promise<boolean>} false when there is no backup to restore
 */
export async function rollbackUpdate(appRoot) {
  const metaFile = path.join(backupDir(appRoot), 'meta.json');
  let meta;
  try {
    meta = JSON.parse(await fsp.readFile(metaFile, 'utf8'));
  } catch {
    return false;
  }
  const filesDir = path.join(backupDir(appRoot), 'files');
  let entries;
  try {
    entries = await fsp.readdir(filesDir, { withFileTypes: true });
  } catch (e) {
    if (e?.code === 'ENOENT') entries = [];                  // nothing was overwritten or removed
    else return false;                                       // backup tree unreadable: leave everything alone
  }
  const restore = async (abs, rel) => {
    for (const e of await fsp.readdir(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await restore(path.join(abs, e.name), childRel);
      else {
        const dst = path.join(appRoot, childRel);
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.copyFile(path.join(abs, e.name), dst);
      }
    }
  };
  await restore(filesDir, '');
  for (const rel of meta.added || []) {
    await fsp.rm(path.join(appRoot, rel), { force: true });
  }
  await pruneEmptyDirs(appRoot, meta.added || []);
  if (meta.prevManifest) {
    await fsp.writeFile(path.join(appRoot, MANIFEST), JSON.stringify(meta.prevManifest));
  }
  await fsp.rm(backupDir(appRoot), { recursive: true, force: true });
  return true;
}

/** The update is confirmed good (server answered /healthz): delete backup and staging. */
export async function finishUpdate(appRoot) {
  await fsp.rm(backupDir(appRoot), { recursive: true, force: true });
  await fsp.rm(stagingDir(appRoot), { recursive: true, force: true });
}

/**
 * Drop any half-finished staging state. Used when the launcher decides an update is not wanted
 * (user declined, downgrade marker, broken staging) — the next check starts clean.
 */
export async function discardStaged(appRoot) {
  await fsp.rm(stagingDir(appRoot), { recursive: true, force: true });
}

export { buildManifest };
