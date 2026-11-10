#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  BASE_CATALOG, IMPORT_CATALOG, IMPORT_DIR, importedPackage, resolveCatalogPackage,
} from '../lib/store.mjs';
import { readPackageJsonFast } from './lib/tar.mjs';

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const catalogName = 'catalog.json';

function readyPackages(catalog) {
  if (!Array.isArray(catalog.plugins) || !Array.isArray(catalog.categories)
    || !/^(linux|win32|darwin)-(x64|arm64)$/.test(catalog.site?.platform || '')) {
    throw new Error('目录缺少有效的平台、分类或插件列表');
  }
  const packages = catalog.plugins.filter((plugin) => plugin.package?.status === 'ready');
  if (!packages.length) throw new Error('目录没有可发布的制品');
  for (const plugin of packages) {
    const pkg = plugin.package;
    if (!importedPackage(pkg.sha256) || !Number.isSafeInteger(pkg.sizeBytes) || pkg.sizeBytes < 1) {
      throw new Error(`目录缺少制品摘要或大小：${plugin.id}`);
    }
  }
  return packages;
}

function bundleFile(dir, sha) {
  return path.join(dir, 'packages', `${sha}.tgz`);
}

async function verify(file, plugin) {
  const { sha256, sizeBytes } = plugin.package;
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size !== sizeBytes) {
    throw new Error(`制品缺失或大小不符：${plugin.id} (${sha256})`);
  }
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== sha256) throw new Error(`制品 SHA-256 不符：${plugin.id}`);
  const manifest = readPackageJsonFast(file);
  if (manifest?.name !== plugin.packageName || manifest.version !== plugin.version
    || !manifest.dsh?.bundle?.patch || Object.keys(manifest.dependencies || {}).length
    || Object.keys(manifest.optionalDependencies || {}).length) {
    throw new Error(`制品身份不符，或仍需联网解析依赖：${plugin.id}`);
  }
}

function publishCatalog(file, catalog) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(catalog, null, 2), { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function exportUpdate(dir, previous) {
  const catalog = read(BASE_CATALOG);
  const packages = readyPackages(catalog);
  if (catalog.plugins.some((plugin) => plugin.package?.status === 'failed')) {
    throw new Error('目录含镜像失败的插件，请修复失败项再导出');
  }
  const baseline = previous ? read(path.join(previous, catalogName)) : null;
  if (baseline && baseline.site.platform !== catalog.site.platform) throw new Error('增量包与基线的平台不同');
  const known = new Set(baseline ? readyPackages(baseline).map((plugin) => plugin.package.sha256) : []);

  fs.mkdirSync(dir);
  fs.mkdirSync(path.join(dir, 'packages'));
  let copied = 0;
  for (const plugin of packages) {
    const sha = plugin.package.sha256;
    if (known.has(sha)) continue;
    const file = resolveCatalogPackage(plugin, catalog.site.platform, { imported: false });
    if (!file) throw new Error(`找不到制品：${plugin.id}`);
    const target = bundleFile(dir, sha);
    fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
    await verify(target, plugin);
    known.add(sha);
    copied++;
  }
  publishCatalog(path.join(dir, catalogName), catalog);
  console.log(`已导出 ${packages.length} 个插件的完整目录，携带 ${copied} 个制品：${dir}`);
}

async function importUpdate(dir) {
  const catalog = read(path.join(dir, catalogName));
  const packages = readyPackages(catalog);
  const current = read(fs.existsSync(IMPORT_CATALOG) ? IMPORT_CATALOG : BASE_CATALOG);
  if (current.site?.platform !== catalog.site.platform) {
    throw new Error(`目标目录平台为 ${current.site?.platform}，不能导入 ${catalog.site.platform}`);
  }
  fs.mkdirSync(path.join(IMPORT_DIR, 'packages'), { recursive: true });
  let copied = 0;
  for (const plugin of packages) {
    const sha = plugin.package.sha256;
    const destination = importedPackage(sha);
    if (fs.existsSync(destination)) {
      await verify(destination, plugin);
      continue;
    }
    const source = bundleFile(dir, sha);
    if (!fs.existsSync(source)) throw new Error(`增量包缺少 ${plugin.id}，请先导入它的基线包`);
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
      await verify(temporary, plugin);
      fs.renameSync(temporary, destination);
      copied++;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  publishCatalog(IMPORT_CATALOG, catalog);
  console.log(`已导入 ${copied} 个新制品并切换目录（${packages.length} 个可安装插件）`);
}

const [command, dir, flag, previous, ...rest] = process.argv.slice(2);
try {
  if (command === 'export' && dir && (!flag || (flag === '--since' && previous)) && !rest.length) {
    await exportUpdate(dir, previous);
  } else if (command === 'import' && dir && !flag) {
    await importUpdate(dir);
  } else {
    throw new Error('用法：node scripts/update-source.mjs export <新目录> [--since <上一批目录>] | import <更新目录>');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
