const documentIdentity=crypto.randomUUID();
const documentOrder=Number(sessionStorage.getItem('portal-document-order')??'0')+1;
sessionStorage.setItem('portal-document-order',String(documentOrder));
const filterLabels={all:'全部',online:'在线',offline:'离线'};
let eventSeq=0;
const navigationLog=[];
let lastLifecycle=null;
let lastBasis={kind:'loading'};
let lastNavigationType='initial';
let snapshot=null;
let restoring=false;

function historyFacts(){
 const entry=navigation.currentEntry;
 return {key:entry?.key??null,id:entry?.id??null,index:entry?.index??null,url:entry?.url??location.href};
}
function facts(){
 return {
  document:documentIdentity,
  documentOrder,
  url:location.href,
  entry:historyFacts(),
  state:history.state??null,
  item:history.state?.item??null,
  view:history.state?.view??null,
  filter:history.state?.filter??null,
  reading:document.querySelector('#reading').textContent,
  cachedGeneration:snapshot?.generation??null,
  basis:lastBasis,
  lifecycle:lastLifecycle,
  pageNavigationType:performance.getEntriesByType('navigation')[0]?.type??null,
  eventSeq,
  navigationLog
 };
}
function report(kind,extra={}){
 if(window.__captureReport)window.__captureReport({kind,...extra,facts:facts(),at:performance.timeOrigin+performance.now()});
}
function render(reason){
 if(!snapshot)return;
 const data=history.state??{};
 const view=data.view??'a';const filter=data.filter??'all';
 document.querySelector('#reading').textContent=snapshot.views[view];
 document.querySelector('#filter').value=filter;
 document.querySelector('#filter-label').textContent=filterLabels[filter]??filter;
 document.querySelector('#lifecycle').textContent=JSON.stringify({
  document:documentIdentity,documentOrder,item:data.item??null,reason,view,filter,
  entry:historyFacts(),basis:lastBasis,lifecycle:lastLifecycle,navigation:lastNavigationType,eventSeq
 });
}
function emit(kind,{reason,basis,navigationType='push',...extra}={}){
 eventSeq+=1;lastBasis=basis;lastNavigationType=navigationType;restoring=false;
 render(reason??kind);
 report(kind,extra);
}
function push(next,{reason,basis}){
 history.pushState(next,'',next.url??location.href);
 emit('change',{reason,basis,change:reason});
}
async function readSnapshot(){
 const probe=crypto.randomUUID();
 const response=await fetch('/api/snapshot?probe='+probe,{cache:'no-store'});
 const data=await response.json();
 return {data,probe,generation:data.generation,status:response.status};
}
async function start(){
 const first=await readSnapshot();
 snapshot=first.data;
 if(!history.state)history.replaceState({item:crypto.randomUUID(),view:'a',filter:'all'},'',location.href);
 eventSeq+=1;
 lastBasis={kind:'network',source:'snapshot',probe:first.probe,generation:first.generation,fresh:true};
 lastNavigationType='initial';
 render('initial');
 report('load',{probe:first.probe});
 window.portalReady=true;
}
for(const view of ['a','b'])document.querySelector('#to-'+view).onclick=()=>{
 push({item:crypto.randomUUID(),view,filter:history.state?.filter??'all',url:'/?view='+view},{reason:'route',basis:{kind:'retained',source:'memory',from:history.state?.item??null}});
};
document.querySelector('#same-url').onclick=()=>{
 const current=history.state?.filter??'all';
 push({item:crypto.randomUUID(),view:history.state?.view??'b',filter:current==='online'?'offline':'online',url:location.href},{reason:'same-url',basis:{kind:'retained',source:'memory',from:history.state?.item??null}});
};
document.querySelector('#filter').onchange=event=>{
 push({item:crypto.randomUUID(),view:history.state?.view??'a',filter:event.target.value,url:location.href},{reason:'filter',basis:{kind:'retained',source:'memory',from:history.state?.item??null}});
};
document.querySelector('#anchor').onclick=event=>{
 event.preventDefault();
 history.pushState({item:crypto.randomUUID(),view:history.state?.view??'a',filter:history.state?.filter??'all'},'','#device-detail');
 emit('change',{reason:'hash',change:'hash',basis:{kind:'retained',source:'memory',from:history.state?.item??null}});
};
document.querySelector('#reconfirm').onclick=async()=>{
 const next=await readSnapshot();
 snapshot=next.data;
 const current=history.state??{};
 history.replaceState({...current,item:current.item??crypto.randomUUID()},'',location.href);
 emit('reconfirm',{reason:'reconfirmed',change:'reconfirmed',navigationType:'replace',basis:{kind:'network',source:'snapshot',probe:next.probe,generation:next.generation,fresh:true}});
};
navigation.addEventListener('navigate',event=>{navigationLog.push({type:event.navigationType,hashChange:event.hashChange,url:event.destination.url,at:performance.now()});});
let pendingTraversal=null;
let lastEntryKey=historyFacts().key;
function commitTraversal(){
 pendingTraversal=null;
 if(restoring){restoring=false;lastEntryKey=historyFacts().key;return;}
 const key=historyFacts().key;
 // 换到另一个历史项是 history；同一历史项内只改锚点才是 hash。
 const change=key===lastEntryKey&&location.hash?'hash':'history';
 lastEntryKey=key;
 emit(change==='hash'?'hashchange':'popstate',{
  reason:change==='hash'?'hash':'history',
  change,
  navigationType:'traverse',
  basis:{kind:'retained',source:'history',from:history.state?.item??null}
 });
}
addEventListener('hashchange',()=>{
 if(pendingTraversal!==null)return;
 emit('hashchange',{reason:'hash',change:'hash',navigationType:'traverse',basis:{kind:'retained',source:'history',from:history.state?.item??null}});
 lastEntryKey=historyFacts().key;
});
addEventListener('popstate',()=>{
 // 跨文档 BFCache 恢复时，popstate、pagehide、pageshow 在同一个任务里依次派发；
 // 把同文档历史移动的接收推迟到任务末尾，恢复则交给 pageshow.persisted 单独记录，
 // 避免一次返回既算历史变化又算恢复展示。
 clearTimeout(pendingTraversal);
 pendingTraversal=setTimeout(commitTraversal,0);
});
addEventListener('pagehide',event=>{
 lastLifecycle={persisted:event.persisted,kind:'pagehide',at:performance.now()};
 // 离场事实单独上报：采集器据此知道这份文档已经离开，返回时才可能是恢复展示。
 report('pagehide',{persisted:event.persisted});
});
addEventListener('pageshow',event=>{
 eventSeq+=1;
 lastLifecycle={persisted:event.persisted,kind:'pageshow',at:performance.now()};
 if(event.persisted){
  restoring=true;
  lastEntryKey=historyFacts().key;
  lastBasis={kind:'restored',source:'bfcache',generation:snapshot?.generation??null};
  lastNavigationType='traverse';
  render('restored');
  report('pageshow',{persisted:true});
 }else{
  lastNavigationType='load';
  report('pageshow',{persisted:false});
 }
});
start();
