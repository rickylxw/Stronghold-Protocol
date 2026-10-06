// test/update-check.test.js — server/updateCheck.js: the multi-source "is there a newer release?"
// check (override → jsDelivr → GitHub API) and the /healthz watcher built on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkForUpdate, createUpdateWatcher, repoSlug, updateCheckDisabled } from '../server/updateCheck.js';
import { jsDelivrLatestUrl, releasesApiUrl } from '../shared/update.js';

const SLUG = 'sganggs/Stronghold-Protocol';
const LATEST = (version) => JSON.stringify({
  version,
  zip: `stronghold-protocol-code-v${version}.zip`,
  sha256: 'a'.repeat(64),
  notes: `https://github.com/${SLUG}/releases/tag/v${version}`,
});
const JSDELIVR = jsDelivrLatestUrl(SLUG);
const API = releasesApiUrl(SLUG);

/** A fetch that answers from a routing table; unmatched URLs and `fail: true` simulate outages. */
const router = (routes) => async (url) => {
  const r = routes[url];
  if (!r || r.fail) throw new Error(`offline: ${url}`);
  return { ok: true, status: 200, text: async () => (typeof r === 'string' ? r : r.body) };
};

test('checkForUpdate: jsDelivr is the primary source and only a NEWER version counts', async () => {
  const r = await checkForUpdate({ slug: SLUG, currentVersion: '0.1.3', fetchImpl: router({ [JSDELIVR]: LATEST('0.2.0') }) });
  assert.equal(r.source, 'jsdelivr');
  assert.equal(r.available, true);
  assert.equal(r.version, '0.2.0');
  assert.equal(r.sha256, 'a'.repeat(64));
  assert.match(r.notes, /tag\/v0\.2\.0$/);

  const same = await checkForUpdate({ slug: SLUG, currentVersion: '0.2.0', fetchImpl: router({ [JSDELIVR]: LATEST('0.2.0') }) });
  assert.equal(same.available, false);
  assert.equal(same.version, null);            // a non-update must not leak a version into /healthz

  const older = await checkForUpdate({ slug: SLUG, currentVersion: '0.3.0', fetchImpl: router({ [JSDELIVR]: LATEST('0.2.0') }) });
  assert.equal(older.available, false);
});

test('checkForUpdate: falls back to the GitHub API, using its latest.json asset when it has one', async () => {
  const assetUrl = `https://github.com/${SLUG}/releases/download/v0.2.0/latest.json`;
  const routes = {
    [JSDELIVR]: { fail: true },
    [API]: JSON.stringify({
      tag_name: 'v0.2.0',
      html_url: `https://github.com/${SLUG}/releases/tag/v0.2.0`,
      assets: [{ name: 'latest.json', browser_download_url: assetUrl }],
    }),
    [assetUrl]: LATEST('0.2.0'),
  };
  const r = await checkForUpdate({ slug: SLUG, currentVersion: '0.1.3', fetchImpl: router(routes) });
  assert.equal(r.source, 'github-api');
  assert.equal(r.available, true);
  assert.equal(r.url, `https://github.com/${SLUG}/releases/download/v0.2.0/stronghold-protocol-code-v0.2.0.zip`);
});

test('checkForUpdate: an API release without a latest.json asset still yields a badge (no download)', async () => {
  const routes = {
    [JSDELIVR]: { fail: true },
    [API]: JSON.stringify({ tag_name: 'v0.2.0', html_url: `https://github.com/${SLUG}/releases/tag/v0.2.0`, assets: [] }),
  };
  const r = await checkForUpdate({ slug: SLUG, currentVersion: '0.1.3', fetchImpl: router(routes) });
  assert.equal(r.available, true);
  assert.equal(r.version, '0.2.0');
  assert.equal(r.url, null, 'no asset → no download URL: the launcher must point at Releases instead');
  assert.equal(r.sha256, null);
});

test('checkForUpdate: every source failing is a quiet no-update, with the reasons recorded', async () => {
  const r = await checkForUpdate({ slug: SLUG, currentVersion: '0.1.3', fetchImpl: router({}) });
  assert.equal(r.available, false);
  assert.equal(r.version, null);
  assert.match(r.error, /jsdelivr/);
  assert.match(r.error, /github-api/);
});

test('checkForUpdate: SP_UPDATE_CHECK_URL (passed as checkUrl) wins over the built-in sources', async () => {
  const mine = 'https://updates.example.invalid/latest.json';
  const r = await checkForUpdate({
    slug: SLUG, currentVersion: '0.1.3', checkUrl: mine,
    fetchImpl: router({ [mine]: LATEST('9.9.9'), [JSDELIVR]: LATEST('0.2.0') }),
  });
  assert.equal(r.source, 'override');
  assert.equal(r.version, '9.9.9');
});

test('repoSlug: reads package.json at the given root, null when there is none', async (t) => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'sp-slug-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ repository: 'git+https://github.com/o/r.git' }));
  assert.equal(await repoSlug(dir), 'o/r');
  await rm(join(dir, 'package.json'));
  assert.equal(await repoSlug(dir), null);
});

test('updateCheckDisabled: SP_NO_UPDATE_CHECK follows the usual 1/true/yes convention', () => {
  assert.equal(updateCheckDisabled({}), false);
  assert.equal(updateCheckDisabled({ SP_NO_UPDATE_CHECK: '1' }), true);
  assert.equal(updateCheckDisabled({ SP_NO_UPDATE_CHECK: 'yes' }), true);
  assert.equal(updateCheckDisabled({ SP_NO_UPDATE_CHECK: '0' }), false);
});

test('createUpdateWatcher: /healthz.latest only carries a newer release; disabled means silent', async () => {
  // a newer release lands in the watcher state shortly after start()
  const w = createUpdateWatcher({ slug: SLUG, currentVersion: '0.1.3', fetchImpl: router({ [JSDELIVR]: LATEST('0.2.0') }), env: {} });
  assert.equal(w.latest(), null);
  w.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(w.latest(), { version: '0.2.0', notes: `https://github.com/${SLUG}/releases/tag/v0.2.0` });
  w.stop();

  // no newer release → latest() stays null even though the check ran
  const w2 = createUpdateWatcher({ slug: SLUG, currentVersion: '0.2.0', fetchImpl: router({ [JSDELIVR]: LATEST('0.2.0') }), env: {} });
  w2.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(w2.latest(), null);
  w2.stop();

  // SP_NO_UPDATE_CHECK: start() is a no-op, no fetch happens at all
  let fetched = 0;
  const w3 = createUpdateWatcher({
    slug: SLUG, env: { SP_NO_UPDATE_CHECK: '1' },
    fetchImpl: async (u) => { fetched++; throw new Error(u); },
  });
  w3.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fetched, 0);
  assert.equal(w3.latest(), null);
});
