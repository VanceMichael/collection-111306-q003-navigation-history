let state=await(await fetch('/api/snapshot')).json();
const documentIdentity=crypto.randomUUID();
function render(reason){const view=history.state?.view??'a';document.querySelector('#reading').textContent=state.views[view];document.querySelector('#lifecycle').textContent=JSON.stringify({document:documentIdentity,item:history.state?.item,reason,view});}
if(!history.state)history.replaceState({item:crypto.randomUUID(),view:'a'},'',location.href);
for(const view of ['a','b'])document.querySelector('#to-'+view).onclick=()=>{history.pushState({item:crypto.randomUUID(),view},'','/?view='+view);render('route');};
document.querySelector('#same-url').onclick=()=>{history.pushState({item:crypto.randomUUID(),view:'b'},'',location.href);render('same-url');};
addEventListener('popstate',()=>render('history'));
addEventListener('pageshow',event=>render(event.persisted?'restored':'pageshow'));render('initial');
window.portalReady=true;
