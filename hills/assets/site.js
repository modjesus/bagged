(()=>{
const root=document.querySelector('.wm-guide');if(!root)return;
const input=root.querySelector('[data-search]'),sort=root.querySelector('[data-sort]'),area=root.querySelector('select[data-area]'),region=root.querySelector('[data-region]'),reset=root.querySelector('[data-reset]'),count=root.querySelector('[data-results]'),empty=root.querySelector('[data-empty]'),more=root.querySelector('[data-more]');
const hills=[...root.querySelectorAll('[data-hill]')],cards=[...root.querySelectorAll('[data-card]')],items=hills.length?hills:cards,container=root.querySelector(hills.length?'[data-hill-list]':'.catalogue');
/* A control that hides itself while focused drops the keyboard user at the
   top of the page -- measured at 24 Tab presses to get back into the list.
   Move focus to the result count first. Added 29 Oct 2026. */
const keepFocus=el=>{if(!el||!el.contains(document.activeElement))return;const t=count||container;if(!t)return;t.setAttribute('tabindex','-1');t.focus({preventScroll:true});};
let limit=16;const normal=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
function update(){let q=normal(input?.value||'');let filtered=items.filter(el=>normal(el.dataset.name).includes(q)&&(!area||area.value==='all'||el.dataset.area===area.value)&&(!region||region.value==='all'||el.dataset.regions.split('|').includes(region.value)));
let order=sort?.value;filtered.sort((a,b)=>order==='name'?a.dataset.name.localeCompare(b.dataset.name,'en-GB'):order==='height'?Number(b.dataset.height)-Number(a.dataset.height):order==='low'?Number(a.dataset.height)-Number(b.dataset.height):order==='count'?Number(b.dataset.count)-Number(a.dataset.count):items.indexOf(a)-items.indexOf(b));
items.forEach(el=>el.hidden=true);filtered.forEach((el,i)=>{container.appendChild(el);el.hidden=!!hills.length&&i>=limit;});
if(count)count.textContent=hills.length?`${filtered.length.toLocaleString('en-GB')} ${filtered.length===1?'summit':'summits'}${filtered.length>limit?' · Showing '+Math.min(limit,filtered.length):''}`:`${filtered.length} hill ${filtered.length===1?'list':'lists'}`;
if(empty)empty.hidden=filtered.length!==0;if(more){const mh=filtered.length<=limit;if(mh)keepFocus(more);more.hidden=mh;more.textContent=`Show ${Math.min(48,filtered.length-limit)} more summits`;}
if(reset){const rh=!q&&(!area||area.value==='all')&&(!region||region.value==='all')&&(!sort||sort.value===(hills.length?'height':'featured'));if(rh)keepFocus(reset);reset.hidden=rh;}
}
for(const el of [input,sort,area,region].filter(Boolean))el.addEventListener(el===input?'input':'change',()=>{limit=16;update();});
reset?.addEventListener('click',()=>{if(input)input.value='';if(area)area.value='all';if(region)region.value='all';if(sort)sort.value=hills.length?'height':'featured';limit=16;update();});
more?.addEventListener('click',()=>{limit+=48;update();});root.querySelector('[data-print]')?.addEventListener('click',()=>window.print());
root.addEventListener('click',e=>{const a=e.target.closest('[data-app-cta]');if(a)window.dispatchEvent(new CustomEvent('waymark:app-open',{detail:{list:a.dataset.list||'all',placement:a.dataset.appCta,destination:a.href}}));});
window.addEventListener('beforeprint',()=>{if(hills.length)[...hills].sort((a,b)=>Number(b.dataset.height)-Number(a.dataset.height)||a.dataset.name.localeCompare(b.dataset.name)).forEach(el=>container.appendChild(el));});
window.addEventListener('afterprint',update);
update();
})();
