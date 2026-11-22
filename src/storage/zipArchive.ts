/** 外部依存ゼロのZIP(store方式)書き込み・読み込み。バックアップ専用。 */
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let value = n;
  for (let k = 0; k < 8; k++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[n] = value >>> 0;
}
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export interface ZipFile { name: string; data: Uint8Array }
function u16(v: DataView, offset: number, n: number): void { v.setUint16(offset, n, true); }
function u32(v: DataView, offset: number, n: number): void { v.setUint32(offset, n >>> 0, true); }
import { MAX_ARCHIVE_BYTES } from './storageLimits';
const MAX_ARCHIVE = MAX_ARCHIVE_BYTES;
function writeZipFiles(files: ZipFile[], validName: (name: string) => boolean): Blob {
  if (files.length > 2001) throw new Error('バックアップ内のファイル数が多すぎます。');
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const unique = new Set<string>();
  for (const { name, data } of files) {
    if (!validName(name) || unique.has(name)) throw new Error('ZIP内のパスが不正または重複しています。');
    unique.add(name);
    const nameBytes = encoder.encode(name);
    const size = data.byteLength;
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const a = new DataView(local.buffer);
    u32(a, 0, 0x04034b50); u16(a, 4, 20); u16(a, 6, 0x0800);
    u16(a, 8, 0); u32(a, 14, crc); u32(a, 18, size); u32(a, 22, size); u16(a, 26, nameBytes.length);
    local.set(nameBytes, 30);
    const dir = new Uint8Array(46 + nameBytes.length);
    const d = new DataView(dir.buffer);
    u32(d, 0, 0x02014b50); u16(d, 4, 20); u16(d, 6, 20); u16(d, 8, 0x0800);
    u16(d, 10, 0); u32(d, 16, crc); u32(d, 20, size); u32(d, 24, size);
    u16(d, 28, nameBytes.length); u32(d, 42, offset);
    dir.set(nameBytes, 46);
    central.push(dir);
    parts.push(new Uint8Array(local), new Uint8Array(data));
    offset += local.byteLength + size;
    if (offset > MAX_ARCHIVE) throw new Error('ZIPの合計サイズが512MBを超えています。');
  }
  const directorySize = central.reduce((sum, bytes) => sum + bytes.length, 0);
  for (const bytes of central) parts.push(new Uint8Array(bytes));
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  u32(e, 0, 0x06054b50); u16(e, 8, files.length); u16(e, 10, files.length);
  u32(e, 12, directorySize); u32(e, 16, offset);
  parts.push(end);
  if (offset + directorySize + end.byteLength > MAX_ARCHIVE) throw new Error('ZIPの合計サイズが512MBを超えています。');
  return new Blob(parts, { type: 'application/zip' });
}
/** バックアップ形式はこれまでどおり固定し、既存の復元仕様と互換性を維持する。 */
export function writeZip(files: ZipFile[]): Blob {
  return writeZipFiles(files, name => /^(manifest\.json|pdf\/[0-9]{6}\.pdf)$/.test(name));
}
/** 元PDFだけを取り出すエクスポートZIP。バックアップ用readZipとは混同しない。 */
export function writePdfExportZip(files: ZipFile[]): Blob {
  return writeZipFiles(files, name => /^pdf\/[0-9]{6}_[^/\\\x00-\x1f]{1,200}\.pdf$/i.test(name));
}
/** 年末調整従業員PDFの平文ZIP。ZIP直下にファイル名を保つ。 */
export function writeYearEndPdfZip(files: ZipFile[]): Blob {
  return writeZipFiles(files, name => /^[^/\\\x00-\x1f\x7f]{1,160}\.pdf$/i.test(name) && !name.startsWith('.'));
}
function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
/** 自前で作成したstore方式ZIPのみ読み込み。他のZIPは安全側で拒否する。 */
export function readZip(buffer: ArrayBuffer): Map<string, Uint8Array> {
  ensure(buffer.byteLength >= 22 && buffer.byteLength <= MAX_ARCHIVE, 'ZIPサイズが不正です（上限512MB）。');
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { eocd = i; break; }
  }
  ensure(eocd !== -1, 'ZIPの終端情報が不正です。');
  const count = view.getUint16(eocd + 10, true);
  ensure(count <= 2001 && view.getUint16(eocd + 8, true) === count, 'ZIPのファイル数が不正です。');
  ensure(view.getUint16(eocd + 4, true) === 0 && view.getUint16(eocd + 6, true) === 0, '分割ZIPは利用できません。');
  const dirSize = view.getUint32(eocd + 12, true);
  let cursor = view.getUint32(eocd + 16, true);
  ensure(cursor + dirSize === eocd, 'ZIPのディレクトリ位置が不正です。');
  const result = new Map<string, Uint8Array>();
  let totalSize = 0;
  let expectedLocalOffset = 0;
  for (let i = 0; i < count; i++) {
    ensure(cursor + 46 <= eocd && view.getUint32(cursor, true) === 0x02014b50, 'ZIPのディレクトリが壊れています。');
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const checksum = view.getUint32(cursor + 16, true);
    const compressed = view.getUint32(cursor + 20, true);
    const uncompressed = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    ensure(next <= eocd && method === 0 && flags === 0x0800 && compressed === uncompressed,
      'このバックアップ形式に対応していません。');
    ensure(view.getUint16(cursor + 34, true) === 0 && view.getUint16(cursor + 36, true) === 0,
      'ZIP内のディスク情報が不正です。');
    ensure(localOffset === expectedLocalOffset, 'ZIP内のファイル位置が連続していません。');
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    ensure(/^(manifest\.json|pdf\/[0-9]{6}\.pdf)$/.test(name) && !result.has(name), 'ZIP内に不正なファイル名または重複があります。');
    ensure(localOffset + 30 <= cursor && view.getUint32(localOffset, true) === 0x04034b50, 'ZIP内のPDFデータ位置が不正です。');
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtra;
    ensure(view.getUint16(localOffset + 6, true) === flags && view.getUint16(localOffset + 8, true) === method &&
      view.getUint32(localOffset + 14, true) === checksum && view.getUint32(localOffset + 18, true) === compressed &&
      view.getUint32(localOffset + 22, true) === uncompressed && localNameLength === nameLength,
      'ZIPのローカルヘッダーとディレクトリ情報が一致しません。');
    ensure(start <= view.getUint32(eocd + 16, true) && start + compressed <= view.getUint32(eocd + 16, true), 'ZIP内のデータが不完全です。');
    expectedLocalOffset = start + compressed;
    ensure(decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)) === name, 'ZIPのファイル名が一致しません。');
    const data = bytes.slice(start, start + compressed);
    ensure(crc32(data) === checksum, `CRC検証に失敗しました: ${name}`);
    totalSize += data.byteLength;
    ensure(totalSize <= MAX_ARCHIVE, '展開後のサイズが上限を超えています。');
    result.set(name, data);
    cursor = next;
  }
  ensure(cursor === eocd && expectedLocalOffset === view.getUint32(eocd + 16, true) && result.has('manifest.json'),
    'バックアップの内容が不完全です。');
  return result;
}
