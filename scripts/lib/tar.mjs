/**
 * 极简 tar.gz 读写（ustar 格式），不依赖外部 tar 命令。
 *
 * 为什么不用系统的 tar：
 *   部分企业环境装了透明加密/DLP 驱动，会把某些进程写出的文件在磁盘上加密，
 *   外部进程（tar.exe）读到的是密文，打出来的包就是坏包。
 *   Node 自己写、自己读是明文，所以把打包/解包都放在进程内完成最稳。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const BLOCK = 512;

function octal(value, size) {
  const s = (value >>> 0).toString(8);
  return s.padStart(size - 1, '0') + '\0';
}

function writeString(buf, str, offset, length) {
  const b = Buffer.from(str, 'utf8');
  b.copy(buf, offset, 0, Math.min(b.length, length));
}

/** 把路径拆成 ustar 的 prefix(155) + name(100)；放不下就返回 null，交给 GNU longlink 处理 */
function splitName(p) {
  if (Buffer.byteLength(p) <= 100) return ['', p];
  for (let i = p.length - 1; i > 0; i--) {
    if (p[i] !== '/') continue;
    const prefix = p.slice(0, i);
    const name = p.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return [prefix, name];
  }
  return null;
}

function header({ path: p, type, size, mode, link }) {
  const buf = Buffer.alloc(BLOCK, 0);
  const split = splitName(p);
  const [prefix, name] = split || ['', p.slice(0, 100)];
  writeString(buf, name, 0, 100);
  writeString(buf, octal(mode ?? 0o644, 8), 100, 8);
  writeString(buf, octal(0, 8), 108, 8);
  writeString(buf, octal(0, 8), 116, 8);
  writeString(buf, octal(size, 12), 124, 12);
  writeString(buf, octal(Math.floor(Date.now() / 1000), 12), 136, 12);
  buf.fill(0x20, 148, 156); // checksum 先填空格
  writeString(buf, type, 156, 1);
  if (link) writeString(buf, link, 157, 100);
  writeString(buf, 'ustar\0', 257, 6);
  writeString(buf, '00', 263, 2);
  writeString(buf, octal(0, 8), 329, 8);
  writeString(buf, octal(0, 8), 337, 8);
  writeString(buf, prefix, 345, 155);

  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i];
  writeString(buf, sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return buf;
}

/** GNU longlink（type 'L'）扩展头：路径超过 ustar 限制时用 */
function longLink(name) {
  const data = Buffer.from(`${name}\0`, 'utf8');
  const head = header({ path: '././@LongLink', type: 'L', size: data.length, mode: 0o644 });
  const pad = BLOCK - (data.length % BLOCK);
  return { head, chunks: [data, ...(pad === BLOCK ? [] : [Buffer.alloc(pad)])] };
}

/** entries: [{ path, type: 'file'|'dir'|'symlink', data?, link?, mode? }] */
export function createTar(entries) {
  const chunks = [];
  for (const e of entries) {
    const isDir = e.type === 'dir';
    const data = isDir ? Buffer.alloc(0) : (e.data ?? Buffer.alloc(0));
    const name = isDir && !e.path.endsWith('/') ? `${e.path}/` : e.path;

    // 超长路径：先写 GNU longlink，再写被截断的正式头（读取方会用 longlink 覆盖）
    if (!splitName(name)) {
      const ll = longLink(name);
      chunks.push(ll.head, ...ll.chunks);
    }

    chunks.push(header({
      path: name,
      type: isDir ? '5' : e.type === 'symlink' ? '2' : '0',
      size: isDir ? 0 : data.length,
      mode: e.mode ?? (isDir ? 0o755 : 0o644),
      link: e.type === 'symlink' ? e.link : null,
    }));

    if (!isDir && data.length) {
      chunks.push(data);
      const pad = BLOCK - (data.length % BLOCK);
      if (pad !== BLOCK) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}

export function createTarGz(entries) {
  // level 6 而不是 9：大包里 9 级压缩的单线程开销明显，体积收益有限
  return zlib.gzipSync(createTar(entries), { level: 6 });
}

/** 解析 tar buffer -> entries（目录、普通文件、符号链接，支持 GNU longlink 与 pax 头） */
export function readTar(buf) {
  const out = [];
  let off = 0;
  let pendingName = null;

  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;

    const raw = (s, l) => h.subarray(s, s + l).toString('utf8').replace(/\0.*$/, '');
    const name = raw(0, 100);
    const prefix = raw(345, 155);
    let full = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(raw(124, 12).trim() || '0', 8) || 0;
    const type = raw(156, 1) || '0';
    const mode = parseInt(raw(100, 8).trim() || '644', 8) || 0o644;
    const mtime = parseInt(raw(136, 12).trim() || '0', 8) || 0;
    off += BLOCK;

    // GNU 长文件名 / pax 扩展头：内容覆盖下一个头里的名字
    if (type === 'L') {
      pendingName = buf.subarray(off, off + size).toString('utf8').replace(/\0.*$/, '');
      off += Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }
    if (type === 'x' || type === 'g') {
      const pax = buf.subarray(off, off + size).toString('utf8');
      const m = /path=([^\n]+)/.exec(pax);
      if (m) pendingName = m[1].replace(/\0.*$/, '');
      off += Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }

    if (pendingName) {
      full = pendingName;
      pendingName = null;
    }

    const entry = {
      path: full.replace(/\/$/, ''),
      mode,
      mtime,
      type: type === '5' ? 'dir' : type === '2' ? 'symlink' : 'file',
    };
    if (entry.type === 'symlink') entry.link = raw(157, 100);
    if (entry.type === 'file') {
      entry.data = Buffer.from(buf.subarray(off, off + size));
      off += Math.ceil(size / BLOCK) * BLOCK;
    }
    out.push(entry);
  }
  return out;
}

export function readTarGz(buf) {
  return readTar(zlib.gunzipSync(buf));
}

/** 把目录打包成 tgz（包内路径统一加 prefix，npm 约定为 package/） */
export function packDir(dir, prefix = 'package', opts = {}) {
  const entries = [];
  const followSymlinks = opts.followSymlinks !== false;
  const excludeDirs = new Set(opts.excludeDirs || []);
  const excludeRel = new Set(opts.excludeRel || []);
  const walk = (abs, rel, depth = 0) => {
    if (depth > 32) return; // 防止符号链接成环
    if (rel && (excludeRel.has(rel) || excludeRel.has(path.basename(rel)))) return;
    const lst = fs.lstatSync(abs);
    const p = rel ? `${prefix}/${rel}` : prefix;

    if (lst.isSymbolicLink()) {
      // pnpm workspace 里 node_modules 下的依赖常常是软链，
      // 打成包时必须展开成真实内容，否则内网解包后是断链。
      if (!followSymlinks) {
        entries.push({ path: p, type: 'symlink', link: fs.readlinkSync(abs) });
        return;
      }
      let real;
      try { real = fs.realpathSync(abs); } catch { return; }
      const st = fs.statSync(real);
      if (st.isDirectory()) {
        entries.push({ path: p, type: 'dir', mode: 0o755 });
        for (const name of fs.readdirSync(real).sort()) walk(path.join(real, name), rel ? `${rel}/${name}` : name, depth + 1);
      } else {
        entries.push({ path: p, type: 'file', mode: st.mode & 0o777, data: fs.readFileSync(real) });
      }
      return;
    }

    if (lst.isDirectory()) {
      if (rel && excludeDirs.has(path.basename(rel))) return;
      entries.push({ path: p, type: 'dir', mode: 0o755 });
      for (const name of fs.readdirSync(abs).sort()) walk(path.join(abs, name), rel ? `${rel}/${name}` : name, depth + 1);
      return;
    }
    // Windows 上文件没有可执行位，脚本和 bin/ 下的二进制在归档里强制给 0755，
    // 免得内网解包后还得手工 chmod（尤其是随包分发的 runtime/node/bin/node）。
    const isExec = /\.(sh|bash|ps1)$/i.test(p) || /\/bin\/[^/]+$/.test(p);
    const mode = isExec ? 0o755 : lst.mode & 0o777;
    entries.push({ path: p, type: 'file', mode, data: fs.readFileSync(abs) });
  };
  walk(dir, '');
  // 把 package.json 放到最前面：pnpm 解析 tarball 清单时可能只读开头一段，
  // 若 package.json 排在大文件之后，就会认不出包名（表现为 alias 变成整个 file: 路径）。
  const priority = (p) => (p === prefix ? 0 : p === `${prefix}/package.json` ? 1 : 2);
  entries.sort((a, b) => priority(a.path) - priority(b.path));
  return createTarGz(entries);
}

/**
 * 流式把目录打成 tar.gz —— 不把内容读进内存，几个 GB 的交付包也不会爆。
 * 返回 { entries, bytes }，同时把写过的路径收集到 opts.collectPaths 里（供打包后校验）。
 */
export async function packDirToFile(dir, prefix, outFile, opts = {}) {
  const followSymlinks = opts.followSymlinks !== false;
  const excludeDirs = new Set(opts.excludeDirs || []);
  const excludeRel = new Set(opts.excludeRel || []);
  const collected = opts.collectPaths || new Set();

  const walk = (abs, rel, depth) => {
    if (depth > 32) return null;
    if (rel && (excludeRel.has(rel) || excludeRel.has(path.basename(rel)))) return null;
    const lst = fs.lstatSync(abs);
    const p = rel ? `${prefix}/${rel}` : prefix;
    collected.add(p);

    if (lst.isSymbolicLink()) {
      if (!followSymlinks) return { path: p, type: 'symlink', link: fs.readlinkSync(abs) };
      let real;
      try { real = fs.realpathSync(abs); } catch { return null; }
      const st = fs.statSync(real);
      if (st.isDirectory()) {
        return { path: p, type: 'dir', children: fs.readdirSync(real).sort().map((n) => [path.join(real, n), rel ? `${rel}/${n}` : n]) };
      }
      return { path: p, type: 'file', mode: st.mode & 0o777, absPath: real };
    }
    if (lst.isDirectory()) {
      if (rel && excludeDirs.has(path.basename(rel))) return null;
      return { path: p, type: 'dir', children: fs.readdirSync(abs).sort().map((n) => [path.join(abs, n), rel ? `${rel}/${n}` : n]) };
    }
    const isExec = /\.(sh|bash|ps1)$/i.test(p) || /\/bin\/[^/]+$/.test(p);
    return { path: p, type: 'file', mode: isExec ? 0o755 : lst.mode & 0o777, absPath: abs, size: lst.size };
  };

  let count = 0;

  async function* emit() {
    const stack = [[dir, '', 0]];
    const queue = [];
    // 迭代式深度优先，避免递归生成器
    const push = (abs, rel, depth) => {
      const e = walk(abs, rel, depth);
      if (e) queue.push(e);
    };
    push(dir, '', 0);

    while (queue.length) {
      const e = queue.shift();
      if (e.type === 'dir') {
        yield* headerChunks(e.path, 'dir', 0, e.mode, null);
        // 子项按名字排序压入队首，保证稳定顺序
        const kids = e.children.sort((a, b) => (a[1] < b[1] ? -1 : 1));
        for (let i = kids.length - 1; i >= 0; i--) {
          const t = walk(kids[i][0], kids[i][1], 1);
          if (t) queue.unshift(t);
        }
        count++;
        continue;
      }
      if (e.type === 'symlink') {
        yield* headerChunks(e.path, 'symlink', 0, 0o777, e.link);
        count++;
        continue;
      }
      yield* headerChunks(e.path, 'file', e.size, e.mode ?? 0o644, null);
      count++;
      // 分块读，单块 1MB
      const fh = await fs.promises.open(e.absPath, 'r');
      try {
        const CH = 1024 * 1024;
        const buf = Buffer.alloc(CH);
        let written = 0;
        while (written < e.size) {
          const { bytesRead } = await fh.read(buf, 0, Math.min(CH, e.size - written), written);
          if (!bytesRead) break;
          yield Buffer.from(buf.subarray(0, bytesRead));
          written += bytesRead;
        }
        const pad = BLOCK - (e.size % BLOCK);
        if (pad !== BLOCK) yield Buffer.alloc(pad);
      } finally {
        await fh.close();
      }
    }
    yield Buffer.alloc(BLOCK * 2);
  }

  /** 单个条目的头部块（含 GNU longlink） */
  function* headerChunks(p, type, size, mode, link) {
    const name = type === 'dir' && !p.endsWith('/') ? `${p}/` : p;
    // 目录必须是 0755，否则解包后进不去
    const finalMode = type === 'dir' ? 0o755 : (mode ?? 0o644);
    if (!splitName(name)) {
      const ll = longLink(name);
      yield ll.head;
      for (const c of ll.chunks) yield c;
    }
    yield header({
      path: name,
      type: type === 'dir' ? '5' : type === 'symlink' ? '2' : '0',
      size: type === 'dir' ? 0 : size,
      mode: finalMode,
      link: type === 'symlink' ? link : null,
    });
  }

  await pipeline(Readable.from(emit()), zlib.createGzip({ level: 6 }), fs.createWriteStream(outFile));
  const bytes = fs.statSync(outFile).size;
  return { entries: count, bytes };
}

/** 解包 tgz 到目标目录 */
export function extractTarGzTo(file, destDir) {
  const entries = readTarGz(fs.readFileSync(file));
  for (const e of entries) {
    const target = path.join(destDir, e.path);
    if (!path.resolve(target).startsWith(path.resolve(destDir))) continue;
    if (e.type === 'dir') {
      fs.mkdirSync(target, { recursive: true });
    } else if (e.type === 'file') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, e.data, { mode: e.mode });
    }
  }
  return entries;
}

/**
 * 只读包内 package.json —— 因为打包时它固定排在第一条，
 * 只需要解压开头一小段，几百 MB 的包也能秒回。
 */
export function readPackageJsonFast(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, chunk, 0, chunk.length, 0);
    const find = (data) => readTar(data).find((e) => e.type === 'file' && e.path === 'package/package.json');
    if (n === chunk.length) {
      try {
        const prefix = zlib.gunzipSync(chunk, {
          finishFlush: zlib.constants.Z_SYNC_FLUSH,
          maxOutputLength: 8 * 1024 * 1024,
        });
        const entry = find(prefix);
        if (entry) return JSON.parse(entry.data.toString('utf8'));
      } catch {
        // 包清单没完整落在前缀内时，兼容外部打包的归档。
      }
    }
    const entry = find(zlib.gunzipSync(fs.readFileSync(file)));
    return entry ? JSON.parse(entry.data.toString('utf8')) : null;
  } finally {
    fs.closeSync(fd);
  }
}
