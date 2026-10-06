// server/updateCheck.js — "is there a newer release?" checker for the server and the launcher.
//
// One question, three sources, tried in order (first success wins):
//   1. SP_UPDATE_CHECK_URL   — an explicit latest.json URL (self-hosted mirrors, testing).
//   2. jsDelivr CDN          — https://cdn.jsdelivr.net/gh/<slug>@master/latest.json; fast from CN
//                              networks, no rate limit; branch files cache ~12 h, which is nothing
//                              next to how often this game releases.
//   3. GitHub Releases API   — the release's latest.json asset; when that asset is missing the API
//                              metadata alone still yields version + notes (enough for the client
//                              badge, not enough to download — the updater then points at Releases).
//
// Checking NEVER throws and NEVER blocks anything: a failed check is a logged, quiet null. The
// watcher (createUpdateWatcher) is what /healthz serves from; launch.mjs runs the same one-shot
// check before starting the server so the update can be applied while nothing is running.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { APP_VERSION } from '../shared/constants.js';
import {
  compareVersions, jsDelivrLatestUrl, parseLatestJson, releasesApiUrl, repoSlugFromUrl,
} from '../shared/update.js';

/** Re-check cadence for long-running servers; a restart re-checks immediately. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** One source must give up within this budget so boot is never held up by a black-holed connection. */
export const CHECK_TIMEOUT_MS = 8_000;

/** Repo slug (`owner/repo`) from <root>/package.json, or null when this checkout has none. */
export async function repoSlug(root) {
  try {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    return repoSlugFromUrl(pkg.repository);
  } catch {
    return null;
  }
}

/** Whether SP_NO_UPDATE_CHECK opts the installation out of update checks entirely. */
export function updateCheckDisabled(env = process.env) {
  return /^(1|true|yes)$/i.test(String(env.SP_NO_UPDATE_CHECK ?? ''));
}

async function fetchText(fetchImpl, url, timeoutMs) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { try { ctrl?.abort(); } catch { /* ignore */ } }, timeoutMs);
  try {
    const res = await fetchImpl(url, { redirect: 'follow', signal: ctrl ? ctrl.signal : undefined });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One check across all sources. Never throws; an unreachable internet returns `{ available: false }`.
 * @param {{ currentVersion?: string, slug: string, fetchImpl?: Function, timeoutMs?: number,
 *           checkUrl?: string, branch?: string }} o
 * @returns {Promise<{ checkedAt: number, available: boolean, version: string|null, url: string|null,
 *                     sha256: string|null, notes: string|null, source: string|null, error?: string }>}
 */
export async function checkForUpdate(o = {}) {
  const currentVersion = o.currentVersion ?? APP_VERSION;
  const fetchImpl = o.fetchImpl || ((url, init) => globalThis.fetch(url, init));
  const timeoutMs = o.timeoutMs ?? CHECK_TIMEOUT_MS;
  const branch = o.branch || 'master';
  const out = { checkedAt: Date.now(), available: false, version: null, url: null, sha256: null, notes: null, source: null };

  const report = (patch, source) => {
    Object.assign(out, patch, { source });
    if (out.version) {
      out.available = compareVersions(out.version, currentVersion) > 0;
      if (!out.available) { out.version = null; out.url = null; out.sha256 = null; out.notes = null; }
    }
    return out;
  };

  // 1) explicit override — an operator pointing this installation at its own mirror
  const checkUrl = o.checkUrl ?? process.env.SP_UPDATE_CHECK_URL;
  if (checkUrl) {
    try {
      return report(parseLatestJson(await fetchText(fetchImpl, checkUrl, timeoutMs), { slug: o.slug }), 'override');
    } catch (e) {
      out.error = `override: ${e.message}`;
    }
  }

  // 2) jsDelivr copy of the committed latest.json
  try {
    return report(parseLatestJson(await fetchText(fetchImpl, jsDelivrLatestUrl(o.slug, branch), timeoutMs), { slug: o.slug }), 'jsdelivr');
  } catch (e) {
    out.error = out.error ? `${out.error}; jsdelivr: ${e.message}` : `jsdelivr: ${e.message}`;
  }

  // 3) GitHub API: latest release. Without a latest.json asset we can still tell the version —
  //    enough for the client badge, but url/sha256 stay null so nothing downloads unverified.
  try {
    const rel = JSON.parse(await fetchText(fetchImpl, releasesApiUrl(o.slug), timeoutMs));
    const tag = typeof rel.tag_name === 'string' ? rel.tag_name.replace(/^v/, '') : '';
    const meta = { version: tag || null, url: null, sha256: null, notes: rel.html_url || null };
    const asset = Array.isArray(rel.assets) && rel.assets.find((a) => a && a.name === 'latest.json');
    if (asset && tag) {
      const parsed = parseLatestJson(await fetchText(fetchImpl, asset.browser_download_url, timeoutMs), { slug: o.slug });
      if (compareVersions(parsed.version, tag) === 0) return report(parsed, 'github-api');
    }
    return report(meta, 'github-api');
  } catch (e) {
    out.error = out.error ? `${out.error}; github-api: ${e.message}` : `github-api: ${e.message}`;
  }

  return out;
}

/**
 * Long-lived checker for the server process: checks at startup and every UPDATE_CHECK_INTERVAL_MS,
 * keeps the newest known release in memory for /healthz. `.latest()` is `{ version, notes }` when a
 * NEWER release is known, else null — the client badge keys off its presence, so the server decides,
 * not the page.
 * @param {{ slug: string, log?: object, intervalMs?: number, currentVersion?: string, fetchImpl?: Function,
 *           env?: object }} o
 */
export function createUpdateWatcher(o = {}) {
  const log = o.log || console;
  const env = o.env ?? process.env;
  const intervalMs = o.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
  const disabled = updateCheckDisabled(env);
  let latest = null;   // { version, notes } | null
  let stopped = false;
  let timer = null;

  const run = async () => {
    const r = await checkForUpdate({ currentVersion: o.currentVersion, slug: o.slug, fetchImpl: o.fetchImpl });
    if (r.available && r.version) {
      latest = { version: r.version, notes: r.notes };
      log.info?.(`[update] 有新版本 v${r.version}（当前 v${o.currentVersion ?? APP_VERSION}）：${r.notes || r.url || ''}`);
    } else if (r.error) {
      log.debug?.(`[update] check failed: ${r.error}`);
    }
    return r;
  };

  return {
    /** Kick off the first check in the background and schedule the periodic re-check. */
    start() {
      if (disabled || stopped) return;
      run().catch((e) => log.debug?.(`[update] check failed: ${e?.message || e}`));
      timer = setInterval(() => { run().catch(() => {}); }, intervalMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
    },
    /** `{ version, notes }` when a newer release is known, else null. */
    latest() { return latest; },
  };
}
