/** Page-local deletion intent. A changed record must be selected again, never silently rebased. */
export interface DeletionTarget {id:number;signature:string;label:string}
export class PendingDeletion {
 private readonly selected=new Map<number,DeletionTarget>();
 get size():number{return this.selected.size;}
 has(id:number):boolean{return this.selected.has(id);}
 toggle(target:DeletionTarget):void{
  if(this.selected.has(target.id))this.selected.delete(target.id);
  else this.selected.set(target.id,{...target});
 }
 remove(id:number):void{this.selected.delete(id);}
 clear():void{this.selected.clear();}
 snapshot():DeletionTarget[]{return [...this.selected.values()].map(target=>({...target}));}
 matches(records:readonly {id:number;signature:string}[]):boolean{
  const live=new Map(records.map(record=>[record.id,record.signature]));
  return this.snapshot().every(target=>live.get(target.id)===target.signature);
 }
}
