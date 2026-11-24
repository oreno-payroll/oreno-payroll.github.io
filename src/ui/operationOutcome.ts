/** Notifications are determined by domain outcomes, never by Japanese text matching. */
export type OperationResult =
  | {status:'success';message:string}
  | {status:'partial';message:string}
  | {status:'error';message:string};

export type OperationFeedback = {kind:'success'|'partial'|'error';message:string};
export function operationFeedback(label:string,result:OperationResult|null):OperationFeedback {
 if(result?.status==='success')return {kind:'success',message:result.message || `${label}が完了しました`};
 if(result?.status==='partial')return {kind:'partial',message:result.message || `${label}は一部完了、または保存結果を確認できませんでした。画面内の詳細を確認してください。`};
 if(result?.status==='error')return {kind:'error',message:result.message || `${label}を完了できませんでした。画面内の詳細を確認してください。`};
 // Fail closed: a missing completion marker can never be misreported as success.
 return {kind:'error',message:`${label}の結果を確認できませんでした。画面内の詳細を確認してください。`};
}
