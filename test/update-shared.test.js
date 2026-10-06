// test/update-shared.test.js — shared/update.js: the pure helpers of the self-update channel
// (version comparison, latest.json validation, GitHub proxy-prefix rules shared with the asset pipeline).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GITHUB_PROXY, compareVersions, normalizeProxyPrefix, parseLatestJson, parseVersion,
  proxiedUrl, releaseDownloadUrl, releaseNotesUrl, repoSlugFromUrl,
} from '../shared/update.js';

test('parseVersion / compareVersions: three-way order, v-prefixes, prereleases, unparseable input', () => {
  assert.deepEqual(parseVersion('0.1.3'), [0, 1, 3, '']);
  assert.deepEqual(parseVersion('v0.1.4-beta'), [0, 1, 4, 'beta']);
  assert.equal(parseVersion('latest'), null);
  assert.equal(parseVersion(''), null);

  assert.equal(compareVersions('0.1.3', '0.1.4'), -1);
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1);
  assert.equal(compareVersions('v0.1.3', '0.1.3'), 0);
  assert.equal(compareVersions('0.1', '0.1.0'), 0);            // missing patch counts as 0
  assert.equal(compareVersions('0.1.4-beta', '0.1.4'), -1);    // prerelease before its release
  assert.equal(compareVersions('0.1.4-beta', '0.1.4-rc'), -1); // unknown suffixes compare lexicographically
  assert.equal(compareVersions('garbage', '0.1.4'), 0);        // unparseable never reports an update
});

test('repoSlugFromUrl: the forms package.json repository values come in', () => {
  assert.equal(repoSlugFromUrl('git+https://github.com/sganggs/Stronghold-Protocol.git'), 'sganggs/Stronghold-Protocol');
  assert.equal(repoSlugFromUrl('https://github.com/o/r'), 'o/r');
  assert.equal(repoSlugFromUrl('git@github.com:o/r.git'), 'o/r');
  assert.equal(repoSlugFromUrl({ url: 'git+https://github.com/o/r.git' }), 'o/r');
  assert.equal(repoSlugFromUrl('https://gitlab.com/o/r.git'), null);
  assert.equal(repoSlugFromUrl(undefined), null);
});

test('normalizeProxyPrefix: default, trailing slash, opt-out, and refusal of unsafe prefixes', () => {
  assert.equal(normalizeProxyPrefix(), 'https://gh-proxy.com/');
  assert.equal(normalizeProxyPrefix('https://my.proxy/prefix'), 'https://my.proxy/prefix/');
  assert.equal(normalizeProxyPrefix(''), '');       // empty string = explicitly disabled
  assert.equal(normalizeProxyPrefix('   '), '');
  assert.throws(() => normalizeProxyPrefix('http://insecure/'));
  assert.throws(() => normalizeProxyPrefix('https://x/?q=1'));
});

test('proxiedUrl: only public GitHub download URLs, never prefixed twice, disabled by empty prefix', () => {
  const zip = 'https://github.com/sganggs/Stronghold-Protocol/releases/download/v0.1.4/code.zip';
  assert.equal(proxiedUrl(zip), `${DEFAULT_GITHUB_PROXY}${zip}`);
  assert.equal(proxiedUrl('https://raw.githubusercontent.com/o/r/main/f.png'), `${DEFAULT_GITHUB_PROXY}https://raw.githubusercontent.com/o/r/main/f.png`);
  assert.equal(proxiedUrl('https://example.com/x.zip'), null);
  assert.equal(proxiedUrl(zip, ''), null);                       // proxy disabled → direct
  assert.equal(proxiedUrl(zip, DEFAULT_GITHUB_PROXY), `${DEFAULT_GITHUB_PROXY}${zip}`); // idempotent-safe
});

test('parseLatestJson: accepts a well-formed payload and derives urls from the slug when absent', () => {
  const good = {
    version: 'v0.2.0',
    zip: 'stronghold-protocol-code-v0.2.0.zip',
    sha256: 'A'.repeat(64),
  };
  const parsed = parseLatestJson(JSON.stringify(good), { slug: 'sganggs/Stronghold-Protocol' });
  assert.equal(parsed.version, '0.2.0');
  assert.equal(parsed.sha256, 'a'.repeat(64));
  assert.equal(parsed.url, releaseDownloadUrl('sganggs/Stronghold-Protocol', '0.2.0', good.zip));
  assert.equal(parsed.notes, releaseNotesUrl('sganggs/Stronghold-Protocol', '0.2.0'));
});

test('parseLatestJson: refuses payloads that would send the updater somewhere wrong', () => {
  const slug = 'sganggs/Stronghold-Protocol';
  const bad = (patch) => {
    const j = { version: '0.2.0', zip: 'stronghold-protocol-code-v0.2.0.zip', sha256: 'a'.repeat(64), ...patch };
    return () => parseLatestJson(JSON.stringify(j), { slug });
  };
  assert.throws(bad({ version: 'latest' }), /bad version/);
  assert.throws(bad({ sha256: 'tooshort' }), /sha256/);
  assert.throws(bad({ zip: '../evil.zip' }), /bad zip name/);
  assert.throws(bad({ url: 'http://github.com/x/stronghold-protocol-code-v0.2.0.zip' }), /https/);
  // a url that does not point at the declared zip could swap the payload for something else
  assert.throws(bad({ url: 'https://github.com/sganggs/Stronghold-Protocol/releases/download/v0.2.0/other.zip' }), /declared zip/);
  // no slug and no url → nothing verifiable to build on
  const j = { version: '0.2.0', zip: 'stronghold-protocol-code-v0.2.0.zip', sha256: 'a'.repeat(64) };
  assert.throws(() => parseLatestJson(JSON.stringify(j)), /no url/);
  assert.throws(() => parseLatestJson('not json'), /JSON/);
});
