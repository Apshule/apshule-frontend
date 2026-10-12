import { Hono } from "hono";
import { ApiError, getDb } from "../db.js";
import { authMiddleware, requireRole } from "../auth.js";
import { linkedSchoolId } from "../ncdc-helpers.js";
import { readJson } from "../http.js";
import type { AppEnv } from "../types.js";
import { calculateReportMark } from "../report-marks-domain.js";

const rm = new Hono<AppEnv>();
const staff = [authMiddleware, requireRole("school", "teacher")] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const id = (v: unknown) => { const s=String(v||""); if(!uuid.test(s)) throw new ApiError(400,"VALIDATION_ERROR","Invalid record id."); return s; };
const schoolId = (c:any) => { const s=linkedSchoolId(c.get("user")); if(!s) throw new ApiError(403,"SCHOOL_REQUIRED","Your account is not linked to a school."); return s; };
const text = (v:unknown,max=80) => typeof v==="string"&&v.trim()&&v.trim().length<=max?v.trim():null;
const integer = (v:unknown,min:number,max:number) => { const n=Number(v); if(!Number.isInteger(n)||n<min||n>max) throw new ApiError(400,"VALIDATION_ERROR","Invalid number."); return n; };
const score = (v:unknown) => { if(v===null||v==="") return null; const n=Number(v); if(!Number.isFinite(n)||n<0||n>100) throw new ApiError(400,"VALIDATION_ERROR","Marks must be between 0 and 100."); return n; };
const currentUser=(c:any)=>c.get("user");
const termYear=(c:any)=>({term:text(c.req.query("term"),40),year:integer(c.req.query("year"),2000,2200)});
rm.use("*",...staff);
rm.get("/rm/teachers",requireRole("school"),async c=>{
  const rows=await getDb(c.env)`SELECT id,name,email FROM users WHERE school_id=${schoolId(c)}::uuid AND role='teacher' ORDER BY name`;
  return c.json({teachers:rows});
});

rm.get("/rm/assignments",requireRole("school"),async c=>{
  const sid=schoolId(c),classId=c.req.query("class_id"),teacherId=c.req.query("teacher_id");
  const rows=await getDb(c.env)`SELECT ta.id,ta.teacher_id,u.name teacher_name,ta.class_id,cl.name class_name,
    ta.subject_id,ss.code subject_code,ss.name subject_name,ta.active,ta.assigned_at
    FROM teacher_assignments ta JOIN users u ON u.id=ta.teacher_id JOIN classes cl ON cl.id=ta.class_id
    JOIN school_subjects ss ON ss.id=ta.subject_id
    WHERE ta.school_id=${sid}::uuid AND ta.active
      AND (${classId||""}='' OR ta.class_id::text=${classId||""})
      AND (${teacherId||""}='' OR ta.teacher_id::text=${teacherId||""})
    ORDER BY cl.name,ss.name,u.name`;
  return c.json({assignments:rows});
});
rm.post("/rm/assignments",requireRole("school"),async c=>{
  const b=await readJson(c),sid=schoolId(c),teacher=id(b.teacher_id),cl=id(b.class_id),sub=id(b.subject_id);
  const target=await getDb(c.env)`SELECT c.level FROM classes c JOIN school_subjects ss ON ss.school_id=c.school_id
    WHERE c.id=${cl}::uuid AND c.school_id=${sid}::uuid AND c.active
      AND ss.id=${sub}::uuid AND ss.active AND ss.level=c.level`;
  const teacherRow=await getDb(c.env)`SELECT id FROM users WHERE id=${teacher}::uuid AND school_id=${sid}::uuid AND role='teacher'`;
  if(!target.length||!teacherRow.length)throw new ApiError(400,"INVALID_ASSIGNMENT","Choose a teacher, class and subject from this school and class level.");
  const rows=await getDb(c.env)`INSERT INTO teacher_assignments(school_id,teacher_id,class_id,subject_id,active,assigned_by)
    VALUES(${sid}::uuid,${teacher}::uuid,${cl}::uuid,${sub}::uuid,TRUE,${currentUser(c).id}::uuid)
    ON CONFLICT(school_id,teacher_id,class_id,subject_id) DO UPDATE SET active=TRUE,assigned_at=NOW(),assigned_by=EXCLUDED.assigned_by
    RETURNING *`;
  return c.json({assignment:rows[0]},201);
});
rm.delete("/rm/assignments/:id",requireRole("school"),async c=>{
  const rows=await getDb(c.env)`UPDATE teacher_assignments SET active=FALSE WHERE id=${id(c.req.param("id"))}::uuid AND school_id=${schoolId(c)}::uuid AND active RETURNING id`;
  if(!rows.length)throw new ApiError(404,"NOT_FOUND","Assignment not found.");
  return c.json({revoked:true});
});
rm.get("/rm/my-classes",requireRole("teacher"),async c=>{
  const sid=schoolId(c),uid=currentUser(c).id;
  const rows=await getDb(c.env)`SELECT c.id class_id,c.name class_name,c.level,
    json_agg(json_build_object('id',s.id,'code',s.code,'name',s.name,'papers',s.papers) ORDER BY s.name) subjects
    FROM teacher_assignments a JOIN classes c ON c.id=a.class_id JOIN school_subjects s ON s.id=a.subject_id
    WHERE a.school_id=${sid}::uuid AND a.teacher_id=${uid}::uuid AND a.active AND c.active AND s.active
    GROUP BY c.id,c.name,c.level ORDER BY c.name`;
  return c.json({classes:rows});
});
rm.get("/rm/my-students",requireRole("teacher"),async c=>{
  const sid=schoolId(c),uid=currentUser(c).id,cl=c.req.query("class_id")||"";
  const rows=await getDb(c.env)`SELECT DISTINCT l.id,l.reg_no,l.full_name,l.photo_base64,c.name class_name,
    ROUND(AVG(rm.pct100),1) current_avg
    FROM teacher_assignments ta JOIN classes c ON c.id=ta.class_id JOIN learners l ON l.class_id=c.id AND l.school_id=c.school_id
    LEFT JOIN report_cards rc ON rc.learner_record_id=l.id
    LEFT JOIN report_marks rm ON rm.report_card_id=rc.id AND rm.subject_id=ta.subject_id
    WHERE ta.school_id=${sid}::uuid AND ta.teacher_id=${uid}::uuid AND ta.active AND c.active AND l.active
      AND (${cl}='' OR c.id::text=${cl})
    GROUP BY l.id,l.reg_no,l.full_name,l.photo_base64,c.name ORDER BY c.name,l.full_name`;
  return c.json({students:rows});
});
rm.get("/rm/class/:class_id/subjects",async c=>{
  const sid=schoolId(c),cl=id(c.req.param("class_id")),u=currentUser(c),teacher=u.role==="teacher";
  const rows=await getDb(c.env)`SELECT s.id,s.code,s.name,s.papers,u.id teacher_id,u.name teacher_name
    FROM classes c JOIN teacher_assignments a ON a.class_id=c.id AND a.active
    JOIN school_subjects s ON s.id=a.subject_id AND s.active JOIN users u ON u.id=a.teacher_id
    WHERE c.id=${cl}::uuid AND c.school_id=${sid}::uuid AND c.active
      AND (${teacher?u.id:""}='' OR a.teacher_id::text=${teacher?u.id:""})
    ORDER BY s.name`;
  return c.json({subjects:rows});
});

rm.post("/rm/cards/bulk-create",requireRole("school"),async c=>{
  const b=await readJson(c),sid=schoolId(c),cl=id(b.class_id),term=text(b.term,40),year=integer(b.year,2000,2200);
  if(!term)throw new ApiError(400,"VALIDATION_ERROR","Term is required.");
  const sql=getDb(c.env);await sql`INSERT INTO school_report_card_access(school_id) VALUES(${sid}::uuid) ON CONFLICT(school_id) DO NOTHING`;
  const a=await sql`SELECT status,trial_used,paid_until,waived_until FROM school_report_card_access WHERE school_id=${sid}::uuid`;
  const allowed=(a[0]?.status==="paid"&&a[0]?.paid_until&&new Date(a[0].paid_until)>new Date())||(a[0]?.status==="waived"&&a[0]?.waived_until&&new Date(a[0].waived_until)>new Date());
  const prior=await sql`SELECT COUNT(*)::int n FROM report_cards WHERE school_id=${sid}::uuid`;
  const trial=Boolean(!allowed&&a[0]?.status==="trial"&&a[0]?.trial_used&&Number(prior[0]?.n||0)===0);
  if(!allowed&&!trial)throw new ApiError(402,"REPORT_ACCESS_REQUIRED","Report card access is not active.");
  let learners=await sql`SELECT l.id learner_record_id,l.user_id,l.full_name,c.name class_name,c.level
    FROM learners l JOIN classes c ON c.id=l.class_id WHERE l.school_id=${sid}::uuid AND l.class_id=${cl}::uuid AND l.active AND c.active ORDER BY l.full_name`;
  if(trial)learners=learners.slice(0,1);
  let created=0,skipped=0;const cards:any[]=[];
  for(const l of learners as any[]){
    const rows=await getDb(c.env)`INSERT INTO report_cards(template_level,learner_id,learner_record_id,school_id,class_id,class_name,term,year,status,created_by)
      VALUES(${l.level},${l.user_id}::uuid,${l.learner_record_id}::uuid,${sid}::uuid,${cl}::uuid,${l.class_name},${term},${year},'draft',${currentUser(c).id}::uuid)
      ON CONFLICT DO NOTHING RETURNING id,learner_record_id`;
    if(!rows.length){skipped++;continue;} created++;
    cards.push({id:rows[0]!.id,learner_id:l.learner_record_id,full_name:l.full_name,class_name:l.class_name});
    await getDb(c.env)`INSERT INTO report_marks(report_card_id,subject_id,subject_code,subject_name)
      SELECT ${rows[0]!.id}::uuid,s.id,s.code,s.name FROM school_subjects s WHERE s.school_id=${sid}::uuid AND s.level=${l.level} AND s.active
      ON CONFLICT DO NOTHING`;
  }
  return c.json({created,skipped,cards});
});
rm.get("/rm/cards",async c=>{
  const sid=schoolId(c),cl=c.req.query("class_id"),term=c.req.query("term"),year=c.req.query("year");
  const rows=await getDb(c.env)`SELECT rc.id,rc.learner_record_id learner_id,l.reg_no,l.full_name,rc.status,rc.position_in_class,
    rc.class_id,rc.term,rc.year,COALESCE(AVG(rm.pct100),0) avg_total,
    CASE WHEN COUNT(rm.grade)=0 THEN NULL ELSE MODE() WITHIN GROUP (ORDER BY rm.grade) END grade
    FROM report_cards rc JOIN learners l ON l.id=rc.learner_record_id LEFT JOIN report_marks rm ON rm.report_card_id=rc.id
    WHERE rc.school_id=${sid}::uuid AND rc.learner_record_id IS NOT NULL
      AND (${cl||""}='' OR rc.class_id::text=${cl||""}) AND (${term||""}='' OR rc.term=${term||""})
      AND (${year||""}='' OR rc.year::text=${year||""})
      AND (${currentUser(c).role==="school"} OR EXISTS(SELECT 1 FROM teacher_assignments ta WHERE ta.teacher_id=${currentUser(c).id}::uuid AND ta.class_id=rc.class_id AND ta.active))
    GROUP BY rc.id,l.reg_no,l.full_name ORDER BY l.full_name`;
  return c.json({cards:rows});
});
rm.get("/rm/cards/:id",async c=>{
  const sid=schoolId(c),cardId=id(c.req.param("id"));
  const cards=await getDb(c.env)`SELECT rc.*,l.id learner_record_id_actual,l.reg_no,l.full_name,l.photo_base64,c.name class_name,c.level
    FROM report_cards rc JOIN learners l ON l.id=rc.learner_record_id LEFT JOIN classes c ON c.id=rc.class_id
    WHERE rc.id=${cardId}::uuid AND rc.school_id=${sid}::uuid
      AND (${currentUser(c).role==="school"} OR EXISTS(SELECT 1 FROM teacher_assignments ta WHERE ta.teacher_id=${currentUser(c).id}::uuid AND ta.class_id=rc.class_id AND ta.active))`;
  if(!cards.length)throw new ApiError(404,"NOT_FOUND","Report card not found.");
  const marks=await getDb(c.env)`SELECT rm.*,s.name subject_name,s.code FROM report_marks rm
    LEFT JOIN school_subjects s ON s.id=rm.subject_id WHERE rm.report_card_id=${cardId}::uuid ORDER BY s.sort_order,s.name`;
  return c.json({card:cards[0],marks});
});
rm.post("/rm/cards/:id/marks",async c=>{
  const b=await readJson(c),sid=schoolId(c),u=currentUser(c),cardId=id(c.req.param("id"));
  if(!Array.isArray(b.marks)||b.marks.length>80)throw new ApiError(400,"VALIDATION_ERROR","Marks must be an array of at most 80 subjects.");
  const cards=await getDb(c.env)`SELECT id,class_id,learner_record_id,template_level FROM report_cards WHERE id=${cardId}::uuid AND school_id=${sid}::uuid`;
  if(!cards.length)throw new ApiError(404,"NOT_FOUND","Report card not found.");
  for(const m of b.marks){
    const subject=id(m.subject_id),a1=score(m.a1),a2=score(m.a2),a3=score(m.a3),eot=score(m.eot),initials=text(m.teacher_initials,12);
    if([a1,a2,a3,eot].some(v=>v===null))throw new ApiError(400,"VALIDATION_ERROR","Enter all three assessment marks and the end-of-term mark.");
    const allowed=await getDb(c.env)`SELECT s.id,s.name,s.code FROM school_subjects s WHERE s.id=${subject}::uuid AND s.school_id=${sid}::uuid AND s.level=${cards[0]!.template_level} AND s.active
      AND (${u.role==="school"} OR EXISTS(SELECT 1 FROM teacher_assignments a WHERE a.teacher_id=${u.id}::uuid AND a.class_id=${cards[0]!.class_id}::uuid AND a.subject_id=s.id AND a.active))`;
    if(!allowed.length)throw new ApiError(403,"FORBIDDEN","You are not assigned to this subject.");
    const {avg,pct20,pct80,pct100,identifier,grade}=calculateReportMark({a1:a1!,a2:a2!,a3:a3!,eot:eot!});
    const grading=await getDb(c.env)`SELECT descriptor,comment FROM school_grading_systems WHERE school_id=${sid}::uuid AND level=${cards[0]!.template_level} AND grade_code=${grade} ORDER BY sort_order LIMIT 1`;
    await getDb(c.env)`INSERT INTO report_marks(report_card_id,subject_id,subject_code,subject_name,a1,a2,a3,avg,pct_20,pct20,eot,pct_80,pct80,pct_100,pct100,identifier,grade,descriptor,remarks,teacher_initials,teacher_id,entered_by,entered_at)
      VALUES(${cardId}::uuid,${subject}::uuid,${allowed[0]!.code},${allowed[0]!.name},${a1},${a2},${a3},${avg},${pct20},${pct20},${eot},${pct80},${pct80},${pct100},${pct100},${identifier},${grade},${grading[0]?.descriptor||null},${grading[0]?.comment||null},${initials},${u.id}::uuid,${u.id}::uuid,NOW())
      ON CONFLICT(report_card_id,subject_id) WHERE subject_id IS NOT NULL DO UPDATE SET
        a1=EXCLUDED.a1,a2=EXCLUDED.a2,a3=EXCLUDED.a3,avg=EXCLUDED.avg,pct_20=EXCLUDED.pct_20,pct20=EXCLUDED.pct20,
        eot=EXCLUDED.eot,pct_80=EXCLUDED.pct_80,pct80=EXCLUDED.pct80,pct_100=EXCLUDED.pct_100,pct100=EXCLUDED.pct100,
        identifier=EXCLUDED.identifier,grade=EXCLUDED.grade,descriptor=EXCLUDED.descriptor,remarks=EXCLUDED.remarks,
        teacher_initials=EXCLUDED.teacher_initials,teacher_id=EXCLUDED.teacher_id,entered_by=EXCLUDED.entered_by,entered_at=NOW()`;
  }
  const rows=await getDb(c.env)`SELECT * FROM report_marks WHERE report_card_id=${cardId}::uuid`;
  return c.json({card_id:cardId,marks:rows});
});
rm.get("/rm/class/:class_id/marks",async c=>{
  const sid=schoolId(c),cl=id(c.req.param("class_id")),{term,year}=termYear(c),u=currentUser(c);
  const subjects=await getDb(c.env)`SELECT s.id,s.code,s.name,s.papers FROM school_subjects s JOIN classes c ON c.school_id=s.school_id AND c.level=s.level
    WHERE c.id=${cl}::uuid AND c.school_id=${sid}::uuid AND s.active
      AND (${u.role==="school"} OR EXISTS(SELECT 1 FROM teacher_assignments a WHERE a.teacher_id=${u.id}::uuid AND a.class_id=c.id AND a.subject_id=s.id AND a.active))
    ORDER BY s.sort_order,s.name`;
  const learners=await getDb(c.env)`SELECT l.id,l.reg_no,l.full_name,l.photo_base64,rc.id report_card_id
    FROM learners l LEFT JOIN report_cards rc ON rc.learner_record_id=l.id AND rc.term=${term} AND rc.year=${year}
    WHERE l.school_id=${sid}::uuid AND l.class_id=${cl}::uuid AND l.active ORDER BY l.full_name`;
  const marks=await getDb(c.env)`SELECT rm.report_card_id,rm.subject_id,rm.a1,rm.a2,rm.a3,rm.avg,COALESCE(rm.pct20,rm.pct_20) pct20,rm.eot,COALESCE(rm.pct80,rm.pct_80) pct80,COALESCE(rm.pct100,rm.pct_100) pct100,rm.identifier,rm.grade,rm.teacher_initials
    FROM report_marks rm JOIN report_cards rc ON rc.id=rm.report_card_id WHERE rc.class_id=${cl}::uuid AND rc.term=${term} AND rc.year=${year}`;
  const byCard=new Map((learners as any[]).map(l=>[l.report_card_id,l]));
  for(const m of marks as any[]){const learner=byCard.get(m.report_card_id) as any;if(learner)(learner.marks||={})[m.subject_id]=m;}
  return c.json({learners,subjects});
});
rm.post("/rm/class/:class_id/positions",async c=>{
  const b=await readJson(c),sid=schoolId(c),cl=id(c.req.param("class_id")),term=text(b.term,40),year=integer(b.year,2000,2200),u=currentUser(c);
  const allowed=await getDb(c.env)`SELECT id FROM classes WHERE id=${cl}::uuid AND school_id=${sid}::uuid AND active`;
  if(!allowed.length)throw new ApiError(404,"NOT_FOUND","Class not found.");
  if(u.role==="teacher"){const assignments=await getDb(c.env)`SELECT 1 FROM teacher_assignments WHERE teacher_id=${u.id}::uuid AND class_id=${cl}::uuid AND active LIMIT 1`;if(!assignments.length)throw new ApiError(403,"FORBIDDEN","You are not assigned to this class.");}
  const rows=await getDb(c.env)`WITH totals AS (SELECT rc.id,SUM(COALESCE(rm.pct100,rm.pct_100,0)) total
    FROM report_cards rc LEFT JOIN report_marks rm ON rm.report_card_id=rc.id
    WHERE rc.school_id=${sid}::uuid AND rc.class_id=${cl}::uuid AND rc.term=${term} AND rc.year=${year}
    GROUP BY rc.id), ranked AS (SELECT id,ROW_NUMBER() OVER(ORDER BY total DESC,id)::int pos,COUNT(*) OVER()::int total_count FROM totals)
    UPDATE report_cards rc SET position_in_class=r.pos,out_of_class=r.total_count FROM ranked r WHERE rc.id=r.id RETURNING rc.id`;
  return c.json({updated:rows.length});
});
rm.get("/rm/teacher/dashboard",requireRole("teacher"),async c=>{
  const sid=schoolId(c),uid=currentUser(c).id;
  const classes=await getDb(c.env)`SELECT c.id class_id,c.name class_name,(c.class_teacher_id=${uid}::uuid) is_class_teacher,
    json_agg(DISTINCT jsonb_build_object('id',s.id,'name',s.name,'code',s.code)) subjects,
    COUNT(DISTINCT rc.id) FILTER(WHERE NOT EXISTS(SELECT 1 FROM report_marks rm WHERE rm.report_card_id=rc.id AND rm.entered_by=${uid}::uuid))::int pending_cards,
    COUNT(DISTINCT rc.id) FILTER(WHERE EXISTS(SELECT 1 FROM report_marks rm WHERE rm.report_card_id=rc.id AND rm.entered_by=${uid}::uuid))::int completed_cards
    FROM teacher_assignments a JOIN classes c ON c.id=a.class_id JOIN school_subjects s ON s.id=a.subject_id
    LEFT JOIN learners l ON l.class_id=c.id AND l.active LEFT JOIN report_cards rc ON rc.learner_record_id=l.id
    WHERE a.school_id=${sid}::uuid AND a.teacher_id=${uid}::uuid AND a.active AND c.active
    GROUP BY c.id,c.name,c.class_teacher_id ORDER BY c.name`;
  return c.json({classes});
});
rm.get("/rm/school/dashboard",requireRole("school"),async c=>{
  const sid=schoolId(c),r=await getDb(c.env)`SELECT
    (SELECT COUNT(*)::int FROM classes WHERE school_id=${sid}::uuid AND active) total_classes,
    (SELECT COUNT(*)::int FROM learners WHERE school_id=${sid}::uuid AND active) total_learners,
    (SELECT COUNT(*)::int FROM school_subjects WHERE school_id=${sid}::uuid AND active) total_subjects,
    (SELECT COUNT(DISTINCT teacher_id)::int FROM teacher_assignments WHERE school_id=${sid}::uuid AND active) teachers_assigned,
    (SELECT COUNT(*)::int FROM report_cards WHERE school_id=${sid}::uuid) cards_created,
    (SELECT COUNT(*)::int FROM report_cards WHERE school_id=${sid}::uuid AND status='published') cards_published`;
  return c.json(r[0]||{});
});
export default rm;
