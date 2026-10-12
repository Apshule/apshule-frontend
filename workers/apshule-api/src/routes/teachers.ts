import { Hono } from "hono";
import { ApiError, getDb, isUniqueViolation } from "../db.js";
import { authMiddleware, hashPassword } from "../auth.js";
import { readJson } from "../http.js";
import { linkedSchoolId } from "../ncdc-helpers.js";
import { sendEmail } from "../email.js";
import type { AppEnv } from "../types.js";

const teachers = new Hono<AppEnv>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const levels = new Set(["nursery","primary","o_level","a_level"]);
const codeChars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
const password = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const chars = [...bytes].map(b => codeChars[b % codeChars.length]);
  chars[0] = "A"; chars[1] = "b"; chars[2] = "7"; chars[3] = "!";
  for (let i=chars.length-1;i>0;i--) { const j=crypto.getRandomValues(new Uint8Array(1))[0]!%(i+1); [chars[i],chars[j]]=[chars[j]!,chars[i]!]; }
  return chars.join("");
};
const clean = (v: unknown, max: number) => typeof v==="string" && v.trim() && v.trim().length<=max ? v.trim() : null;
const school = (c: any) => { const sid=linkedSchoolId(c.get("user")); if(!sid) throw new ApiError(403,"SCHOOL_REQUIRED","Your account is not linked to a school."); return sid; };
const own = (c:any,id:string) => getDb(c.env)`SELECT id FROM users WHERE id=${id}::uuid AND school_id=${school(c)}::uuid AND role='teacher' AND sector='education'`;
function arrays(body:Record<string,unknown>) {
  const classes=Array.isArray(body.assigned_classes)?body.assigned_classes:[], subjects=Array.isArray(body.subjects_taught)?body.subjects_taught:[];
  if(classes.length>100||subjects.length>100||[...classes,...subjects].some(x=>typeof x!=="string"||!uuid.test(x))) throw new ApiError(400,"VALIDATION_ERROR","Invalid class or subject selections.");
  return {classes:classes as string[],subjects:subjects as string[]};
}
async function assignments(sql:ReturnType<typeof getDb>,schoolId:string,teacherId:string,classIds:string[],subjectIds:string[],actorId:string) {
  if(!classIds.length||!subjectIds.length)return;
  const valid=await sql`SELECT c.id class_id,s.id subject_id FROM classes c JOIN school_subjects s ON s.school_id=c.school_id AND s.level=c.level
    WHERE c.school_id=${schoolId}::uuid AND c.active AND c.id=ANY(${classIds}::uuid[]) AND s.active AND s.id=ANY(${subjectIds}::uuid[])`;
  if(!valid.length) throw new ApiError(400,"INVALID_ASSIGNMENT","Selected classes and subjects do not have a matching school level.");
  for(const row of valid) await sql`INSERT INTO teacher_assignments(school_id,teacher_id,class_id,subject_id,active,assigned_by)
    VALUES(${schoolId}::uuid,${teacherId}::uuid,${row.class_id}::uuid,${row.subject_id}::uuid,TRUE,${actorId}::uuid)
    ON CONFLICT(school_id,teacher_id,class_id,subject_id) DO UPDATE SET active=TRUE,assigned_at=NOW(),assigned_by=EXCLUDED.assigned_by`;
}
async function welcome(c:any,email:string,name:string,plain:string,code:string) {
  const safe=(s:string)=>s.replace(/[&<>"']/g,x=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[x]!));
  const link=c.env.APP_URL||"https://appshule.com";
  c.executionCtx.waitUntil(sendEmail(c.env,{to:email,subject:"Your APSHULE Teacher Account",html:`<h1>Welcome to APSHULE</h1><p>Hello ${safe(name)}, your teacher account is ready.</p><p>Email: ${safe(email)}<br>Temporary password: ${safe(plain)}<br>School code: ${safe(code)}</p><p>Please change your password at first sign-in.</p><p><a href="${safe(link)}">Sign in to APSHULE</a></p>`}));
}
async function createTeacher(c:any,input:unknown) {
  if(!input||typeof input!=="object"||Array.isArray(input))throw new ApiError(400,"VALIDATION_ERROR","Teacher details are required.");
  const b=input as Record<string,unknown>,name=clean(b.name,120),email=clean(b.email,254)?.toLowerCase(),phone=clean(b.phone,40)??null;
  if(!name||!email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))throw new ApiError(400,"VALIDATION_ERROR","Name and valid email are required.");
  const sql=getDb(c.env),sid=school(c),actor=c.get("user"),picked=arrays(b);
  const schoolRows=await sql`SELECT short_code FROM schools WHERE id=${sid}::uuid`;
  if(!schoolRows[0])throw new ApiError(404,"SCHOOL_NOT_FOUND","School not found.");
  let educationLevel=clean(b.education_level,20);
  if(educationLevel&&!levels.has(educationLevel))throw new ApiError(400,"VALIDATION_ERROR","Invalid education level.");
  if(picked.classes.length){const rows=await sql`SELECT DISTINCT level FROM classes WHERE school_id=${sid}::uuid AND id=ANY(${picked.classes}::uuid[]) AND active`;if(!rows.length)throw new ApiError(400,"INVALID_CLASS","Choose active classes from this school.");if(rows.length===1)educationLevel=educationLevel||String(rows[0]!.level);}
  if(picked.classes.length&&picked.subjects.length){const valid=await sql`SELECT count(*)::int total FROM classes c JOIN school_subjects s ON s.school_id=c.school_id AND s.level=c.level WHERE c.school_id=${sid}::uuid AND c.active AND c.id=ANY(${picked.classes}::uuid[]) AND s.active AND s.id=ANY(${picked.subjects}::uuid[])`;if(!Number(valid[0]?.total))throw new ApiError(400,"INVALID_ASSIGNMENT","Selected classes and subjects do not match.");}
  const plain=clean(b.password,128)||password();
  if(plain.length<8)throw new ApiError(400,"VALIDATION_ERROR","Password must be at least 8 characters.");
  try{
    const rows=await sql`INSERT INTO users(name,email,phone,password_hash,role,sector,school_id,education_level,subjects_taught,assigned_classes,must_change_password,is_active,teacher_type)
      VALUES(${name},${email},${phone},${await hashPassword(plain)},'teacher','education',${sid}::uuid,${educationLevel},${picked.subjects}::text[],${picked.classes}::text[],TRUE,TRUE,'school')
      RETURNING id,email,name`;
    await assignments(sql,sid,String(rows[0]!.id),picked.classes,picked.subjects,String(actor.id));
    welcome(c,email,name,plain,String(schoolRows[0]!.short_code||""));
    return {ok:true,id:rows[0]!.id,email,initial_password:plain,school_code:schoolRows[0]!.short_code};
  }catch(error){if(isUniqueViolation(error))throw new ApiError(409,"EMAIL_IN_USE","An account with this email already exists.");throw error;}
}
teachers.use("*",authMiddleware,async(c,next)=>{if(c.get("user").role!=="school")throw new ApiError(403,"FORBIDDEN","Only school admins can manage teachers.");await next();});
teachers.get("/teachers/template",c=>{c.header("Content-Type","text/csv; charset=utf-8");c.header("Content-Disposition",'attachment; filename="teacher-import-template.csv"');return c.body("name,email,phone,password,education_level,subjects_taught,assigned_classes\n");});
teachers.get("/teachers",async c=>{
  const sid=school(c);
  const rows=await getDb(c.env)`SELECT u.id,u.name,u.email,u.phone,u.is_active active,COUNT(DISTINCT ta.subject_id)::int subjects_count,COUNT(DISTINCT ta.class_id)::int classes_count
    FROM users u LEFT JOIN teacher_assignments ta ON ta.teacher_id=u.id AND ta.active
    WHERE u.school_id=${sid}::uuid AND u.role='teacher' AND u.sector='education'
    GROUP BY u.id ORDER BY u.name`;
  return c.json({teachers:rows});
});
teachers.post("/teachers",async c=>{const result=await createTeacher(c,await readJson(c));c.header("Cache-Control","no-store");return c.json(result,201);});
teachers.post("/teachers/bulk",async c=>{
  const b=await readJson(c);if(!Array.isArray(b.teachers)||!b.teachers.length||b.teachers.length>200)throw new ApiError(400,"VALIDATION_ERROR","Provide 1 to 200 teacher rows.");
  const results=[];for(const row of b.teachers){try{results.push(await createTeacher(c,row));}catch(e){results.push({ok:false,email:(row as any)?.email||null,error:e instanceof Error?e.message:"Import failed"});}}
  c.header("Cache-Control","no-store");return c.json({created:results.filter(x=>x.ok).length,results},201);
});
teachers.patch("/teachers/:id",async c=>{
  const tid=String(c.req.param("id"));if(!uuid.test(tid)||!(await own(c,tid)).length)throw new ApiError(404,"TEACHER_NOT_FOUND","Teacher not found.");
  const b=await readJson(c),name=clean(b.name,120),phone=clean(b.phone,40)??null,education=clean(b.education_level,20),email=clean(b.email,254)?.toLowerCase()??null;
  if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))throw new ApiError(400,"VALIDATION_ERROR","Enter a valid email address.");
  if(education&&!levels.has(education))throw new ApiError(400,"VALIDATION_ERROR","Invalid education level.");
  const picked=("subjects_taught" in b||"assigned_classes" in b)?arrays(b):null,sql=getDb(c.env);
  if(picked){
    await sql`UPDATE users SET name=COALESCE(${name},name),email=COALESCE(${email},email),phone=${phone},education_level=COALESCE(${education},education_level),subjects_taught=${picked.subjects}::text[],assigned_classes=${picked.classes}::text[],updated_at=NOW() WHERE id=${tid}::uuid AND school_id=${school(c)}::uuid`;
    await sql`UPDATE teacher_assignments SET active=FALSE WHERE teacher_id=${tid}::uuid AND school_id=${school(c)}::uuid`;
    await assignments(sql,school(c),tid,picked.classes,picked.subjects,String(c.get("user").id));
  }else{
    await sql`UPDATE users SET name=COALESCE(${name},name),email=COALESCE(${email},email),phone=${phone},education_level=COALESCE(${education},education_level),updated_at=NOW() WHERE id=${tid}::uuid AND school_id=${school(c)}::uuid`;
  }
  return c.json({ok:true,id:tid});
});
teachers.post("/teachers/:id/reset-password",async c=>{
  const tid=String(c.req.param("id"));if(!uuid.test(tid))throw new ApiError(404,"TEACHER_NOT_FOUND","Teacher not found.");
  const sql=getDb(c.env),found=await sql`SELECT id,email,name FROM users WHERE id=${tid}::uuid AND school_id=${school(c)}::uuid AND role='teacher'`;
  if(!found[0])throw new ApiError(404,"TEACHER_NOT_FOUND","Teacher not found.");
  const next=password();await sql`UPDATE users SET password_hash=${await hashPassword(next)},must_change_password=TRUE,session_version=COALESCE(session_version,0)+1 WHERE id=${tid}::uuid`;
  const sc=await sql`SELECT short_code FROM schools WHERE id=${school(c)}::uuid`;welcome(c,String(found[0]!.email),String(found[0]!.name),next,String(sc[0]?.short_code||""));
  c.header("Cache-Control","no-store");return c.json({new_password:next,school_code:sc[0]?.short_code});
});
teachers.post("/teachers/:id/resend-welcome",async c=>{
  const tid=String(c.req.param("id")),sql=getDb(c.env);const row=await sql`SELECT id FROM users WHERE id=${tid}::uuid AND school_id=${school(c)}::uuid AND role='teacher'`;
  if(!row[0])throw new ApiError(404,"TEACHER_NOT_FOUND","Teacher not found.");
  const record=await sql`SELECT name,email FROM users WHERE id=${tid}::uuid`,sc=await sql`SELECT short_code FROM schools WHERE id=${school(c)}::uuid`,next=password();
  await sql`UPDATE users SET password_hash=${await hashPassword(next)},must_change_password=TRUE,session_version=COALESCE(session_version,0)+1 WHERE id=${tid}::uuid`;
  welcome(c,String(record[0]!.email),String(record[0]!.name),next,String(sc[0]?.short_code||""));
  c.header("Cache-Control","no-store");return c.json({new_password:next,school_code:sc[0]?.short_code});
});
teachers.delete("/teachers/:id",async c=>{
  const tid=String(c.req.param("id"));if(!uuid.test(tid))throw new ApiError(404,"TEACHER_NOT_FOUND","Teacher not found.");
  const rows=await getDb(c.env)`UPDATE users SET is_active=FALSE,session_version=COALESCE(session_version,0)+1,updated_at=NOW()
    WHERE id=${tid}::uuid AND school_id=${school(c)}::uuid AND role='teacher' RETURNING id`;
  if(!rows.length)throw new ApiError(404,"TEACHER_NOT_FOUND","Teacher not found.");
  await getDb(c.env)`UPDATE teacher_assignments SET active=FALSE WHERE teacher_id=${tid}::uuid AND school_id=${school(c)}::uuid`;
  return c.json({ok:true,deactivated:true});
});
export default teachers;
