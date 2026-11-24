/** The statement deletion is already committed when income-sync fails.
 * Keep both entrypoints aligned and never advise deleting the record again. */
export function incompleteDeleteIncomeNotice():string {
 return '明細の削除は完了しました。\n\nFinance連携用の収入データの更新が完了していません。PDF原本はごみ箱へ移動していません。明細をもう一度削除する必要はありません。\n\n設定画面の「Finance連携」で「連携データを再生成」を実行し、「未参照PDF原本の管理」で残った原本を確認してください。';
}

export function incompleteDeleteOriginalNotice():string {
 return '明細の削除と削除時点のFinance同期は完了しました。PDF原本のごみ箱移動は一部未確認です。明細をもう一度削除する必要はありません。\n\n設定の「未参照PDF原本の管理」で残った原本を再検査し、必要に応じて回収または整理してください。未同期の場合はFinance連携を再生成し、OneDriveのごみ箱も確認してください。';
}
