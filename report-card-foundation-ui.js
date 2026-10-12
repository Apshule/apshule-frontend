const esc=(s)=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const RC_LEVELS=[["nursery","Nursery"],["primary","Primary"],["o_level","O-Level"],["a_level","A-Level"]];
function parseCsv(text){
  const rows=[];let row=[],cell="",quoted=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(quoted&&c==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(c==='"'){quoted=!quoted;}else if(c===","&&!quoted){row.push(cell.trim());cell="";}else if((c==="\n"||c==="\r")&&!quoted){if(c==="\r"&&text[i+1]==="\n")i++;row.push(cell.trim());if(row.some(Boolean))rows.push(row);row=[];cell="";}else cell+=c;}
  if(cell||row.length){row.push(cell.trim());if(row.some(Boolean))rows.push(row);}
  if(!rows.length)return[];const headers=rows.shift().map(x=>x.toLowerCase());
  return rows.map(values=>Object.fromEntries(headers.map((h,i)=>[h,values[i]||""])));
}

export function initReportCardFoundationUI({api,getCurrentUser,notify=()=>{}}){
  const overlay=document.createElement("section");
  overlay.id="rcFoundation";
  overlay.innerHTML=`<header style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><div><small>REPORT CARD FOUNDATION</small><p id="rcfStats" aria-live="polite">Loading…</p></div><button class="cc6-button secondary" type="button" data-rcf-refresh>Refresh</button></header>
  <nav role="tablist" aria-label="Report card setup" style="display:flex;gap:8px;overflow:auto;padding:10px 0">${["Branding","Classes","Learners","Subjects","Grading","Cards"].map((x,i)=>`<button class="cc6-button ${i?"secondary":""}" role="tab" aria-selected="${!i}" data-rcf-tab="${x.toLowerCase()}">${x}</button>`).join("")}</nav>
   <style>.rcf-card{display:flex;flex-direction:column;gap:7px;padding:16px;border:1px solid #dbe1ea;border-radius:14px;background:#fff;box-shadow:0 2px 8px #152c480b}.rcf-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:12px}.rcf-card small{color:#526173}.rcf-card .cc6-button{min-height:44px}@media(max-width:560px){.rcf-card{padding:14px}}</style><main id="rcfContent" style="background:white;border-radius:14px;padding:16px;min-height:55vh"></main>`;
  function mount(){
    const workspace=document.getElementById("reportCardFoundationMount");
    if(!workspace){console.warn("[RC] Report Cards mount point is not in the DOM yet.");return false;}
    if(overlay.parentElement!==workspace){console.log("[RC] mounting at",workspace);workspace.append(overlay);}
    return true;
  }
  mount();
  let level="primary",classId="",selected="branding";
  const call=(path,opts)=>api(`/api${path}`,opts);
  async function show(tab=selected){
    selected=tab;for(const b of overlay.querySelectorAll("[data-rcf-tab]"))b.setAttribute("aria-selected",String(b.dataset.rcfTab===tab));
    const host=overlay.querySelector("#rcfContent");
    const levels=RC_LEVELS.map(([v,l])=>`<option value="${v}" ${v===level?"selected":""}>${l}</option>`).join("");
    if(tab==="branding"){
      const {branding:b={}}=await call("/rc/branding");
      host.innerHTML=`<h3>School branding</h3><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px"><label>School short code<input class="cc6-field" value="${esc(b.short_code)}" readonly aria-readonly="true"></label><p>To request a short-code change, <a href="mailto:legal@appshule.com?subject=School%20short%20code%20change">contact APSHULE</a>.</p><label>Motto<input class="cc6-field" name="motto" value="${esc(b.motto)}"></label><label>Street<input class="cc6-field" name="street" value="${esc(b.street)}"></label><label>P.O. Box<input class="cc6-field" name="po_box" value="${esc(b.po_box)}"></label><label>Phone<input class="cc6-field" name="phone" value="${esc(b.phone)}"></label><label>Email<input class="cc6-field" name="email" type="email" value="${esc(b.email)}"></label><label>Website<input class="cc6-field" name="website" value="${esc(b.website)}"></label><label>Theme<select class="cc6-field" name="report_theme">${["blue","maroon","mixed"].map(x=>`<option ${b.report_theme===x?"selected":""}>${x}</option>`)}</select></label><label>Header notes<input class="cc6-field" name="report_header_notes" value="${esc(b.report_header_notes)}"></label><label>Footer text<input class="cc6-field" name="report_footer_text" value="${esc(b.report_footer_text)}"></label><label>Logo image<input class="cc6-field" type="file" accept="image/png,image/jpeg" data-rcf-image="report_logo_base64"></label><label>Signature image<input class="cc6-field" type="file" accept="image/png,image/jpeg" data-rcf-image="report_signature_base64"></label></div><p id="rcfBrandPreview" style="padding:16px;border-top:4px solid #3a68a8">${esc(b.name||"School name")} · ${esc(b.motto||"Motto")} · Learner login email suffix: @${esc(b.short_code)}.apshule.internal</p><button class="cc6-button" data-rcf-save-brand>Save Branding</button>`;
    }else if(tab==="classes"){
      const {classes=[]}=await call("/rc/classes");
       host.innerHTML=`<h3>Classes</h3><p>Set up classes before adding learners.</p><button class="cc6-button" data-rcf-add-class>＋ Create Class</button><div class="rcf-grid" style="margin-top:14px">${classes.map(x=>`<article class="rcf-card"><strong>${esc(x.name)}</strong><small>${esc(x.level)} · ${esc(x.stream||"No stream")} · ${esc(x.learner_count)} learners</small><div><button class="cc6-button secondary" data-rcf-edit-class="${esc(x.id)}">Edit</button> <button class="cc6-button secondary" data-rcf-delete-class="${esc(x.id)}">Archive</button></div></article>`).join("")||`<p>Create the first class to continue.</p>`}</div>`;
    }else if(tab==="learners"){
      const {classes=[]}=await call("/rc/classes");
      const {learners=[]}=await call(`/rc/learners${classId?`?class_id=${encodeURIComponent(classId)}`:""}`);
       host.innerHTML=`<h3>Learners</h3><label>Class <select class="cc6-field" data-rcf-class><option value="">All classes</option>${classes.map(x=>`<option value="${esc(x.id)}" ${classId===x.id?"selected":""}>${esc(x.name)}</option>`)}</select></label> <button class="cc6-button" data-rcf-add-learner ${classes.length?"":"disabled"}>＋ Add Learner</button><p><button class="cc6-button secondary" data-rcf-template>Download CSV template</button> <label class="cc6-button secondary" ${classId?"":"aria-disabled='true'"}>Import CSV<input type="file" hidden accept=".csv" data-rcf-csv ${classId?"":"disabled"}></label></p><div><label>Move selected to <select class="cc6-field" data-rcf-dest-class>${classes.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`)}</select></label> <button class="cc6-button secondary" data-rcf-bulk-assign>Move learners</button></div><div class="rcf-grid">${learners.map(x=>`<article class="rcf-card"><label><input type="checkbox" data-rcf-select-learner value="${esc(x.id)}"> Select</label><strong>${esc(x.full_name)}</strong><small>${esc(x.reg_no)} · ${esc(x.class_name||"Unassigned")} · ${esc(x.age||"Age not set")} · ${esc(x.gender||"")}</small><small>${esc(x.parent_email||"No parent email")}</small><div><button class="cc6-button secondary" data-rcf-reset-password="${esc(x.id)}">Reset password</button> <button class="cc6-button secondary" data-rcf-delete-learner="${esc(x.id)}">Archive</button></div></article>`).join("")||`<p>No learners found.</p>`}</div>`;
    }else if(tab==="subjects"){
      const {subjects=[]}=await call(`/rc/subjects?level=${level}`);
       host.innerHTML=`<h3>Subjects</h3><label>Level <select data-rcf-level class="cc6-field">${levels}</select></label> <button class="cc6-button" data-rcf-seed-subjects>Seed Default Subjects</button> <button class="cc6-button secondary" data-rcf-add-subject>Add Subject</button><div class="rcf-grid" style="margin-top:14px">${subjects.map(s=>`<article class="rcf-card"><strong>${esc(s.name)}</strong><small>${esc(s.code||"No code")} · ${esc(s.papers)} paper(s) · ${s.active?"Active":"Inactive"}</small><button class="cc6-button secondary" data-rcf-delete-subject="${esc(s.id)}">Archive</button></article>`).join("")||`<p>No subjects yet.</p>`}</div>`;
    }else if(tab==="grading"){
      const {grading=[]}=await call(`/rc/grading?level=${level}`);
      const nursery=level==="nursery"?await call("/rc/nursery"):null;
      host.innerHTML=`<h3>Grading</h3><label>Level <select data-rcf-level class="cc6-field">${levels}</select></label> <button class="cc6-button" data-rcf-seed-grading>Seed Default Grading</button> <button class="cc6-button secondary" data-rcf-add-grade>Add Grade</button><div class="rc-table-wrap"><table class="rc-table"><thead><tr><th>Grade</th><th>Min</th><th>Max</th><th>Descriptor</th></tr></thead><tbody>${grading.map(g=>`<tr><td>${esc(g.grade_code)}</td><td>${esc(g.min_score)}</td><td>${esc(g.max_score)}</td><td>${esc(g.descriptor)}</td></tr>`).join("")||`<tr><td colspan="4">No grading bands yet.</td></tr>`}</tbody></table></div><p>Scores map to the school’s selected grading bands.</p>${level==="nursery"?`<h4>Learning Areas & Activities</h4><button class="cc6-button secondary" data-rcf-seed-nursery>Seed Nursery Defaults</button><h5>Learning areas</h5>${nursery.areas.map(x=>`<article class="rcf-card"><strong>${esc(x.name)}</strong><small>${esc(x.code)} · max ${esc(x.max_score)}</small></article>`).join("")||"<p>No learning areas configured.</p>"}<h5>Activities</h5>${nursery.activities.map(x=>`<article class="rcf-card"><strong>${esc(x.name)}</strong><small>${esc(x.code)}</small></article>`).join("")||"<p>No activities configured.</p>"}`:""}`;
    }else{
      const {classes=0,learners=0,subjects=0,grading_ready=false}=await call("/rc/stats");
      host.innerHTML=`<h3>Report cards readiness</h3><p>${classes} classes · ${learners} learners · ${subjects} subjects · ${grading_ready?"Grading ready":"Grading not configured"}</p><p>Report card creation and publishing will be added in Phase 10B.</p>`;
    }
  }
  async function stats(){const s=await call("/rc/stats");overlay.querySelector("#rcfStats").textContent=`${s.classes} classes · ${s.learners} learners · ${s.subjects} subjects · ${s.grading_ready?"Grading ready":"Grading not configured"}`;}
  function fileBase64(file,max){return new Promise((resolve,reject)=>{if(file.size>max){reject(Error(`File must be no larger than ${Math.round(max/1000)} KB.`));return;}const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error("Could not read image."));r.readAsDataURL(file);});}
  let activeUserId=null;
  overlay.addEventListener("click",async e=>{const t=e.target.closest("button,[data-rcf-class],[data-rcf-level]");if(!t)return;try{
    if(t.matches("[data-rcf-refresh]")){await stats();await show(selected);return;}
    if(t.matches("[data-rcf-tab]")){await show(t.dataset.rcfTab);return;}
    if(t.matches("[data-rcf-class]")){classId=t.value;await show("learners");return;}
    if(t.matches("[data-rcf-level]")){level=t.value;await show(selected);return;}
     if(t.matches("[data-rcf-bulk-assign]")){const learner_ids=[...overlay.querySelectorAll("[data-rcf-select-learner]:checked")].map(x=>x.value);if(!learner_ids.length)throw Error("Select at least one learner.");const result=await call("/rc/learners/bulk-assign-class",{method:"POST",body:{learner_ids,class_id:overlay.querySelector("[data-rcf-dest-class]").value}});notify(`${result.moved} learners moved.`,"success");await show("learners");return;}
    if(t.matches("[data-rcf-save-brand]")){const body={};for(const el of overlay.querySelectorAll("[name]"))body[el.name]=el.value;for(const el of overlay.querySelectorAll("[data-rcf-image]"))if(el.dataset.value)body[el.dataset.rcfImage]=el.dataset.value;await call("/rc/branding",{method:"PATCH",body});notify("Branding saved.","success");return;}
    if(t.matches("[data-rcf-add-class]")){const name=prompt("Class name (for example P.2K or S.1 East)");if(!name)return;const levelName=prompt("Level: nursery, primary, o_level, or a_level","primary");if(!levelName)return;await call("/rc/classes",{method:"POST",body:{name,level:levelName}});await show("classes");await stats();return;}
     if(t.matches("[data-rcf-edit-class]")){const id=t.dataset.rcfEditClass,{class:record}=await call(`/rc/classes/${id}`);const name=prompt("Class name",record.name);if(!name)return;const stream=prompt("Stream",record.stream||"");await call(`/rc/classes/${id}`,{method:"PATCH",body:{name,stream}});await show("classes");return;}
    if(t.matches("[data-rcf-delete-class]")){if(!confirm("Archive this class?"))return;await call(`/rc/classes/${t.dataset.rcfDeleteClass}`,{method:"DELETE"});await show("classes");return;}
     if(t.matches("[data-rcf-add-learner]")){if(!classId)throw Error("Choose a class before adding a learner.");const reg_no=prompt("Registration number");if(!reg_no)return;const full_name=prompt("Learner full name");if(!full_name)return;const gender=prompt("Gender (optional)","");const age=prompt("Age (optional)","");const parent_email=prompt("Parent email for password reset (optional)","");const parent_phone=prompt("Parent phone (optional)","");await call("/rc/learners",{method:"POST",body:{class_id:classId,reg_no,full_name,gender,age,parent_email,parent_phone}});await show("learners");await stats();return;}
     if(t.matches("[data-rcf-reset-password]")){if(!confirm("Reset this learner’s password to their registration number?"))return;const result=await call(`/school-admin/learners/${t.dataset.rcfResetPassword}/reset-password`,{method:"POST",body:{}});notify(result.notified?"Password reset; parent notified.":"Password reset; no parent email is on file.","success");return;}
    if(t.matches("[data-rcf-delete-learner]")){if(!confirm("Delete this learner?"))return;await call(`/rc/learners/${t.dataset.rcfDeleteLearner}`,{method:"DELETE"});await show("learners");return;}
     if(t.matches("[data-rcf-add-subject]")){const name=prompt("Subject name");if(!name)return;const code=prompt("Subject code (optional)","");const papers=Number(prompt("Number of papers","1"));await call("/rc/subjects",{method:"POST",body:{level,name,code,papers}});await show("subjects");return;}
     if(t.matches("[data-rcf-delete-subject]")){if(!confirm("Archive this subject?"))return;await call(`/rc/subjects/${t.dataset.rcfDeleteSubject}`,{method:"DELETE"});await show("subjects");return;}
    if(t.matches("[data-rcf-seed-subjects]")){await call("/rc/subjects/seed-defaults",{method:"POST",body:{level}});await show("subjects");return;}
    if(t.matches("[data-rcf-seed-grading]")){await call("/rc/grading/seed-defaults",{method:"POST",body:{level}});await show("grading");return;}
     if(t.matches("[data-rcf-seed-nursery]")){await call("/rc/nursery/seed-defaults",{method:"POST",body:{}});await show("grading");return;}
     if(t.matches("[data-rcf-add-grade]")){const grade_code=prompt("Grade code");if(!grade_code)return;const min_score=Number(prompt("Minimum score","0")),max_score=Number(prompt("Maximum score","100"));const descriptor=prompt("Descriptor","");await call("/rc/grading",{method:"POST",body:{level,grade_code,min_score,max_score,descriptor}});await show("grading");return;}
     if(t.matches("[data-rcf-template]")){const className=overlay.querySelector("[data-rcf-class] option:checked")?.textContent||"";const headers="reg_no,full_name,gender,age,class,stream,section,house,combination,parent_name,parent_phone,parent_email";const row=className?`,,,,\"${className.replaceAll('"','""')}\",,,,,,,`:"";const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([`${headers}\n${row}\n`],{type:"text/csv"}));a.download="learners-template.csv";a.click();URL.revokeObjectURL(a.href);}
  }catch(err){notify(err.message||"Action failed.","error");}});
  overlay.addEventListener("change",async e=>{const el=e.target;if(el.matches("[data-rcf-image]")){try{el.dataset.value=await fileBase64(el.files[0],el.dataset.rcfImage==="report_logo_base64"?300000:100000);}catch(err){notify(err.message,"error");}}if(el.matches("[data-rcf-csv]")&&el.files?.[0]){try{if(!classId)throw Error("Choose a class before importing learners.");const rows=parseCsv(await el.files[0].text());if(!rows.length)throw Error("The CSV has no learner rows.");const result=await call("/rc/learners/bulk",{method:"POST",body:{class_id:classId,rows}});notify(`Import complete: created ${result.created}, skipped ${result.skipped}, errors ${result.errors}.`,"success");await show("learners");await stats();}catch(err){notify(err.message||"CSV import failed.","error");}finally{el.value="";}}});
  async function setUser(user){
    if(user?.role!=="school"||user?.sector!=="education"){activeUserId=null;return;}
    if(!mount()){activeUserId=null;return;}
    if(String(user.id)===String(activeUserId))return;
    activeUserId=user.id;
    try{await stats();await show("branding");}catch(e){notify(e.message||"Could not load report-card setup.","error");}
  }
  return {open:async()=>{if(mount())await show(selected);},setUser};
}
