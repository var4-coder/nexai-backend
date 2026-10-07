async () => {
  const R = {overflow:false, occluded:[], overlaps:[], ink:[], priceWrap:[], h1Lines:0, smallText:[], tapSmall:[], contrast:[], fontsMissing:[]};
  const W = window.innerWidth;
  R.overflow = document.documentElement.scrollWidth > W + 1;
  const hex2 = (c)=>{const m=c.match(/rgba?\(([^)]+)\)/); if(!m) return null; const a=m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return {r:a[0],g:a[1],b:a[2],a:a.length>3?a[3]:1};};
  const parseHex = (h)=>({r:parseInt(h.slice(1,3),16),g:parseInt(h.slice(3,5),16),b:parseInt(h.slice(5,7),16),a:1});
  const lin = v=>{v/=255; return v<=0.04045? v/12.92 : Math.pow((v+0.055)/1.055,2.4)};
  const L = c=>0.2126*lin(c.r)+0.7152*lin(c.g)+0.0722*lin(c.b);
  const ratio=(a,b)=>{const x=L(a),y=L(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
  const mix=(top,bot,al)=>({r:top.r*al+bot.r*(1-al),g:top.g*al+bot.g*(1-al),b:top.b*al+bot.b*(1-al),a:1});
  function bgOf(el){
    const stack=[];
    for(let e=el;e;e=e.parentElement){
      if(e.dataset && e.dataset.bg){ stack.push(parseHex(e.dataset.bg)); break; }
      const c=hex2(getComputedStyle(e).backgroundColor);
      if(c && c.a>0){ stack.push(c); if(c.a>=0.99) break; }
    }
    if(!stack.length) return {r:255,g:255,b:255,a:1};
    let base=stack[stack.length-1]; base={...base,a:1};
    for(let i=stack.length-2;i>=0;i--) base=mix(stack[i],base,stack[i].a);
    return base;
  }
  function opac(el){let o=1; for(let e=el;e;e=e.parentElement){o*=parseFloat(getComputedStyle(e).opacity)} return o;}
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  const nodes=[]; let n;
  while(n=walker.nextNode()){
    if(!n.textContent.trim()) continue;
    const el=n.parentElement, cs=getComputedStyle(el);
    if(cs.visibility==='hidden'||cs.display==='none') continue;
    if(el.closest('style,script,title,.ph>span,.mbar')) continue; { const d=el.closest('details:not([open])'); if(d && !el.closest('summary')) continue; }
    const r=document.createRange(); r.selectNodeContents(n);
    const rects=[...r.getClientRects()].filter(x=>x.width>1&&x.height>1);
    if(!rects.length) continue;
    nodes.push({n,el,cs,rects:rects.map(x=>({x:x.left+scrollX,y:x.top+scrollY,w:x.width,h:x.height}))});
  }
  // chevauchements texte/texte (coordonnées document)
  const desc=(el)=>el.tagName.toLowerCase()+(el.className&&typeof el.className==='string'?'.'+el.className.split(' ')[0]:'')+' «'+el.textContent.trim().slice(0,24)+'»';
  for(let i=0;i<nodes.length;i++) for(let j=i+1;j<nodes.length;j++){
    const A=nodes[i],B=nodes[j]; if(A.el===B.el) continue;
    // les éléments fixes/sticky faussent les coordonnées : ignorés
    for(const a of A.rects) for(const b of B.rects){
      const ix=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x), iy=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);
      // on réduit la boîte verticale à 70 % (zone d'encre) pour éviter les faux positifs d'interligne
      const shrinkA=a.h*0.15, shrinkB=b.h*0.15;
      const iy2=Math.min(a.y+a.h-shrinkA,b.y+b.h-shrinkB)-Math.max(a.y+shrinkA,b.y+shrinkB);
      if(ix>2 && iy2>2){ R.overlaps.push(desc(A.el)+' ⟷ '+desc(B.el)); break; }
    }
  }
  R.overlaps=[...new Set(R.overlaps)];
  // masquage : un autre élément est dessus
  for(const t of nodes){
    t.el.scrollIntoView({block:'center'});
    await new Promise(r=>requestAnimationFrame(r));
    const r=document.createRange(); r.selectNodeContents(t.n);
    const rects=[...r.getClientRects()].filter(x=>x.width>1&&x.height>1);
    let done=false;
    for(const x of rects){
      for(const fx of [Math.min(x.width/2,40), x.width/2, x.width-Math.min(6,x.width/2)]){
        const px=x.left+fx, py=x.top+x.height/2;
        if(px<0||py<0||px>W||py>innerHeight) continue;
        const hit=document.elementFromPoint(px,py);
        if(!hit) continue;
        if(hit===t.el||t.el.contains(hit)||hit.contains(t.el)) continue;
        if(hit.closest('a,.btn')&&hit.closest('a,.btn')===t.el.closest('a,.btn')) continue;
        R.occluded.push(desc(t.el)+' sous '+desc(hit)); done=true; break;
      }
      if(done) break;
    }
  }
  scrollTo(0,0);
  for(const el of document.querySelectorAll('*')){ if(el.scrollLeft) el.scrollLeft=0; if(el.scrollTop&&el!==document.documentElement&&el!==document.body) el.scrollTop=0; }
  R.occluded=[...new Set(R.occluded)];
  // encre : pour chaque paire de lignes, jambages réels de la ligne n contre accents réels de la ligne n+1
  const cv=document.createElement('canvas').getContext('2d');
  const seen=new Set();
  for(const t of nodes){
    const lines=new Set(t.rects.map(r=>Math.round(r.y))); if(lines.size<2) continue;
    const el=t.el, cs=t.cs; if(seen.has(el)) continue; seen.add(el);
    const fs=parseFloat(cs.fontSize); if(fs<20) continue;
    let tr=false; for(let e=el;e;e=e.parentElement){ if(getComputedStyle(e).transform!=='none'){tr=true;break} } if(tr) continue;
    let lh=parseFloat(cs.lineHeight); if(isNaN(lh)) lh=fs*1.2;
    cv.font=`${cs.fontStyle} ${cs.fontWeight} ${fs}px ${cs.fontFamily}`;
    const up=cs.textTransform==='uppercase';
    // encre de chaque caractère (position réelle) : descente des caractères de la ligne n contre montée de ceux de la ligne n+1 qui sont au-dessus/au-dessous
    const txt=t.n.textContent; const byLine=new Map();
    for(let k=0;k<txt.length;k++){ const ch=up?txt[k].toUpperCase():txt[k]; if(!ch.trim()) continue; const r=document.createRange(); r.setStart(t.n,k); r.setEnd(t.n,k+1); const rc=r.getClientRects()[0]; if(!rc) continue; const m=cv.measureText(ch); const key=Math.round(rc.top); if(!byLine.has(key)) byLine.set(key,[]); byLine.get(key).push({x0:rc.left,x1:rc.right,asc:m.actualBoundingBoxAscent,des:m.actualBoundingBoxDescent}); }
    const keys=[...byLine.keys()].sort((a,b)=>a-b);
    let hit=false, tight=false;
    for(let k=0;k+1<keys.length&&!hit;k++){
      const gap=keys[k+1]-keys[k];
      for(const a of byLine.get(keys[k])) for(const b of byLine.get(keys[k+1])){
        if(Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0)<=0) continue;
        const ink=a.des+b.asc;
        if(ink>gap){hit=true;break} else if(ink>gap-0.03*fs) tight=true;
      }
      if(hit) R.ink.push(desc(el)+` lignes ${k+1}/${k+2} (interligne ${(lh/fs).toFixed(2)})`);
    }
    if(!hit&&tight) (R.tight=R.tight||[]).push(desc(el));
  }
  // prix coupés (détection par le texte : chiffres + F / FCFA / €)
  const priceRe=/^(dès\s)?[\d][\d\s\u00a0\u202f.,]*\s?(F|FCFA|€|\$)(\s*\/\s*\w+)?$/i;
  for(const t of nodes){
    const s=t.n.textContent.trim(); if(s.length>28||!priceRe.test(s)) continue;
    const tops=new Set(t.rects.map(r=>Math.round(r.y))); if(tops.size>1) R.priceWrap.push(s);
  }
  // lignes du titre
  const h1=document.querySelector('h1');
  if(h1){const r=document.createRange(); r.selectNodeContents(h1); R.h1Lines=new Set([...r.getClientRects()].filter(x=>x.width>2).map(x=>Math.round(x.top/4))).size;}
  // taille du texte
  for(const t of nodes){
    const fs=parseFloat(t.cs.fontSize), len=t.n.textContent.trim().length;
    if(fs<11) R.smallText.push(desc(t.el)+' '+fs+'px');
    else if(W<500 && fs<14 && len>70) R.smallText.push('long texte '+desc(t.el)+' '+fs+'px');
  }
  R.smallText=[...new Set(R.smallText)];
  // cibles tactiles (téléphone)
  if(W<500) for(const el of document.querySelectorAll('.btn,.lnk,.burger,button,a')){ const d=getComputedStyle(el).display; if(el.tagName==='A'&&d==='inline'&&!el.classList.contains('btn')) continue; if(el.closest('.mbar')&&false) continue;
    { const d=el.closest('details:not([open])'); if(d && !el.closest('summary')) continue; } const r=el.getBoundingClientRect(); if(r.width===0) continue;
    if(r.height<40) R.tapSmall.push(desc(el)+' '+Math.round(r.height)+'px');
  }
  R.texts=[];
  const cseen2=new Set();
  for(const t of nodes){
    if(t.el.closest('[aria-hidden="true"]')) continue;
    const cs=t.cs; const fs=parseFloat(cs.fontSize), fw=parseInt(cs.fontWeight);
    let o=1; for(let e=t.el;e;e=e.parentElement){o*=parseFloat(getComputedStyle(e).opacity)}
    R.texts.push({d:desc(t.el), color:cs.color, o, large: fs>=24||(fs>=18.6&&fw>=700), rects:t.rects.map(r=>[r.x,r.y,r.w,r.h])});
  }
  return R;
}
