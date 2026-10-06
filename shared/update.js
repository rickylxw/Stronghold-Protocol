// Pure helpers for the self-update channel (shared/update.js).
//
// A release ships a small `latest.json` at the repo root (also attached to the release itself). The
// updater reads it through three sources — an explicit override, the jsDelivr CDN, the GitHub API —
// and everything that must behave identically in all of them lives here: version comparison, the
// latest.json schema, and the GitHub proxy-prefix rules (same convention as tools/assets/sources.mjs,
// which re-exports from here).
//
// Kept import-free and side-effect-free on purpose: server/index.js may not import from tools/ (the
// Docker image does not carry tools/), and shared/ is served to the browser as-is.

/** Default prefix proxy for public GitHub download URLs (docs/DEPLOY.md「国内镜像下载」). */
export const DEFAULT_GITHUB_PROXY = 'https://gh-proxy.com/';

/**
 * Normalize a user-supplied proxy prefix into a trailing-slash HTTPS URL.
 * Empty / whitespace-only → '' (proxy disabled). Anything unsafe (non-HTTPS, credentials, query,
 * fragment) throws — the caller reports it instead of silently downloading through a mangled URL.
 * @param {string} [prefix]
 * @returns {string} '' to disable, else an https URL ending with '/'
 */
export function normalizeProxyPrefix(prefix = DEFAULT_GITHUB_PROXY) {
  if (String(prefix).trim() === '') return '';
  const url = new URL(prefix);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('GitHub proxy prefix must be an HTTPS URL without credentials, query or fragment');
  }
  return url.href.endsWith('/') ? url.href : url.href + '/';
}

function isGithubDownloadUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password &&
      ['github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.host);
  } catch { return false; }
}

/** Only public GitHub download URLs go through the proxy; never prefix twice (mirrors sources.mjs). */
export function proxiedUrl(url, prefix = DEFAULT_GITHUB_PROXY) {
  const normalized = normalizeProxyPrefix(prefix);
  if (!normalized || !isGithubDownloadUrl(url)) return null;
  return normalized + url;
}

/**
 * `owner/repo` from a package.json `repository` value (`git+https://github.com/o/r.git` → `o/r`).
 * @param {string|{ url?: string }|undefined} repository
 * @returns {string|null} null when the URL is not a public GitHub repo (forks without one disable the checker)
 */
export function repoSlugFromUrl(repository) {
  const url = typeof repository === 'string' ? repository : repository?.url;
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(String(url || ''));
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Parse a release version (`1`, `0.1.3`, `v0.1.4-beta.1`) into comparable numeric parts.
 * Extra segments compare lexicographically; a missing patch counts as 0.
 * @returns {number[]|null} null when the input is not a plausible version
 */
export function parseVersion(v) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-.](\w+))?$/.exec(String(v || '').trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0), m[4] ?? ''];
}

/**
 * Three-way version comparison for `a` vs `b`. A prerelease sorts before its own release
 * (`0.1.4-beta < 0.1.4`, as in semver); two prereleases compare their suffixes.
 * @returns {number} -1 when a < b, 1 when a > b, 0 when equal; unparseable input compares as 0
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  if (pa[3] !== pb[3]) {
    if (pa[3] && pb[3]) return pa[3] < pb[3] ? -1 : 1;
    return pa[3] ? -1 : 1;                                     // only one side is a prerelease
  }
  return 0;
}

/** jsDelivr copy of the repo-root latest.json (branch files are cached ~12 h; releases are rarer than that). */
export function jsDelivrLatestUrl(slug, branch = 'master') {
  return `https://cdn.jsdelivr.net/gh/${slug}@${branch}/latest.json`;
}

/** GitHub REST: the latest published (non-prerelease, non-draft) release. 60 req/h per IP unauthenticated. */
export function releasesApiUrl(slug) {
  return `https://api.github.com/repos/${slug}/releases/latest`;
}

/** Release landing page (update hints link here instead of shipping changelog text around). */
export function releaseNotesUrl(slug, version) {
  return `https://github.com/${slug}/releases/tag/v${String(version).replace(/^v/, '')}`;
}

/** Release asset URL for a file attached to the release tagged v<version>. */
export function releaseDownloadUrl(slug, version, file) {
  return `https://github.com/${slug}/releases/download/v${String(version).replace(/^v/, '')}/${file}`;
}

/**
 * Validate an untrusted latest.json payload.
 * @param {string} raw response body
 * @returns {{ version: string, zip: string, url: string, sha256: string, notes: string }}
 * @throws when the payload is malformed or points outside the release channel
 */
export function parseLatestJson(raw, { slug } = {}) {
  const j = JSON.parse(raw);
  const version = typeof j.version === 'string' ? j.version.trim().replace(/^v/, '') : '';
  if (!parseVersion(version)) throw new Error(`latest.json: bad version ${JSON.stringify(j.version)}`);
  const zip = typeof j.zip === 'string' ? j.zip.trim() : '';
  if (!/^[\w.-]+\.zip$/.test(zip)) throw new Error(`latest.json: bad zip name ${JSON.stringify(j.zip)}`);
  const sha256 = typeof j.sha256 === 'string' ? j.sha256.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('latest.json: missing or malformed sha256');
  const notes = typeof j.notes === 'string' && j.notes ? j.notes : (slug ? releaseNotesUrl(slug, version) : '');
  let url = typeof j.url === 'string' && j.url.trim() ? j.url.trim() : (slug ? releaseDownloadUrl(slug, version, zip) : '');
  if (url) {
    const parsed = new URL(url);                       // must be a plain https download of the named zip
    if (parsed.protocol !== 'https:') throw new Error('latest.json: url must be https');
    if (!parsed.pathname.endsWith(`/${encodeURIComponent(zip)}`) && !parsed.pathname.endsWith(`/${zip}`)) {
      throw new Error('latest.json: url does not point at the declared zip');
    }
  } else {
    throw new Error('latest.json: no url and no repo slug to build one from');
  }
  return { version, zip, url, sha256, notes };
}
