// tools/lib/zip.mjs —— 零依赖 ZIP 写入器
//
// 为什么要自己写：Node 没有内置 zip，而 npm 依赖会让"打补丁/打包"依赖网络。
// 关键是**通用位标志 bit 11（0x0800）= 文件名 UTF-8**：不置位的话
// Windows 资源管理器/部分解压器会按本地代码页解析，中文名直接变乱码。
// （2026-10 的教训：包内 `更新日志-*.md` 在别人机器上解出来是乱码。）
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F),
    date: (((year - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F)
  };
}

/**
 * @param {string} outPath 目标 zip
 * @param {{abs:string, name:string}[]} entries  name 用 '/' 分隔、不含盘符
 */
export function writeZip(outPath, entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = dosDateTime(new Date());
  const FLAG_UTF8 = 0x0800;

  for (const e of entries) {
    const data = fs.readFileSync(e.abs);
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(data);
    let method = 0;
    let body = data;
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    if (deflated.length < data.length) { method = 8; body = deflated; }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(FLAG_UTF8, 6);     // ★ UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(now.time, 10);
    local.writeUInt16LE(now.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x031E, 4);           // made by: unix, 3.0
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(FLAG_UTF8, 8);        // ★ 中央目录同样置位
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(now.time, 12);
    cd.writeUInt16LE(now.date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);               // extra
    cd.writeUInt16LE(0, 32);               // comment
    cd.writeUInt16LE(0, 34);               // disk
    cd.writeUInt16LE(0, 36);               // internal attr
    cd.writeUInt32LE(0o644 << 16, 38);     // external attr（普通文件 644）
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat([...chunks, cdBuf, eocd]));
  return { bytes: fs.statSync(outPath).size, entries: entries.length };
}
