# SSO satu pintu Dashboard Guru SMPN4

Paket ini khusus SMPN4 Praya. Jangan gunakan pada project atau aplikasi SMPN5.

## Arsitektur

- Guru login satu kali di website sekolah: `https://smpn4praya.web.id/guru/login`.
- Tombol **Ujian Online & Bank Soal** pada Dashboard Guru meminta token SSO singkat dari server website.
- Browser diarahkan ke `/guru-sso.html` pada domain ujian. Token dikirim melalui URL fragment, segera dihapus dari address bar, lalu ditukar menjadi sesi server satu kali.
- Dashboard lama `guru.html` tetap dipakai. Tidak dibuat ulang.
- Admin membuka dashboard yang sama dari Dashboard Admin dan memperoleh peran admin.
- Sesi ujian disimpan sebagai hash token di `smpn4_teacher_sessions`; rahasia SSO tidak pernah dikirim ke browser.

## File perubahan

- `guru.html`: PIN bersama diganti petunjuk masuk melalui Portal Guru; menu global disembunyikan untuk guru biasa; kelas/mapel di editor disaring sesuai penugasan.
- `guru-sso.html`: jembatan SSO satu kali menuju `guru.html`.
- `database/MIGRASI_GURU_SSO_SMPN4.sql`: hanya menambahkan kolom dan indeks ke tabel sesi.
- `deployment/supabase/functions/clever-api/index.ts`: memverifikasi token SSO, menolak penggunaan ulang `jti`, membedakan role admin/guru, dan membatasi data/aksi guru berdasarkan penugasan.

## Rahasia yang harus dibuat

Buat satu nilai acak minimal 32 byte di komputer sendiri. Contoh PowerShell dengan Node.js:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Jangan kirim nilai ini ke chat, jangan simpan di HTML, dan jangan commit ke GitHub.

Pasang nilai yang sama sebagai secret bernama:

- Cloudflare Worker website `smpn4-website`: `SMPN4_TEACHER_SSO_SECRET`
- Supabase Edge Function project SMPN4 (`tpyjkxbseblvemqyuapb`): `SMPN4_TEACHER_SSO_SECRET`

Jangan memasang secret ini pada project SMPN5.

## Urutan penerapan

1. Backup source `guru.html` dan source Edge Function aktif. Pastikan project Supabase yang terbuka adalah SMPN4 (`tpyjkxbseblvemqyuapb`).
2. Jalankan `database/MIGRASI_GURU_SSO_SMPN4.sql` pada SQL Editor project SMPN4. Migrasi tidak menghapus sesi lama atau data ujian.
3. Pasang secret SSO yang sama di Cloudflare Worker website dan Supabase Edge Function SMPN4.
4. Deploy Edge Function:
   ```bash
   supabase functions deploy clever-api --project-ref tpyjkxbseblvemqyuapb --no-verify-jwt
   ```
   Gunakan source dari `deployment/supabase/functions/clever-api/index.ts`.
5. Deploy repository ini ke Cloudflare Pages production branch `main`. Pastikan `https://ujian.smpn4praya.web.id/guru-sso.html` dapat dibuka.
6. Merge/deploy PR website yang menambahkan endpoint `/api/guru/exam-sso` dan tombol SSO pada Dashboard Guru/Admin.
7. Uji akun guru dengan penugasan berbeda dan akun Admin. Jangan uji dengan mengubah data siswa, token, jadwal, hasil, atau sesi ujian aktif.

## Hak akses

- Guru: daftar nilai, sesi aktif, ringkasan kehadiran, daftar blokir baca-saja, dan bank soal/pengaturan soal hanya pada kelas/mapel yang ditugaskan.
- Admin: akses penuh ke fitur dashboard ujian.
- Aksi global seperti mengubah token dan jadwal tetap khusus Admin.
- Penugasan guru yang dinonaktifkan akan berlaku pada sesi login berikutnya; sesi SSO yang sudah diterbitkan berakhir maksimal 60 menit.

## Dampak transisi

- Login PIN bersama lama dinonaktifkan oleh Edge Function baru agar tidak menjadi jalur untuk melewati pembatasan penugasan.
- Sesi lama yang tidak memiliki role SSO tidak dapat dipakai setelah Edge Function baru aktif. Baris lama tidak dihapus.
- Lakukan penerapan terkoordinasi agar pengguna tidak terputus di antara pergantian website, Pages, dan Edge Function.
- Roster, jadwal, token, hasil, jawaban, snapshot ujian, dan tabel siswa tidak dimodifikasi oleh paket ini.
