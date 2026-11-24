/** OneDrive multi-file actions can commit a statement before auxiliary work fails. */
export type PartialOperationStage = 'income-sync' | 'duplicate-cleanup' | 'year-move' | 'original-trash' | 'employer-assignment';
export class PayrollPartialSuccessError extends Error {
 constructor(readonly stage:PartialOperationStage,message:string,options?:ErrorOptions){
  super(message,options);
  this.name='PayrollPartialSuccessError';
 }
}
