/** Finance v1.1と同じPBKDF2/AES-256-GCMの構成。暗号形式とAADはPayroll専用。 */
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const ITERATIONS = 310_000;
const DOMAINS = {
  index: 'Payroll OneDrive index v1',
  year: 'Payroll OneDrive annual records v1',
  original: 'Payroll OneDrive PDF original v1',
  income: 'Payroll OneDrive income v1',
  snapshot: 'Payroll tab navigation snapshot v1',
  'assist-index': 'Payroll year-end third-party index v1',
  'assist-profile': 'Payroll year-end third-party person v1',
  'assist-year': 'Payroll year-end third-party calendar-year v1',
  'assist-original': 'Payroll year-end third-party original PDF v1',
} as const;
export type EnvelopeKind = keyof typeof DOMAINS;
interface EncryptedEnvelope {
  format: 'payroll-cloud-envelope-v1';
  kind: EnvelopeKind;
  salt?: string;
  iterations?: number;
  iv: string;
  data: string;
}
function base64(bytes: Uint8Array): string {
  let s = '';
  for (let pos = 0; pos < bytes.length; pos += 16384) s += String.fromCharCode(...bytes.subarray(pos, pos + 16384));
  return btoa(s);
}
function unbase64(value: unknown, max = 100_000_000): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > max * 1.4 + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('暗号データの形式が不正です。');
  // 巨大PDFを読み戻す際、Uint8Array.fromの1文字ごとのコールバックを避ける。
  // 復号前の形式検証と長さ上限はこれまでと同じ。
  const raw = atob(value);
  if (raw.length > max) throw new Error('暗号データが容量上限を超えています。');
  const b = new Uint8Array(raw.length);
  for (let i=0; i<raw.length; i++) b[i]=raw.charCodeAt(i);
  return b;
}
export function createSalt(): string { return base64(crypto.getRandomValues(new Uint8Array(16))); }
export async function deriveKey(passphrase: string, salt: string, capture?: (material: Uint8Array) => void): Promise<CryptoKey> {
  if ([...passphrase].length < 12) throw new Error('復号パスフレーズは12文字以上にしてください。');
  const bytes = unbase64(salt, 32);
  if (bytes.byteLength !== 16) throw new Error('保管庫の暗号ソルトが不正です。');
  const params = {name:'PBKDF2' as const,salt:bytes,iterations:ITERATIONS,hash:'SHA-256'};
  const base = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, capture ? ['deriveBits'] : ['deriveKey']);
  if (!capture) return crypto.subtle.deriveKey(params,base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  // Opt-in only. The raw key exists briefly so sessionStorage can keep a tab-scoped unlock.
  // The operational key remains non-extractable, and the temporary bytes are zeroed.
  const raw=new Uint8Array(await crypto.subtle.deriveBits(params,base,256));
  try {
    const key=await crypto.subtle.importKey('raw',raw,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    capture(raw);
    return key;
  } finally { raw.fill(0); }
}
export async function encryptBytes(kind: EnvelopeKind, bytes: Uint8Array, key: CryptoKey, salt?: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(DOMAINS[kind])},key,new Uint8Array(bytes));
  const envelope: EncryptedEnvelope = {format:'payroll-cloud-envelope-v1',kind,iv:base64(iv),data:base64(new Uint8Array(cipher))};
  if (salt) { envelope.salt = salt; envelope.iterations = ITERATIONS; }
  return JSON.stringify(envelope);
}
export function parseEnvelope(text: string, kind: EnvelopeKind): EncryptedEnvelope {
  if (text.length > 140_000_000) throw new Error('暗号ファイルが大きすぎます。');
  let e: EncryptedEnvelope;
  try { e = JSON.parse(text.replace(/^\uFEFF/, '')) as EncryptedEnvelope; }
  catch {
    // 本文・署名付きURL・アクセストークンをエラーメッセージへ絶対に含めない。
    const head = text.trimStart().slice(0, 96).toLowerCase();
    const type = text.length === 0 ? '空ファイル'
      : /^(?:<!doctype|<html|<\?xml|<error|<)/.test(head) ? 'HTML/XML'
      : /^[{\[]/.test(head) ? '壊れたJSON'
      : 'JSON以外の内容';
    throw new Error(`暗号ファイルがJSONとして読み取れません（判定: ${type}、文字数: ${text.length}）。データは変更していません。`);
  }
  if (!e || e.format !== 'payroll-cloud-envelope-v1' || e.kind !== kind || unbase64(e.iv,32).length !== 12 || typeof e.data !== 'string') throw new Error('暗号形式または用途が一致しません。');
  if (e.salt !== undefined && (e.iterations !== ITERATIONS || unbase64(e.salt,32).length !== 16)) throw new Error('対応していない鍵導出形式です。');
  return e;
}
export function envelopeSalt(text: string): string {
  const e = parseEnvelope(text,'index');
  if (!e.salt) throw new Error('索引に暗号ソルトがありません。');
  return e.salt;
}
export async function decryptBytes(kind: EnvelopeKind, text: string, key: CryptoKey): Promise<Uint8Array> {
  const env = parseEnvelope(text,kind);
  try {
    const clear = await crypto.subtle.decrypt({name:'AES-GCM',iv:unbase64(env.iv,32),additionalData:encoder.encode(DOMAINS[kind])},key,unbase64(env.data));
    return new Uint8Array(clear);
  } catch { throw new Error('パスフレーズが違うか、OneDrive上の暗号ファイルが破損しています。'); }
}
export async function encryptJson(kind: Exclude<EnvelopeKind,'original'>, data: unknown, key: CryptoKey, salt?: string): Promise<string> {
  return encryptBytes(kind,encoder.encode(JSON.stringify(data)),key,salt);
}
export async function decryptJson<T>(kind: Exclude<EnvelopeKind,'original'>, text: string, key: CryptoKey): Promise<T> {
  // Authentication is checked by AES-GCM before JSON parsing. Report these as distinct
  // failures without logging decrypted salary data or the encrypted envelope.
  const plain = decoder.decode(await decryptBytes(kind,text,key));
  try { return JSON.parse(plain) as T; }
  catch(error) {
    if(error instanceof SyntaxError) {
      throw new Error(`復号後の${kind}データが正しいJSONではありません。暗号ファイルは変更していません。`,{cause:error});
    }
    throw error;
  }
}
