import fs from 'node:fs';
import crypto from 'node:crypto';
import { mergedCatalog, resolveCatalogPackage } from './store.mjs';
import { readPackageJsonFast } from '../scripts/lib/tar.mjs';

const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const NUM = '(?:0|[1-9]\\d*)';
const PRE = `(?:${NUM}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
const VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-${PRE}(?:\\.${PRE})*)?$`);
const text = (value) => typeof value === 'string' && value.trim() ? value : undefined;

export function marketCatalog() {
  const catalog = mergedCatalog();
  const packages = new Map();
  for (const plugin of catalog.plugins) {
    const { packageName, version } = plugin;
    if (typeof packageName !== 'string' || packageName.length > 214 || !NAME.test(packageName)
      || typeof version !== 'string' || !VERSION.test(version) || plugin.package.status !== 'ready') continue;
    const file = resolveCatalogPackage(plugin, catalog.site.platform);
    if (!file) continue;
    let versions = packages.get(packageName);
    if (!versions) packages.set(packageName, versions = new Map());
    const previous = versions.get(version);
    if (!previous || (previous.plugin.source !== 'admin' && plugin.source === 'admin')) {
      versions.set(version, { plugin, file });
    }
  }
  return { catalog, packages };
}

function timestamp(plugin) {
  const time = Math.floor(Date.parse(plugin.package.builtAt) / 1000);
  return time >= 0 && time < 1e11 ? time : 0;
}

export function marketIndex({ catalog, packages }, registry) {
  const categories = Object.fromEntries((catalog.categories || [])
    .filter((category) => text(category.id) && text(category.name))
    .map((category) => [category.id, { title: category.name }]));
  return {
    format: 1,
    title: text(catalog.site.name) || 'DSH 内网插件商店',
    metadata: { categories },
    plugins: [...packages].map(([name, versions]) => {
      const { plugin } = versions.values().next().value;
      return {
        name,
        title: text(plugin.title),
        description: text(plugin.summary),
        metadata: {
          category: Object.hasOwn(categories, plugin.category) ? plugin.category : undefined,
          keywords: Array.isArray(plugin.tags) ? plugin.tags.filter(text) : [],
        },
        versions: [...versions].map(([version, entry]) => ({
          version,
          publishTimestamp: timestamp(entry.plugin),
          source: { type: 'npm', registry },
        })),
      };
    }),
  };
}

// At most one manifest/integrity calculation per file revision, including concurrent requests.
const metadataCache = new Map();

async function readMetadata(file) {
  const stat = fs.statSync(file);
  const revision = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = metadataCache.get(file);
  if (cached?.revision === revision) return cached.result;
  const result = (async () => {
    const manifest = readPackageJsonFast(file);
    const hash = crypto.createHash('sha512');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return { manifest, integrity: `sha512-${hash.digest('base64')}` };
  })();
  if (metadataCache.size >= 256) metadataCache.clear();
  metadataCache.set(file, { revision, result });
  try {
    return await result;
  } catch (error) {
    if (metadataCache.get(file)?.result === result) metadataCache.delete(file);
    throw error;
  }
}

export async function packument(name, versions, registry) {
  const entries = await Promise.all([...versions].map(async ([version, entry]) => {
    const { manifest, integrity } = await readMetadata(entry.file);
    if (manifest?.name !== name || manifest.version !== version || !manifest.dsh?.bundle?.patch) {
      throw new Error(`目录和制品不一致：${name}@${version}`);
    }
    const tarball = new URL(`-/${encodeURIComponent(name)}/${encodeURIComponent(version)}.tgz`, registry).href;
    return [version, { ...manifest, dist: { tarball, integrity } }];
  }));
  const time = Object.fromEntries([...versions].map(([version, entry]) =>
    [version, new Date(timestamp(entry.plugin) * 1000).toISOString()]));
  const latest = [...versions.keys()].sort((a, b) =>
    b.localeCompare(a, 'en', { numeric: true }));
  return {
    name,
    'dist-tags': { latest: latest.find((version) => !version.includes('-')) || latest[0] },
    versions: Object.fromEntries(entries),
    time,
  };
}
