# Payroll 開発・リリース手順

- 最新main・ローカル差分・既存PRを確認し、保存データを守る。既存の型チェック・ビルド・回帰・E2E・公開監査・Gitフック・必須CIを維持する。main直接pushや保護の迂回は禁止。
- 利用者向け公開単位でSemVerを更新する。互換性を壊す変更はMAJOR、互換性を保つ機能追加はMINOR、不具合修正・UI調整・性能改善はPATCH。同一公開の追加修正では再度番号を上げない。package.jsonが版番号の正本で、package-lock.jsonも一致させる。
- public/release-notes.jsonの先頭に版番号・タイトル・利用者目線の概要・該当するsections（features / ux / fixes / security / internal）を記録する。空の分類・未確定値は省略。公開済み履歴は事実訂正以外変更しない。同じ版番号の過去公開を架空の番号に置き換えない。
- 公開日（JST）は実際の配信記録を確認してdate/dateKindに設定する。マージ日を使う場合はmergedと明記する。PR/コミット・変更差分統計は確認済みの場合のみ記載。ビルド日時から公開日を推定しない。未確定情報の補完だけの追加リリースは不要。
- npm run buildがCHANGELOG.mdをJSONから自動生成する。JSONと生成されたCHANGELOGをGitに登録し、HTML・build-info.js・CHANGELOGを手編集しない。履歴は公開情報のみ。個人情報、給与データ、PDF、鍵、認証情報を記載しない。
- 改修ZIPは適用元とハッシュを照合し、Macでのビルド・検証を案内する。可視ブラウザを起動しない。コミット対象を確認し、利用者承認後にPR・マージ・配信を進める。配信後はmain同期・作業ブランチ整理まで行う。
