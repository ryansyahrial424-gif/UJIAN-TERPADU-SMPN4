-- MIGRASI ADITIF SSO GURU SMPN4 PRAYA
-- Jalankan hanya pada Supabase project SMPN4: tpyjkxbseblvemqyuapb
-- Tidak menghapus, mengubah, atau membersihkan sesi/hasil ujian yang sudah ada.
alter table public.smpn4_teacher_sessions
  add column if not exists teacher_id text,
  add column if not exists role text,
  add column if not exists assignments jsonb not null default '[]'::jsonb,
  add column if not exists sso_jti text;
create unique index if not exists smpn4_teacher_sessions_sso_jti_uidx
  on public.smpn4_teacher_sessions (sso_jti) where sso_jti is not null;
comment on column public.smpn4_teacher_sessions.teacher_id is 'ID guru dari portal sekolah untuk sesi SSO SMPN4.';
comment on column public.smpn4_teacher_sessions.role is 'Peran sesi SSO: teacher atau admin.';
comment on column public.smpn4_teacher_sessions.assignments is 'Snapshot penugasan aktif guru yang ditandatangani server portal saat SSO.';
comment on column public.smpn4_teacher_sessions.sso_jti is 'ID unik token SSO untuk mencegah token ditukar lebih dari satu kali.';
