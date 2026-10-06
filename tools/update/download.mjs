// tools/update/download.mjs — fetch an update zip to disk, verifying its sha256 while streaming.
//
// Design mirrors tools/assets/downloader.mjs where it applies to one big file: writes go to a
// `.part` sibling and are renamed into place only after the hash matches (a partial or corrupted
// download can never be mistaken for a complete one), network failures retry with backoff, and a
// third-party prefix proxy is opt-in only — the project's standing rule for GitHub downloads
// (docs/DEPLOY.md「国内镜像下载」) is "hint, never auto-switch". Resume is deliberately not
// implemented: the code zip is tens of MB, and a restarted download of that size is cheaper than
// the Range-request bookkeeping for an updater that runs once per release.

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { proxiedUrl } from '../../shared/update.js';

class HttpError extends Error {
  constructor(status, url) { super(`HTTP ${status} ${url}`); this.status = status; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Download `url` to `destFile`, sha256-verified.
 * @param {{ url: string, destFile: string, expectedSha256: string, mirror?: boolean,
 *           proxyPrefix?: string, fetchImpl?: Function, retries?: number, backoffMs?: number,
 *           log?: (msg: string) => void, onProgress?: (got: number, total: number) => void }} o
 * @returns {Promise<{ url: string, bytes: number, sha256: string }>} the URL that actually worked
 * @throws when every attempt fails, or the payload does not match `expectedSha256` (the caller must
 *   then assume the file on disk is hostile, not merely broken)
 */
export async function downloadUpdate(o) {
  const fetchImpl = o.fetchImpl || ((url, init) => globalThis.fetch(url, init));
  const log = o.log || (() => {});
  const retries = Math.max(1, Number(o.retries) || 3);
  const backoffMs = Math.max(0, Number(o.backoffMs) || 500);
  // mirror mode tries the prefix proxy first, then direct; direct mode never touches the proxy
  const candidates = o.mirror ? [proxiedUrl(o.url, o.proxyPrefix), o.url].filter(Boolean) : [o.url];

  let lastErr = null;
  for (const candidate of candidates) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const r = await once(fetchImpl, candidate, o);
        log(`下载完成：${path.basename(o.destFile)}（${(r.bytes / 1048576).toFixed(1)} MB，sha256 校验通过）`);
        return { ...r, url: candidate };
      } catch (e) {
        lastErr = e;
        if (e instanceof HashMismatch) throw e;        // wrong bytes will not get righter — surface it
        if (e instanceof HttpError && (e.status === 404 || e.status === 410)) break;  // mirror lacks the asset: try next source
        log(e instanceof HttpError ? e.message : `下载失败（第 ${attempt}/${retries} 次）：${e.message}`);
        if (attempt < retries) await sleep(backoffMs * 2 ** (attempt - 1));
      }
    }
  }
  throw lastErr ?? new Error('download failed');
}

class HashMismatch extends Error {}

async function once(fetchImpl, url, { destFile, expectedSha256, onProgress }) {
  await fsp.mkdir(path.dirname(destFile), { recursive: true });
  const partFile = `${destFile}.part`;
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new HttpError(res.status, url);

  const total = Number(res.headers.get('content-length')) || 0;
  const hash = createHash('sha256');
  let got = 0;
  const out = createWriteStream(partFile);
  try {
    const source = Readable.fromWeb(res.body);
    source.on('data', (chunk) => {
      hash.update(chunk);
      got += chunk.length;
      onProgress?.(got, total);
    });
    await pipeline(source, out);
  } catch (e) {
    await fsp.rm(partFile, { force: true });
    throw e;
  }

  const sha256 = hash.digest('hex');
  if (sha256 !== String(expectedSha256).toLowerCase()) {
    await fsp.rm(partFile, { force: true });
    throw new HashMismatch(`sha256 不匹配：期望 ${expectedSha256}，实际 ${sha256}`);
  }
  await fsp.rename(partFile, destFile);
  return { bytes: got, sha256 };
}
