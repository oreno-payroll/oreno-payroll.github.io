/** 公開前の簡易パターン検査。実データをログに出さないため種類だけ返す。 */
const rules = [
  { label: '秘密鍵', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: 'ハードコードされた認証情報', pattern: /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*['"][a-zA-Z0-9_+\-/=]{20,}['"]/i },
  { label: 'メールアドレス', pattern: /[a-zA-Z0-9_.+%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/ },
  // 区切りなし・ハイフン・半角スペースに対応。携帯、IP電話、固定電話、フリーダイヤル。
  // 完全な電話番号検証ではなく、Gitに個人情報を誤登録しないための検出。
  { label: '日本の電話番号らしい数列', pattern: /(?<![A-Za-z0-9])(?:0(?:50|70|80|90)[ -]?\d{4}[ -]?\d{4}|0(?:3|6)[ -]?\d{4}[ -]?\d{4}|0[1-9]\d{1,3}[ -]?\d{1,4}[ -]?\d{4}|0120[ -]?\d{3}[ -]?\d{3}|0800[ -]?\d{3}[ -]?\d{4})(?!\d)/ },
];
export function findSensitiveContent(source) {
  return rules.filter(({ pattern }) => pattern.test(source)).map(({ label }) => label);
}
