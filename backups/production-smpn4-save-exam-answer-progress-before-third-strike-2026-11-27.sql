CREATE OR REPLACE FUNCTION public.smpn4_save_exam_answer_progress(p_session_id uuid, p_student_id text, p_answers_pg jsonb, p_answers_essay jsonb, p_revision integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_session public.smpn4_exam_runtime_sessions%rowtype; v_progress public.smpn4_exam_answer_progress%rowtype;
begin
  if p_session_id is null or coalesce(p_student_id,'')='' or p_revision is null or p_revision<1
     or jsonb_typeof(p_answers_pg)<>'array' or jsonb_typeof(p_answers_essay)<>'array' then
    return jsonb_build_object('ok',false,'saved',false,'outcome','invalid_input');
  end if;
  select * into v_session from public.smpn4_exam_runtime_sessions
   where session_id=p_session_id and student_id=p_student_id for update;
  if not found or v_session.status<>'active' or v_session.expires_at<=now() then
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
end $function$
