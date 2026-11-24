/** The statement deletion is already committed when income-sync fails.
 * Keep both entrypoints aligned and never advise deleting the record again. */
export function incompleteDeleteIncomeNotice():string {
 return '明細の削除は完了しました。\n\nFinance連携用の収入データの更新だけが完了していません。明細をもう一度削除する必要はありません。\n\n設定画面の「Finance連携を更新」から再同期してください。';
}
