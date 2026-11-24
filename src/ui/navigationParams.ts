/** Navigation metadata belongs in the client-side fragment, not HTTP requests.
 * Accept old links without interpreting a query-string handoff as a ticket. */
export function readNavigationParams(location:Pick<Location,'search'|'hash'>,keys:readonly string[]):URLSearchParams {
 const query=new URLSearchParams(location.search);
 const fragment=new URLSearchParams(location.hash.slice(1));
 const params=new URLSearchParams();
 // If a new-format route selects an original, never mix in an old route's ID.
 const fragmentRoute=fragment.has('id')||fragment.has('yearend');
 for(const key of keys){
  const source=fragment.has(key)?fragment:
   key==='handoff'||(fragmentRoute&&(key==='id'||key==='yearend'))?null:query;
  for(const value of source?.getAll(key)??[])params.append(key,value);
 }
 return params;
}
/** Replace only this page's navigation fields; never put them into search. */
export function replaceNavigationParams(params:URLSearchParams,keys:readonly string[]):void {
 const url=new URL(window.location.href);
 for(const key of keys)url.searchParams.delete(key);
 url.hash=params.toString();
 if(url.href!==window.location.href)window.history.replaceState(window.history.state,'',url.href);
}
export function migrateLegacyNavigation(params:URLSearchParams,keys:readonly string[]):void {
 const query=new URLSearchParams(window.location.search);
 if(keys.some(key=>query.has(key)))replaceNavigationParams(params,keys);
}
