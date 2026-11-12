/**
 * Payroll専用暗号化バックアップ v1.
 * [8 bytes magic PAYENC01][4 bytes iteration LE][16 bytes salt][12 bytes IV][AES-GCM ciphertext+tag]
 * 従来ZIP全体を暗号化する。ヘッダー40バイトはAES-GCMのAADとして認証される。
 * この形式はZIPではない。機密PDFを含むmanifest/ファイル名も暗号化される。
 */
import { MAX_ARCHIVE_BYTES } from './storageLimits';

const MAGIC = new TextEncoder().encode('PAYENC01');
const HEADER_BYTES = 40;
const TAG_BYTES = 16;
const ITERATIONS = 600_000;
const MIN_ITERATIONS = 600_000;
const MAX_ITERATIONS = 2_000_000;
const MAX_PASSWORD_BYTES = 1024;
const encoder = new TextEncoder();

function ensureCrypto(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) throw new Error('暗号化にはlocalhostまたはHTTPSで開く必要があります。');
  return crypto.subtle;
}
function passwordBytes(password: string, creating: boolean): Uint8Array<ArrayBuffer> {
  if (creating && [...password].length < 12) throw new Error('暗号化パスワードは12文字以上にしてください。');
  const bytes = encoder.encode(password);
  if (!bytes.length || bytes.length > MAX_PASSWORD_BYTES) throw new Error('パスワードの長さが不正です。');
  return bytes;
}
async function keyFromPassword(password: string, salt: Uint8Array<ArrayBuffer>, rounds: number, creating: boolean): Promise<CryptoKey> {
  const subtle = ensureCrypto();
  const secret = await subtle.importKey('raw', passwordBytes(password, creating), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds },
    secret,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
function hasMagic(bytes: Uint8Array): boolean {
  return bytes.length >= MAGIC.length && MAGIC.every((value, i) => bytes[i] === value);
}
export async function isEncryptedBackup(file: Blob): Promise<boolean> {
  return hasMagic(new Uint8Array(await file.slice(0, MAGIC.length).arrayBuffer()));
}
export async function encryptBackup(zip: Blob, password: string): Promise<Blob> {
  const subtle = ensureCrypto();
  if (zip.size <= 0 || zip.size > MAX_ARCHIVE_BYTES) throw new Error('バックアップZIPのサイズが不正です。');
  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC);
  new DataView(header.buffer).setUint32(8, ITERATIONS, true);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  header.set(salt, 12);
  header.set(iv, 28);
  const key = await keyFromPassword(password, salt, ITERATIONS, true);
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header, tagLength: 128 }, key, await zip.arrayBuffer());
  return new Blob([header, ciphertext], { type: 'application/octet-stream' });
}
export async function decryptBackup(file: Blob, password: string): Promise<Blob> {
  const subtle = ensureCrypto();
  if (file.size < HEADER_BYTES + TAG_BYTES || file.size > MAX_ARCHIVE_BYTES + HEADER_BYTES + TAG_BYTES) throw new Error('暗号化バックアップのサイズが不正です。');
  const whole = await file.arrayBuffer();
  const header = new Uint8Array(whole.slice(0, HEADER_BYTES));
  if (!hasMagic(header)) throw new Error('Payrollの暗号化バックアップではありません。');
  const rounds = new DataView(header.buffer).getUint32(8, true);
  if (rounds < MIN_ITERATIONS || rounds > MAX_ITERATIONS) throw new Error('未対応の鍵導出パラメータです。');
  const salt = header.slice(12, 28);
  const iv = header.slice(28, 40);
  const key = await keyFromPassword(password, salt, rounds, false);
  let decoded: ArrayBuffer;
  try {
    decoded = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: header, tagLength: 128 }, key, whole.slice(HEADER_BYTES));
  } catch {
    throw new Error('復号できません。パスワード違い、またはファイルの破損・改ざんが考えられます。');
  }
  if (decoded.byteLength > MAX_ARCHIVE_BYTES) throw new Error('復号されたZIPが上限を超えています。');
  return new Blob([decoded], { type: 'application/zip' });
}
