'use strict';

const Fastify = require('fastify');
const { Readable } = require('stream');

const PORT = parseInt(process.env.PORT ?? '4873', 10);
const UPSTREAM = 'https://registry.npmjs.org';
const CACHE_TTL_MS = 5 * 60 * 1000;       // 5 minutes
const MIN_AGE_MS  = 24 * 60 * 60 * 1000;  // 24 hours

// ── In-memory metadata cache ──────────────────────────────────────────────

const cache = new Map(); // pkgName → { val, exp }

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) { cache.delete(key); return null; }
  return entry.val;
}

function setCache(key, val) {
  cache.set(key, { val, exp: Date.now() + CACHE_TTL_MS });
}

/**
 * Fetch full package metadata from the upstream registry.
 * Results are cached for CACHE_TTL_MS.
 */
async function fetchMeta(pkg) {
  const hit = getCache(pkg);
  if (hit) return hit;

  const res = await fetch(`${UPSTREAM}/${encodeURIComponent(pkg)}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) return null;

  const data = await res.json();
  setCache(pkg, data);
  return data;
}

// ── URL parsing ───────────────────────────────────────────────────────────

/**
 * Parse an npm registry URL path into its components.
 *
 * Supported patterns:
 *   /pkg                          → { pkg, version: null,  type: 'meta'    }
 *   /@scope/pkg                   → { pkg, version: null,  type: 'meta'    }
 *   /pkg/1.2.3                    → { pkg, version: '1.2.3', type: 'ver'   }
 *   /pkg/latest                   → { pkg, version: 'latest', type: 'ver'  }
 *   /pkg/-/pkg-1.2.3.tgz          → { pkg, version: '1.2.3', type: 'tarball' }
 *   /@scope/pkg/-/pkg-1.2.3.tgz   → { pkg, version: '1.2.3', type: 'tarball' }
 *
 * Returns null for non-package paths (/-/…, /_/…, etc.).
 */
function parseUrl(rawUrl) {
  const path = rawUrl.split('?')[0].replace(/^\//, '');
  if (!path) return null;

  let pkg, rest;

  if (path.startsWith('@')) {
    // Scoped package: @scope/name[/rest]
    const m = path.match(/^(@[^/]+\/[^/]+)(\/(.*))?$/);
    if (!m) return null;
    pkg  = m[1];
    rest = m[3] ?? '';
  } else {
    const i = path.indexOf('/');
    pkg  = i < 0 ? path : path.slice(0, i);
    rest = i < 0 ? '' : path.slice(i + 1);
  }

  // Reject npm internal paths: /-/…  /_/…
  if (!pkg || pkg[0] === '-' || pkg[0] === '_') return null;

  if (!rest) return { pkg, version: null, type: 'meta' };

  if (rest.startsWith('-/')) {
    const ver = extractVersionFromFilename(rest.slice(2));
    return { pkg, version: ver, type: 'tarball' };
  }

  return { pkg, version: rest, type: 'ver' };
}

/**
 * Extract the semver version from a tarball filename.
 * e.g. "lodash-4.17.21.tgz" → "4.17.21"
 *      "babel-generator-6.26.1.tgz" → "6.26.1"
 *      "core-7.23.0.tgz" → "7.23.0"
 */
function extractVersionFromFilename(filename) {
  const base = filename.replace(/\.tgz$/, '');
  // Version is at the last dash that's followed by a digit then a dot (semver).
  const m = base.match(/^.+-(\d+\..+)$/);
  return m ? m[1] : null;
}

// ── Upstream proxy ────────────────────────────────────────────────────────

/**
 * Forward the request to the upstream registry and stream the response back.
 */
async function proxyUpstream(req, reply) {
  const url = `${UPSTREAM}${req.url}`;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k !== 'connection' && k !== 'host') headers[k] = v;
  }
  headers.host = 'registry.npmjs.org';

  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body != null) {
    // req.body is a Buffer (see wildcard content-type parser below)
    init.body = req.body;
  }

  const upstream = await fetch(url, init);

  reply.code(upstream.status);
  for (const [k, v] of upstream.headers.entries()) {
    if (k !== 'connection' && k !== 'transfer-encoding') reply.header(k, v);
  }

  if (!upstream.body) return reply.send('');
  return reply.send(Readable.fromWeb(upstream.body));
}

// ── Fastify app ───────────────────────────────────────────────────────────

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  // Disable the default JSON body parser so we can install a catch-all below
  bodyLimit: 100 * 1024 * 1024, // 100 MB (npm publish payloads can be large)
});

// Parse every incoming body as a raw Buffer so non-GET requests can be
// forwarded verbatim to the upstream registry (e.g. npm publish).
app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
  done(null, body);
});

// ── Routes ────────────────────────────────────────────────────────────────

app.get('/health', async () => ({
  status: 'ok',
  uptime: Math.floor(process.uptime()),
  timestamp: new Date().toISOString(),
  cachedPackages: cache.size,
}));

app.all('/*', async (req, reply) => {
  // Only inspect GET requests; pass writes (publish / unpublish) straight through
  if (req.method !== 'GET') return proxyUpstream(req, reply);

  const parsed = parseUrl(req.url);
  if (!parsed) return proxyUpstream(req, reply);

  const { pkg, version, type } = parsed;

  // ── Full metadata request ──────────────────────────────────────────────
  // Populate the cache so the subsequent tarball check is a cache hit.
  if (type === 'meta') {
    const meta = await fetchMeta(pkg);
    if (!meta) return proxyUpstream(req, reply);
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .send(meta);
  }

  // ── Version-specific or tarball request: enforce the 24-hour window ───

  const meta = await fetchMeta(pkg);
  if (!meta) return proxyUpstream(req, reply); // Can't verify → allow

  // Resolve a dist-tag (e.g. "latest" → "4.17.21")
  let resolvedVer = version;
  const distTags = meta['dist-tags'] ?? {};
  if (resolvedVer && distTags[resolvedVer]) {
    resolvedVer = distTags[resolvedVer];
  }

  // Check the publish timestamp
  const timeMap = meta.time;
  if (timeMap && resolvedVer && timeMap[resolvedVer]) {
    const publishedAt = new Date(timeMap[resolvedVer]);
    const ageMs = Date.now() - publishedAt.getTime();

    if (ageMs < MIN_AGE_MS) {
      const availableAt = new Date(publishedAt.getTime() + MIN_AGE_MS);
      const minutesAgo = Math.floor(ageMs / 60_000);

      reply.code(403);
      return {
        error: 'ERR_PACKAGE_TOO_NEW',
        message:
          `${pkg}@${resolvedVer} was published ${minutesAgo} minute(s) ago. ` +
          `Packages must be at least 24 hours old. ` +
          `Installation will be available at ${availableAt.toISOString()}.`,
        package: pkg,
        version: resolvedVer,
        publishedAt: publishedAt.toISOString(),
        availableAt: availableAt.toISOString(),
      };
    }
  }

  // Age check passed (or no time data) → proxy the request
  return proxyUpstream(req, reply);
});

// Catch-all fallback (handles '/' and any routes not matched above)
app.setNotFoundHandler(async (req, reply) => proxyUpstream(req, reply));

// ── Start ─────────────────────────────────────────────────────────────────

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`npm-proxy ready → http://0.0.0.0:${PORT}`);
  app.log.info(`Upstream registry: ${UPSTREAM}`);
  app.log.info(`Block window: 24 h | Cache TTL: 5 min`);
});
