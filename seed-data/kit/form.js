/* Repris de la V10 (2e IA) et corrigé NexAI v8 : variables des familles, aria-invalid. */
/* NEXAI form — construit un formulaire (contact OU réservation) depuis une config.
   AUCUN texte par défaut : libellés, erreurs et messages viennent du brief client, sinon erreur claire.
   NexaiForm.mount(el,{endpoint,type,fields:[{name,type,label,required,options,min,max,autocomplete}],
     labels:{submit,sending,success,error}, errors:{required,email,phone}, extra:{site_id:"..."}}) */
(function(g){
 const need=(c)=>{const m=[];const nx=!c.endpoint;["submit"].concat(nx?[]:["sending","success","error"]).forEach(k=>!(c.labels&&c.labels[k])&&m.push("labels."+k));
  const T=(c.fields||[]).map(f=>f.type);["required"].concat(T.includes("email")?["email"]:[],T.includes("tel")?["phone"]:[]).forEach(k=>!(c.errors&&c.errors[k])&&m.push("errors."+k));(c.fields||[]).forEach(f=>!f.label&&m.push("label:"+f.name));
  if(!c.fields||!c.fields.length)m.push("fields");if(m.length)throw new Error("NexaiForm: config incomplète -> "+m.join(", "))};
 const EM=/^[^\s@]+@[^\s@]+\.[^\s@]+$/,PH=/^[+()\d\s.-]{8,}$/;
 function mount(el,c){need(c);const t0=Date.now();el.classList.add("nx-form");el.setAttribute("novalidate","");el.setAttribute("data-type",c.type||"contact");el.setAttribute("data-nexai-type",c.type||"contact");/* mode NEXAI : sans endpoint, le script injecté par le backend (injectBackend) envoie le formulaire */
  const mk=(f)=>{const id="nx-"+f.name,w=document.createElement("div");w.className="nx-f";w.dataset.name=f.name;
   const l=document.createElement("label");l.htmlFor=id;l.textContent=f.label;
   let i;if(f.type==="textarea")i=document.createElement("textarea");
   else if(f.type==="select"){i=document.createElement("select");(f.options||[]).forEach(o=>{const p=document.createElement("option");p.value=o.value??o;p.textContent=o.label??o;i.appendChild(p)})}
   else{i=document.createElement("input");i.type=f.type||"text";if(f.min!=null)i.min=f.min;if(f.max!=null)i.max=f.max}
   i.id=id;i.name=f.name;if(f.required)i.required=true;if(f.autocomplete)i.autocomplete=f.autocomplete;i.setAttribute("aria-describedby",id+"-e");i.setAttribute("aria-invalid","false");
   const e=document.createElement("div");e.className="nx-e";e.id=id+"-e";w.append(l,i,e);return w};
  el.append(...c.fields.map(mk));
  const hp=document.createElement("div");hp.className="nx-hp";hp.setAttribute("aria-hidden","true");hp.innerHTML='<input tabindex="-1" autocomplete="off" name="website">';el.appendChild(hp);
  const b=document.createElement("button");b.type="submit";b.className="btn";b.textContent=c.labels.submit;el.appendChild(b);
  const m=document.createElement("div");m.setAttribute("role","status");m.setAttribute("aria-live","polite");if(c.endpoint)el.appendChild(m);
  const val=()=>{let ok=true;c.fields.forEach(f=>{const w=el.querySelector(`[data-name="${f.name}"]`),v=w.querySelector("input,select,textarea").value.trim();let e="";
   const A=f.after&&el.querySelector(`[name="${f.after}"]`);if(f.required&&!v)e=f.error||c.errors.required;else if(v&&f.type==="email"&&!EM.test(v))e=f.error||c.errors.email;else if(v&&f.type==="tel"&&!PH.test(v))e=f.error||c.errors.phone;else if(v&&((f.min!=null&&(f.type==="number"?+v<+f.min:v<String(f.min)))||(f.max!=null&&(f.type==="number"?+v>+f.max:v>String(f.max)))||(A&&A.value&&v<=A.value)))e=f.error||c.errors.required;
   w.toggleAttribute("data-err",!!e);w.querySelector("input,select,textarea").setAttribute("aria-invalid",e?"true":"false");w.querySelector(".nx-e").textContent=e;if(e)ok=false});return ok};
  if(!c.endpoint){el.addEventListener("submit",ev=>{if(!val()){ev.preventDefault();ev.stopImmediatePropagation();el.querySelector("[data-err] input,[data-err] select,[data-err] textarea")?.focus()}},true);return el}
  el.addEventListener("submit",async ev=>{ev.preventDefault();m.textContent="";if(!val()){el.querySelector("[data-err] input,[data-err] select,[data-err] textarea")?.focus();return}
   const d=Object.fromEntries(new FormData(el));if(d.website||Date.now()-t0<2500)return;delete d.website;
   Object.assign(d,c.extra||{},{type:c.type||"contact"});el.dataset.state="sending";b.textContent=c.labels.sending;
   try{const r=await fetch(c.endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d)});if(!r.ok)throw 0;
    el.reset();m.className="nx-msg";m.dataset.k="ok";m.textContent=c.labels.success}
   catch(_){m.className="nx-msg";m.dataset.k="ko";m.textContent=c.labels.error}
   finally{el.dataset.state="";b.textContent=c.labels.submit}});
  return el}
 g.NexaiForm={mount};
})(window);
