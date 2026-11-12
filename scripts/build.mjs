/**
 * Payroll: TypeScriptのバンドルとpublicフォルダの配信ファイルをdistに同期する。
 * npm run build: 型チェック + 1回だけビルド
 * npm run dev:   型チェック + TS監視 + HTML/CSS等のコピー監視
 * Live Serverはdist/を公開ルートにする。
 */
import * as esbuild from "esbuild";
import { watch } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const publicDir = path.join(root, "public");
const srcDir = path.join(root, "src");
const distDir = path.join(root, "dist");
const watchMode = process.argv.includes("--watch");

// src/直下の.tsが各ページのエントリーポイントになる。
// src/pdf/等のサブフォルダは、エントリーポイントからimportして使う。
const entries = (await fs.readdir(srcDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))
  .map((entry) => path.join(srcDir, entry.name));

if (entries.length === 0) {
  throw new Error("src/直下にTypeScriptファイルがありません。");
}

const options = {
  entryPoints: entries,
  outdir: distDir,
  entryNames: "[name]",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  logLevel: "info",
};

// 元ファイルが欠けている場合は、既存のdistを消す前に停止する。
// ZIP展開時のフォルダ入れ違いや誤削除を早めに発見できるようにする。
for (const rel of ["public/index.html", "public/upload/index.html", "src/main.ts", "src/upload.ts"]) {
  const file = path.join(root, rel);
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error(`${rel} がファイルではありません。`);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`必要なファイルがありません: ${rel}。復旧ZIPの展開先を確認してください。`);
    }
    throw error;
  }
}

// 古い成果物を残さず、配信用のHTML/CSS等は階層をそのまま保持してコピー。
await fs.rm(distDir, { recursive: true, force: true });
await fs.mkdir(distDir, { recursive: true });
await fs.cp(publicDir, distDir, { recursive: true, force: true });
await fs.copyFile(
  path.join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"),
  path.join(distDir, "pdf.worker.min.mjs"),
);
// 日本語給与明細のフォント/CMapを含め、PDF.jsが参照するリソースをローカルに同梱する。
for (const directory of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  await fs.cp(
    path.join(root, "node_modules/pdfjs-dist", directory),
    path.join(distDir, directory),
    { recursive: true },
  );
}

if (!watchMode) {
  await esbuild.build(options);
  console.log("[build] dist/ に出力しました。");
} else {
  const context = await esbuild.context(options);
  await context.watch();

  // esbuildはTSのimportを監視する。public内はNode.jsで再帰監視して同期。
  // 現在のmacOS + Node.js 24はrecursive: trueに対応する。
  let queue = Promise.resolve();
  const watcher = watch(publicDir, { recursive: true }, (_event, filename) => {
    queue = queue.then(async () => {
      // filenameが返らない場合はpublic全体を再コピーする。
      if (!filename) {
        await fs.cp(publicDir, distDir, { recursive: true, force: true });
        console.log("[dev] public/ を同期しました。");
        return;
      }

      const rel = String(filename);
      const src = path.resolve(publicDir, rel);
      const dest = path.resolve(distDir, rel);
      if (!src.startsWith(publicDir + path.sep) || !dest.startsWith(distDir + path.sep)) return;

      try {
        const info = await fs.stat(src);
        if (info.isDirectory()) {
          await fs.cp(src, dest, { recursive: true, force: true });
        } else {
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.copyFile(src, dest);
        }
        console.log(`[dev] public/${rel} を反映しました。`);
      } catch (error) {
        if (error?.code === "ENOENT") {
          await fs.rm(dest, { recursive: true, force: true });
          console.log(`[dev] public/${rel} の削除を反映しました。`);
        } else {
          throw error;
        }
      }
    }).catch((error) => console.error("[dev] public同期エラー:", error));
  });

  // 新しいsrc直下のエントリー(.ts)を追加したときはnpm run devを再起動する。
  console.log("[dev] TSとpublic/を監視中。Live Serverでdist/index.htmlを開いてください。");
  process.once("SIGINT", async () => {
    watcher.close();
    await context.dispose();
    process.exit(0);
  });
}
