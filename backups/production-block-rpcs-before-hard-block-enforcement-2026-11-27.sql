-- Production definitions before hard-block enforcement, captured 2026-11-27
CREATE OR REPLACE FUNCTION public.smpn4_save_exam_answer_progress(p_session_id uuid, p_student_id text, p_answers_pg jsonb, p_answers_essay jsonb, p_revision integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_session public.smpn4_exam_runtime_sessions%rowtype; v_progress public.smpn4_exam_answer_progress%rowtype;
begin
 if p_session_id is null or coalesce(p_student_id,'')='' or p_revision is null or p_revision<1
    or jsonb_typeof(p_answers_pg)<>'array' or jsonb_typeof(p_answers_essay)<>'array' then
  return jsonb_build_object('ok',false,'saved',false,'outcome','invalid_input');
 end if;
 select * into v_session from public.smpn4_exam_runtime_sessions
  where session_id=p_session_id and student_id=p_student_id for update;
 if not found then return jsonb_build_object('ok',false,'saved',false,'outcome','invalid_session'); end if;
 if exists (select 1 from public.smpn4_exam_blocklist where student_id=p_student_id and is_blocked=true and unblocked_at is null) then
  return jsonb_build_object('ok',false,'saved',false,'outcome','blocked');
 end if;
 if v_session.status<>'active' or v_session.expires_at<=now() then
  return jsonb_build_object('ok',false,'saved',false,'outcome','invalid_session');
 end if;
 if jsonb_array_length(p_answers_pg)>jsonb_array_length(v_session.question_snapshot)
    or jsonb_array_length(p_answers_essay)>jsonb_array_length(v_session.question_snapshot) then
  return jsonb_build_object('ok',false,'saved',false,'outcome','invalid_input');
 end if;
 insert into public.smpn4_exam_answer_progress(session_id,student_id,answers_pg,answers_essay,revision,updated_at)
 values(p_session_id,p_student_id,p_answers_pg,p_answers_essay,p_revision,now())
 on conflict(session_id) do update set answers_pg=excluded.answers_pg,answers_essay=excluded.answers_essay,
   revision=excluded.revision,updated_at=now()
 where public.smpn4_exam_answer_progress.student_id=excluded.student_id
   and public.smpn4_exam_answer_progress.revision<excluded.revision;
 select * into v_progress from public.smpn4_exam_answer_progress where session_id=p_session_id;
 if not found then return jsonb_build_object('ok',false,'saved',false,'outcome','not_found'); end if;
 return jsonb_build_object('ok',true,'saved',v_progress.revision=p_revision,'revision',v_progress.revision,
   'updated_at',v_progress.updated_at,'answers_pg',v_progress.answers_pg,'answers_essay',v_progress.answers_essay);
end
$function$;

CREATE OR REPLACE FUNCTION public.smpn4_commit_exam_submission(p_submission jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_session public.smpn4_exam_runtime_sessions%rowtype;
 v_existing public.smpn4_exam_submissions%rowtype; v_saved public.smpn4_exam_submissions%rowtype;
 v_submission_id text; v_session_id uuid; v_student_id text; v_received_at timestamptz;
 v_server_violations integer; v_payload jsonb;
begin
 v_submission_id:=nullif(p_submission->>'submission_id','');
 v_session_id:=nullif(p_submission->>'session_id','')::uuid;
 v_student_id:=nullif(p_submission->>'student_id','');
 v_received_at:=coalesce(nullif(p_submission->>'received_at','')::timestamptz,now());
 if v_submission_id is null or v_session_id is null or v_student_id is null then return jsonb_build_object('outcome','invalid_input'); end if;
 select * into v_session from public.smpn4_exam_runtime_sessions
  where session_id=v_session_id and student_id=v_student_id for update;
 if not found then return jsonb_build_object('outcome','invalid_session'); end if;
 select * into v_existing from public.smpn4_exam_submissions where submission_id=v_submission_id;
 if found then
  if v_existing.student_id<>v_student_id or v_existing.session_id<>v_session_id then return jsonb_build_object('outcome','submission_conflict'); end if;
  return jsonb_build_object('outcome','duplicate','submission',to_jsonb(v_existing));
 end if;
 select * into v_existing from public.smpn4_exam_submissions where session_id=v_session_id and student_id=v_student_id;
 if found then return jsonb_build_object('outcome','duplicate','submission',to_jsonb(v_existing)); end if;
 if coalesce(v_session.violations,0)>=3 or exists (
   select 1 from public.smpn4_exam_blocklist
   where student_id=v_student_id and is_blocked=true and unblocked_at is null
 ) then return jsonb_build_object('outcome','blocked'); end if;
 if v_session.status<>'active' or v_session.expires_at<=now() then return jsonb_build_object('outcome','invalid_session'); end if;
 v_server_violations:=coalesce(v_session.violations,0);
 v_payload:=coalesce(p_submission->'result_payload','{}'::jsonb)||jsonb_build_object('violations',v_server_violations,'session',v_session_id,'submissionId',v_submission_id);
 insert into public.smpn4_exam_submissions(
  submission_id,session_id,student_id,student_name,class_name,subject_name,answers_pg,answers_essay,
  score,correct_count,total_pg,essay_count,violations,status,received_at,processed_at,sheet_mirror_status,sheet_mirror_attempts,result_payload
 ) values (
  v_submission_id,v_session_id,v_session.student_id,v_session.student_name,v_session.class_name,v_session.subject_name,
  coalesce(p_submission->'answers_pg','[]'::jsonb),coalesce(p_submission->'answers_essay','[]'::jsonb),
  coalesce((p_submission->>'score')::numeric,0),coalesce((p_submission->>'correct_count')::integer,0),
  coalesce((p_submission->>'total_pg')::integer,0),coalesce((p_submission->>'essay_count')::integer,0),
  v_server_violations,coalesce(p_submission->>'status','review_required'),v_received_at,v_received_at,'pending',0,v_payload
 ) on conflict(submission_id) do nothing returning * into v_saved;
 if not found then
  select * into v_existing from public.smpn4_exam_submissions where submission_id=v_submission_id;
  if found and v_existing.student_id=v_student_id and v_existing.session_id=v_session_id then return jsonb_build_object('outcome','duplicate','submission',to_jsonb(v_existing)); end if;
  return jsonb_build_object('outcome','submission_conflict');
 end if;
 update public.smpn4_exam_runtime_sessions set status='submitted',completed_at=v_received_at,violations=v_server_violations
  where session_id=v_session_id and status='active';
 delete from public.smpn4_exam_answer_progress where session_id=v_session_id and student_id=v_student_id;
 return jsonb_build_object('outcome','saved','submission',to_jsonb(v_saved));
end $function$;