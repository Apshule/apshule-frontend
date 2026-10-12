import { Hono } from "hono";
import { ApiError, getDb } from "../db.js";
import { authMiddleware, hashPassword, requireRole } from "../auth.js";
import { sendEmail } from "../email.js";
import { readJson } from "../http.js";
import { linkedSchoolId } from "../ncdc-helpers.js";
import type { AppEnv } from "../types.js";

const rc = new Hono<AppEnv>();
const staff = [authMiddleware, requireRole("school", "teacher")] as const;
const levels = ["nursery", "primary", "o_level", "a_level"];
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const school = (c: any) => {
  const id = linkedSchoolId(c.get("user"));
  if (!id) throw new ApiError(403, "SCHOOL_REQUIRED", "Your account is not linked to a school.");
  return id;
};
const str = (v: unknown, field: string, max = 160, required = false) => {
  if (v == null || v === "") {
    if (required) throw new ApiError(400, "VALIDATION_ERROR", `${field} is required.`);
    return null;
  }
  if (typeof v !== "string" || v.trim().length > max) throw new ApiError(400, "VALIDATION_ERROR", `${field} is invalid.`);
  return v.trim();
};
const num = (v: unknown, field: string, min = 0, max = 100000000) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new ApiError(400, "VALIDATION_ERROR", `${field} is invalid.`);
  return n;
};
const validLevel = (v: unknown) => {
  const value = str(v, "level", 20, true)!;
  if (!levels.includes(value)) throw new ApiError(400, "VALIDATION_ERROR", "Unsupported school level.");
  return value;
};
const ownId = (v: string) => {
  if (!idPattern.test(v)) throw new ApiError(400, "VALIDATION_ERROR", "Invalid record id.");
  return v;
};
const normalizedRegNo = (v: string) => v.trim().toLowerCase().replace(/\s+/gu, "");
const internalEmail = (regNo: string, schoolCode: string) =>
  `${normalizedRegNo(regNo).replace(/[^a-z0-9._-]/gu, "-")}@${schoolCode}.apshule.internal`;

rc.use("*", ...staff);

rc.get("/rc/branding", async (c) => {
  const rows = await getDb(c.env)`SELECT id::text,name,short_code,motto,street,po_box,website,email,phone,report_theme,
    report_logo_base64,report_header_notes,report_footer_text,report_signature_base64 FROM schools WHERE id=${school(c)}::uuid`;
  if (!rows.length) throw new ApiError(404, "SCHOOL_NOT_FOUND", "School not found.");
  return c.json({ branding: rows[0] });
});
rc.patch("/rc/branding", requireRole("school"), async (c) => {
  const b = await readJson(c), sid = school(c);
  const theme = b.report_theme == null ? null : str(b.report_theme, "report_theme", 20);
  if (theme && !["blue", "maroon", "mixed"].includes(theme)) throw new ApiError(400, "VALIDATION_ERROR", "Unsupported report theme.");
  for (const [key, limit] of [["report_logo_base64", 410000], ["report_signature_base64", 140000]] as const) {
    if (typeof b[key] === "string" && b[key].length > limit) throw new ApiError(413, "IMAGE_TOO_LARGE", `${key} exceeds its size limit.`);
  }
  const result = await getDb(c.env)`UPDATE schools SET
    motto=COALESCE(${str(b.motto,"motto",500)},motto),street=COALESCE(${str(b.street,"street",300)},street),
    po_box=COALESCE(${str(b.po_box,"po_box",80)},po_box),website=COALESCE(${str(b.website,"website",300)},website),
    email=COALESCE(${str(b.email,"email",254)},email),phone=COALESCE(${str(b.phone,"phone",100)},phone),
    report_theme=COALESCE(${theme},report_theme),report_logo_base64=COALESCE(${str(b.report_logo_base64,"report_logo_base64",410000)},report_logo_base64),
    report_header_notes=COALESCE(${str(b.report_header_notes,"report_header_notes",2000)},report_header_notes),
    report_footer_text=COALESCE(${str(b.report_footer_text,"report_footer_text",2000)},report_footer_text),
    report_signature_base64=COALESCE(${str(b.report_signature_base64,"report_signature_base64",140000)},report_signature_base64)
    WHERE id=${sid}::uuid RETURNING id`;
  return c.json({ saved: result.length > 0 });
});

rc.get("/rc/classes", async (c) => {
  const sid=school(c),teacherId=c.get("user").role==="teacher"?c.get("user").id:"";
  const rows = await getDb(c.env)`SELECT c.*,u.name class_teacher_name,
    (SELECT COUNT(*)::int FROM learners l WHERE l.class_id=c.id AND l.active) learner_count
    FROM classes c LEFT JOIN users u ON u.id=c.class_teacher_id
    WHERE c.school_id=${sid}::uuid AND c.active AND (${teacherId}='' OR c.class_teacher_id::text=${teacherId}) ORDER BY c.level,c.name`;
  return c.json({ classes: rows });
});
rc.post("/rc/classes", requireRole("school"), async (c) => {
  const b=await readJson(c), sid=school(c), name=str(b.name,"name",80,true)!, level=validLevel(b.level);
  const result=await getDb(c.env)`INSERT INTO classes(school_id,name,level,stream,class_teacher_id,avg_age,fees_next_term,school_pay_code)
    VALUES(${sid}::uuid,${name},${level},${str(b.stream,"stream",80)},${b.class_teacher_id?ownId(String(b.class_teacher_id)) : null}::uuid,
    ${num(b.avg_age,"avg_age",1,100)},${num(b.fees_next_term,"fees_next_term")},${str(b.school_pay_code,"school_pay_code",100)})
    RETURNING *`;
  return c.json({ class: result[0] },201);
});
rc.get("/rc/classes/:id", async (c) => {
  const rows=await getDb(c.env)`SELECT * FROM classes WHERE id=${ownId(c.req.param("id"))}::uuid AND school_id=${school(c)}::uuid`;
  if(!rows.length)throw new ApiError(404,"NOT_FOUND","Class not found.");
  return c.json({class:rows[0]});
});
rc.patch("/rc/classes/:id", requireRole("school"), async (c) => {
  const b=await readJson(c), id=ownId(c.req.param("id")), sid=school(c);
  const result=await getDb(c.env)`UPDATE classes SET name=COALESCE(${str(b.name,"name",80)},name),level=COALESCE(${b.level==null?null:validLevel(b.level)},level),
    stream=COALESCE(${str(b.stream,"stream",80)},stream),class_teacher_id=COALESCE(${b.class_teacher_id?ownId(String(b.class_teacher_id)):null}::uuid,class_teacher_id),
    avg_age=COALESCE(${num(b.avg_age,"avg_age",1,100)},avg_age),fees_next_term=COALESCE(${num(b.fees_next_term,"fees_next_term")},fees_next_term),
    school_pay_code=COALESCE(${str(b.school_pay_code,"school_pay_code",100)},school_pay_code)
    WHERE id=${id}::uuid AND school_id=${sid}::uuid AND active RETURNING *`;
  if(!result.length)throw new ApiError(404,"NOT_FOUND","Class not found.");
  return c.json({class:result[0]});
});
rc.delete("/rc/classes/:id", requireRole("school"), async (c) => {
  const result=await getDb(c.env)`UPDATE classes SET active=FALSE WHERE id=${ownId(c.req.param("id"))}::uuid AND school_id=${school(c)}::uuid RETURNING id`;
  if(!result.length)throw new ApiError(404,"NOT_FOUND","Class not found.");
  return c.json({deleted:true});
});

rc.get("/rc/learners", async (c) => {
  const sid=school(c), classId=c.req.query("class_id"), search=(c.req.query("search")||"").slice(0,100), teacherId=c.get("user").role==="teacher"?c.get("user").id:"";
  if(classId)ownId(classId);
  const rows=await getDb(c.env)`SELECT l.*,c.name class_name FROM learners l LEFT JOIN classes c ON c.id=l.class_id
    WHERE l.school_id=${sid}::uuid AND l.active AND (${classId||""}='' OR l.class_id::text=${classId||""})
    AND (${teacherId}='' OR c.class_teacher_id::text=${teacherId})
    AND (${search}='' OR l.full_name ILIKE ${`%${search}%`} OR l.reg_no ILIKE ${`%${search}%`})
    ORDER BY l.full_name LIMIT 1000`;
  return c.json({learners:rows});
});
rc.get("/rc/learners/template",...staff,async c=>c.text("reg_no,full_name,gender,age,class,stream,section,house,combination,parent_name,parent_phone,parent_email\n",{headers:{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":"attachment; filename=learners-template.csv"}}));
rc.post("/rc/learners/bulk",requireRole("school"),async c=>{
  const b=await readJson(c),sid=school(c),classId=ownId(String(b.class_id||"")),rows=b.rows;
  if(!Array.isArray(rows)||rows.length<1||rows.length>500)throw new ApiError(400,"VALIDATION_ERROR","Provide between 1 and 500 learner rows.");
  const schoolRows=await getDb(c.env)`SELECT short_code FROM schools WHERE id=${sid}::uuid`;
  const schoolCode=String(schoolRows[0]?.short_code||"");
  if(!schoolCode)throw new ApiError(409,"SCHOOL_CODE_REQUIRED","Set the school short code before importing learners.");
  const target=await getDb(c.env)`SELECT id,name FROM classes WHERE id=${classId}::uuid AND school_id=${sid}::uuid AND active`;
  if(!target.length)throw new ApiError(400,"INVALID_CLASS","Choose an active class in your school.");
  const clean=rows.map((r:any)=>{
    const gender=str(r.gender,"gender",30,true)!,age=num(r.age,"age",0,120);
    const className=str(r.class,"class",80,true)!;
    const parentEmail=str(r.parent_email,"parent_email",254);
    if(age===null)throw new ApiError(400,"VALIDATION_ERROR","Every CSV row needs an age.");
    if(className.toLowerCase()!==String(target[0]!.name).toLowerCase())throw new ApiError(400,"CLASS_MISMATCH",`CSV class “${className}” does not match the selected class.`);
    if(parentEmail&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(parentEmail))throw new ApiError(400,"VALIDATION_ERROR","A parent email is invalid.");
    return {reg_no:str(r.reg_no,"reg_no",80,true)!,full_name:str(r.full_name,"full_name",200,true)!,gender,age,parent_name:str(r.parent_name,"parent_name",160),parent_phone:str(r.parent_phone,"parent_phone",40),parent_email:parentEmail,stream:str(r.stream,"stream",80),section:str(r.section,"section",40),house:str(r.house,"house",100),combination:str(r.combination,"combination",100)};
  });
  const seen=new Set<string>(), eligible:any[]=[], errors:any[]=[];
  for(const row of clean){const key=normalizedRegNo(row.reg_no);if(seen.has(key)){errors.push({reg_no:row.reg_no,error:"Duplicate in CSV"});continue;}seen.add(key);eligible.push({...row,email:internalEmail(row.reg_no,schoolCode),password_hash:await hashPassword(key)});}
  const existing=eligible.length?await getDb(c.env)`SELECT lower(regexp_replace(reg_no,'\\s+','','g')) reg FROM learners WHERE school_id=${sid}::uuid AND lower(regexp_replace(reg_no,'\\s+','','g')) IN (SELECT lower(regexp_replace(value->>'reg_no','\\s+','','g')) FROM jsonb_array_elements(${JSON.stringify(eligible)}::jsonb))`: [];
  const existingRegs=new Set(existing.map((x:any)=>String(x.reg)));
  const insertable=eligible.filter(x=>!existingRegs.has(normalizedRegNo(x.reg_no)));
  const skipped=eligible.length-insertable.length;
  if(insertable.length){
    await getDb(c.env)`WITH input AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(insertable)}::jsonb) AS x(reg_no text,full_name text,gender text,age numeric,parent_name text,parent_phone text,parent_email text,stream text,section text,house text,combination text,email text,password_hash text)),
      accounts AS (INSERT INTO users(name,email,phone,password_hash,role,sector,waitlist,school_id,must_change_password)
        SELECT full_name,email,parent_phone,password_hash,'individual','education',FALSE,${sid}::uuid,TRUE FROM input RETURNING id,email),
      added AS (INSERT INTO learners(user_id,school_id,class_id,reg_no,full_name,gender,age,parent_name,parent_phone,parent_email,school_short_code,must_change_password)
        SELECT a.id,${sid}::uuid,${classId}::uuid,i.reg_no,i.full_name,i.gender,i.age,i.parent_name,i.parent_phone,i.parent_email,${schoolCode},TRUE
        FROM input i JOIN accounts a ON a.email=i.email RETURNING id) SELECT COUNT(*) FROM added`;
  }
  return c.json({created:insertable.length,skipped,errors:errors.length,details:errors},201);
});
rc.post("/rc/learners/bulk-assign-class",requireRole("school"),async c=>{
  const b=await readJson(c),sid=school(c),classId=ownId(String(b.class_id||""));
  if(!Array.isArray(b.learner_ids)||!b.learner_ids.length||b.learner_ids.length>500)throw new ApiError(400,"VALIDATION_ERROR","Select 1 to 500 learners.");
  const ids=b.learner_ids.map((id:unknown)=>ownId(String(id)));
  const schoolRows=await getDb(c.env)`SELECT short_code FROM schools WHERE id=${sid}::uuid`;
  const schoolCode=String(schoolRows[0]?.short_code||"");
  if(!schoolCode)throw new ApiError(409,"SCHOOL_CODE_REQUIRED","Set the school short code before importing learners.");
  const result=await getDb(c.env)`WITH target AS (SELECT id FROM classes WHERE id=${classId}::uuid AND school_id=${sid}::uuid AND active),
    selected AS (SELECT id FROM learners WHERE school_id=${sid}::uuid AND active
      AND id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))::uuid))
    UPDATE learners l SET class_id=target.id FROM target,selected WHERE l.id=selected.id RETURNING l.id`;
  return c.json({moved:result.length});
});
rc.post("/rc/learners", requireRole("school"), async (c) => {
  const b=await readJson(c),sid=school(c),classId=ownId(String(b.class_id||""));
  const classExists=await getDb(c.env)`SELECT id FROM classes WHERE id=${classId}::uuid AND school_id=${sid}::uuid AND active`;
  if(!classExists.length)throw new ApiError(400,"INVALID_CLASS","Choose an active class in your school.");
  const photo=str(b.photo_base64,"photo_base64",280000);
  if(photo&&!photo.startsWith("data:image/"))throw new ApiError(400,"INVALID_IMAGE","Photo must be an image data URL.");
  const regNo=str(b.reg_no,"reg_no",80,true)!,fullName=str(b.full_name,"full_name",200,true)!;
  const schoolRows=await getDb(c.env)`SELECT short_code FROM schools WHERE id=${sid}::uuid`;
  const schoolCode=String(schoolRows[0]?.short_code||"");
  if(!schoolCode)throw new ApiError(409,"SCHOOL_CODE_REQUIRED","Set the school short code before adding learners.");
  const email=internalEmail(regNo,schoolCode),passwordHash=await hashPassword(normalizedRegNo(regNo));
  const result=await getDb(c.env)`WITH target AS (SELECT id FROM classes WHERE id=${classId}::uuid AND school_id=${sid}::uuid AND active),
    account AS (INSERT INTO users(name,email,phone,password_hash,role,sector,waitlist,school_id,must_change_password)
      SELECT ${fullName},${email},${str(b.phone,"phone",40)},${passwordHash},'individual','education',FALSE,${sid}::uuid,TRUE
      RETURNING id),
    learner AS (INSERT INTO learners(user_id,school_id,class_id,reg_no,lin,full_name,gender,age,date_of_birth,section,house,residence,combination,photo_base64,parent_name,parent_phone,parent_email,phone,school_short_code,must_change_password,fees_balance,days_attended,days_absent)
      SELECT account.id,${sid}::uuid,target.id,${regNo},${str(b.lin,"lin",80)},${fullName},${str(b.gender,"gender",30)},
      ${num(b.age,"age",0,120)},${b.date_of_birth||null}::date,${str(b.section,"section",40)},${str(b.house,"house",100)},${str(b.residence,"residence",200)},
      ${str(b.combination,"combination",100)},${photo},${str(b.parent_name,"parent_name",160)},${str(b.parent_phone,"parent_phone",40)},${str(b.parent_email,"parent_email",254)},${str(b.phone,"phone",40)},${schoolCode},TRUE,
      ${num(b.fees_balance,"fees_balance")||0},${num(b.days_attended,"days_attended",0,366)||0},${num(b.days_absent,"days_absent",0,366)||0}
      FROM target,account RETURNING *)
    SELECT * FROM learner`;
  if(!result.length)throw new ApiError(400,"INVALID_CLASS","Choose an active class in your school.");
  return c.json({learner:result[0]},201);
});
rc.patch("/rc/learners/:id", requireRole("school"), async (c) => {
  const id=ownId(c.req.param("id")),sid=school(c),b=await readJson(c);
  const targetClass=b.class_id?ownId(String(b.class_id)):null;
  if(targetClass){const valid=await getDb(c.env)`SELECT id FROM classes WHERE id=${targetClass}::uuid AND school_id=${sid}::uuid AND active`;if(!valid.length)throw new ApiError(400,"INVALID_CLASS","Choose an active class in your school.");}
  const result=await getDb(c.env)`UPDATE learners SET full_name=COALESCE(${str(b.full_name,"full_name",200)},full_name),
    reg_no=COALESCE(${str(b.reg_no,"reg_no",80)},reg_no),lin=COALESCE(${str(b.lin,"lin",80)},lin),
    age=COALESCE(${num(b.age,"age",0,120)},age),gender=COALESCE(${str(b.gender,"gender",30)},gender),
    class_id=COALESCE(${targetClass}::uuid,class_id),parent_email=COALESCE(${str(b.parent_email,"parent_email",254)},parent_email),
    phone=COALESCE(${str(b.phone,"phone",40)},phone)
    WHERE id=${id}::uuid AND school_id=${sid}::uuid AND active RETURNING *`;
  if(!result.length)throw new ApiError(404,"NOT_FOUND","Learner not found.");
  return c.json({learner:result[0]});
});
rc.delete("/rc/learners/:id", requireRole("school"), async (c) => {
  const result=await getDb(c.env)`UPDATE learners SET active=FALSE WHERE id=${ownId(c.req.param("id"))}::uuid AND school_id=${school(c)}::uuid RETURNING id`;
  if(!result.length)throw new ApiError(404,"NOT_FOUND","Learner not found.");
  return c.json({deleted:true});
});
rc.post("/school-admin/learners/:id/reset-password",requireRole("school"),async c=>{
  const sid=school(c),id=ownId(c.req.param("id"));
  const rows=await getDb(c.env)`SELECT l.reg_no,l.full_name,l.parent_email,u.id user_id FROM learners l
    JOIN users u ON u.id=l.user_id WHERE l.id=${id}::uuid AND l.school_id=${sid}::uuid AND l.active`;
  if(!rows.length)throw new ApiError(404,"NOT_FOUND","Learner not found.");
  const learner=rows[0] as {reg_no:string;full_name:string;parent_email:string|null;user_id:string};
  const password=normalizedRegNo(learner.reg_no),passwordHash=await hashPassword(password);
  await getDb(c.env)`UPDATE users SET password_hash=${passwordHash},must_change_password=TRUE,
    session_version=COALESCE(session_version,0)+1,updated_at=NOW() WHERE id=${learner.user_id}::uuid`;
  await getDb(c.env)`UPDATE learners SET must_change_password=TRUE WHERE id=${id}::uuid AND school_id=${sid}::uuid`;
  let notified=false;
  if(learner.parent_email){
    const safeName=learner.full_name.replace(/[&<>"']/gu,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]!));
    notified=await sendEmail(c.env,{to:learner.parent_email,subject:"Learner password reset",html:`<p>The password for ${safeName}'s AppShule learner account was reset by the school.</p><p>The learner must sign in with their registration number and change the password.</p>`});
  }
  return c.json({reset:true,notified});
});

const subjectSeeds:Record<string,[string,string,number][]> = {
  primary:[["","English",1],["","Mathematics",1],["","Science",1],["","Social Studies",1],["","Religious Education",1],["","Literacy",1]],
  o_level:[["535","Biology",1],["545","Chemistry",1],["112","English",1],["456","Mathematics",1],["273","Geography",1],["241","History & Political Education",1],["553","Physics",1],["223","Religious Education",1],["336","Kiswahili",1],["850","ICT",1],["612","Art & Design",1],["527","Agriculture",1],["845","Entrepreneurship",1],["208","Literature",1],["345","Runyankore Rukiga",1]],
  nursery:[["","Language",1],["","Mathematical Concepts",1],["","Environmental Awareness",1],["","Creative Development",1],["","Physical Development",1]],
  a_level:[["535","Biology",2],["545","Chemistry",2],["456","Mathematics",2],["553","Physics",2],["850","ICT",2],["","General Paper",1]],
};
rc.get("/rc/subjects",async c=>{const level=validLevel(c.req.query("level"));const subjects=await getDb(c.env)`SELECT * FROM school_subjects WHERE school_id=${school(c)}::uuid AND level=${level} ORDER BY sort_order,name`;return c.json({subjects});});
rc.post("/rc/subjects",requireRole("school"),async c=>{const b=await readJson(c),sid=school(c),result=await getDb(c.env)`INSERT INTO school_subjects(school_id,code,name,level,papers,sort_order) VALUES(${sid}::uuid,${str(b.code,"code",40)},${str(b.name,"name",120,true)},${validLevel(b.level)},${num(b.papers,"papers",1,10)||1},${num(b.sort_order,"sort_order",0,1000)||0}) RETURNING *`;return c.json({subject:result[0]},201);});
rc.patch("/rc/subjects/:id",requireRole("school"),async c=>{const b=await readJson(c),id=ownId(c.req.param("id")),result=await getDb(c.env)`UPDATE school_subjects SET code=COALESCE(${str(b.code,"code",40)},code),name=COALESCE(${str(b.name,"name",120)},name),papers=COALESCE(${num(b.papers,"papers",1,10)},papers),sort_order=COALESCE(${num(b.sort_order,"sort_order",0,1000)},sort_order),active=COALESCE(${typeof b.active==="boolean"?b.active:null},active) WHERE id=${id}::uuid AND school_id=${school(c)}::uuid RETURNING *`;if(!result.length)throw new ApiError(404,"NOT_FOUND","Subject not found.");return c.json({subject:result[0]});});
rc.delete("/rc/subjects/:id",requireRole("school"),async c=>{const result=await getDb(c.env)`UPDATE school_subjects SET active=FALSE WHERE id=${ownId(c.req.param("id"))}::uuid AND school_id=${school(c)}::uuid RETURNING id`;if(!result.length)throw new ApiError(404,"NOT_FOUND","Subject not found.");return c.json({deleted:true});});
rc.post("/rc/subjects/seed-defaults",requireRole("school"),async c=>{const level=validLevel((await readJson(c)).level),sid=school(c);for(const [i,[code,name,papers]] of subjectSeeds[level]!.entries())await getDb(c.env)`INSERT INTO school_subjects(school_id,code,name,level,papers,sort_order) VALUES(${sid}::uuid,${code||null},${name},${level},${papers},${i}) ON CONFLICT DO NOTHING`;return c.json({seeded:subjectSeeds[level]!.length});});
rc.get("/rc/grading",async c=>{const level=validLevel(c.req.query("level"));const grading=await getDb(c.env)`SELECT * FROM school_grading_systems WHERE school_id=${school(c)}::uuid AND level=${level} ORDER BY sort_order`;return c.json({grading});});
rc.post("/rc/grading",requireRole("school"),async c=>{const b=await readJson(c),sid=school(c),min=num(b.min_score,"min_score",0,100),max=num(b.max_score,"max_score",0,100);if(min===null||max===null||min>max)throw new ApiError(400,"VALIDATION_ERROR","Grade score range is invalid.");const result=await getDb(c.env)`INSERT INTO school_grading_systems(school_id,level,grade_code,min_score,max_score,descriptor,comment,sort_order) VALUES(${sid}::uuid,${validLevel(b.level)},${str(b.grade_code,"grade_code",40,true)},${min},${max},${str(b.descriptor,"descriptor",200)},${str(b.comment,"comment",500)},${num(b.sort_order,"sort_order",0,1000)||0}) RETURNING *`;return c.json({grading:result[0]},201);});
rc.patch("/rc/grading/:id",requireRole("school"),async c=>{const b=await readJson(c),id=ownId(c.req.param("id")),result=await getDb(c.env)`UPDATE school_grading_systems SET grade_code=COALESCE(${str(b.grade_code,"grade_code",40)},grade_code),min_score=COALESCE(${num(b.min_score,"min_score",0,100)},min_score),max_score=COALESCE(${num(b.max_score,"max_score",0,100)},max_score),descriptor=COALESCE(${str(b.descriptor,"descriptor",200)},descriptor),comment=COALESCE(${str(b.comment,"comment",500)},comment),sort_order=COALESCE(${num(b.sort_order,"sort_order",0,1000)},sort_order) WHERE id=${id}::uuid AND school_id=${school(c)}::uuid RETURNING *`;if(!result.length)throw new ApiError(404,"NOT_FOUND","Grading band not found.");return c.json({grading:result[0]});});
rc.delete("/rc/grading/:id",requireRole("school"),async c=>{const result=await getDb(c.env)`DELETE FROM school_grading_systems WHERE id=${ownId(c.req.param("id"))}::uuid AND school_id=${school(c)}::uuid RETURNING id`;if(!result.length)throw new ApiError(404,"NOT_FOUND","Grading band not found.");return c.json({deleted:true});});
rc.post("/rc/grading/seed-defaults",requireRole("school"),async c=>{const level=validLevel((await readJson(c)).level),sid=school(c);const sets:Record<string,[string,number,number,string][]>={nursery:[["Excellent",70,100,"Excellent"],["Commendable",60,69,"Commendable"],["Fairly Good",50,59,"Fairly Good"],["Work Harder",40,49,"Work Harder"],["Needs Support",0,39,"Needs Support"]],primary:[["A",80,100,"Very Good"],["B",70,79,"Good"],["C",60,69,"Fair"],["D",50,59,"Still Weak"],["E",0,49,"Needs Support"]],o_level:[["A",80,100,"Exceptional"],["B",70,79,"Outstanding"],["C",60,69,"Satisfactory"],["D",50,59,"Basic"],["E",0,49,"Needs Support"]],a_level:[["A",75,100,"Exceptional"],["B",65,74,"Outstanding"],["C",50,64,"Satisfactory"],["D",35,49,"Basic"],["E",0,34,"Fail"]]};for(const [i,[grade,min,max,descriptor]] of sets[level]!.entries())await getDb(c.env)`INSERT INTO school_grading_systems(school_id,level,grade_code,min_score,max_score,descriptor,sort_order) VALUES(${sid}::uuid,${level},${grade},${min},${max},${descriptor},${i}) ON CONFLICT(school_id,level,grade_code) DO NOTHING`;return c.json({seeded:sets[level]!.length});});
rc.get("/rc/nursery",async c=>{const sid=school(c);const [areas,activities]=await Promise.all([getDb(c.env)`SELECT * FROM nursery_learning_areas WHERE school_id=${sid}::uuid ORDER BY sort_order`,getDb(c.env)`SELECT * FROM nursery_activities WHERE school_id=${sid}::uuid ORDER BY sort_order`]);return c.json({areas,activities});});
rc.post("/rc/nursery/areas",requireRole("school"),async c=>{const b=await readJson(c),sid=school(c);const result=await getDb(c.env)`INSERT INTO nursery_learning_areas(school_id,code,name,max_score,sort_order) VALUES(${sid}::uuid,${str(b.code,"code",40,true)},${str(b.name,"name",120,true)},${num(b.max_score,"max_score",1,1000)||100},${num(b.sort_order,"sort_order",0,1000)||0}) RETURNING *`;return c.json({area:result[0]},201);});
rc.post("/rc/nursery/activities",requireRole("school"),async c=>{const b=await readJson(c),sid=school(c);const result=await getDb(c.env)`INSERT INTO nursery_activities(school_id,code,name,sort_order) VALUES(${sid}::uuid,${str(b.code,"code",40,true)},${str(b.name,"name",120,true)},${num(b.sort_order,"sort_order",0,1000)||0}) RETURNING *`;return c.json({activity:result[0]},201);});
rc.post("/rc/nursery/seed-defaults",requireRole("school"),async c=>{const sid=school(c);const areas=[["LANG","Language & Literacy"],["MATH","Mathematical Concepts"],["ENV","Environmental Awareness"],["CRE","Creative Development"],["PHY","Physical Development"]];const activities=[["SOC","Social Interaction"],["MOT","Motor Skills"],["SELF","Self-care"],["MUS","Music & Movement"]];for(const [i,[code,name]] of areas.entries())await getDb(c.env)`INSERT INTO nursery_learning_areas(school_id,code,name,sort_order) VALUES(${sid}::uuid,${code},${name},${i}) ON CONFLICT(school_id,code) DO NOTHING`;for(const [i,[code,name]] of activities.entries())await getDb(c.env)`INSERT INTO nursery_activities(school_id,code,name,sort_order) VALUES(${sid}::uuid,${code},${name},${i}) ON CONFLICT(school_id,code) DO NOTHING`;return c.json({areas:areas.length,activities:activities.length});});
rc.get("/rc/stats",async c=>{const sid=school(c);const [classes,learners,subjects,grading,schoolRow]=await Promise.all([getDb(c.env)`SELECT COUNT(*)::int n FROM classes WHERE school_id=${sid}::uuid AND active`,getDb(c.env)`SELECT COUNT(*)::int n FROM learners WHERE school_id=${sid}::uuid AND active`,getDb(c.env)`SELECT COUNT(*)::int n FROM school_subjects WHERE school_id=${sid}::uuid AND active`,getDb(c.env)`SELECT COUNT(*)::int n FROM school_grading_systems WHERE school_id=${sid}::uuid`,getDb(c.env)`SELECT report_theme FROM schools WHERE id=${sid}::uuid`]);return c.json({classes:classes[0]?.n||0,learners:learners[0]?.n||0,subjects:subjects[0]?.n||0,grading_ready:(grading[0]?.n||0)>0,theme:schoolRow[0]?.report_theme||"blue"});});

export default rc;
