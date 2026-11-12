# Panduan hosting aplikasi ujian di Cloudflare Pages

Repositori ini berisi aplikasi ujian statis SMPN4 Praya:
- `index.html` — aplikasi siswa.
- `guru.html` — dashboard guru.

## Tujuan migrasi

Menayangkan aplikasi pada subdomain `ujian.smpn4praya.web.id), tanpa menghapus atau mengganti alamat GitHub Pages yang lama sampai pengujian selesai.

## Pengaturan Cloudflare Pages

1. Buka Cloudflare Dashboard > Workers & Pages > Create application > Pages > Connect to Git.
2. Pilih repository `ryansyahrial424-gif/UJIAN-TERPADU-SMPN4`.
3. Production branch: `main`.
4. Framework preset: `None`.
5. Build command: kosongkan (tidak ada proses build).
6. Build output directory: `.` (root repository).
7. Simpan dan deploy.
8. Uji URL `*.pages.dev` yang diberikan Cloudflare:
   - halaman utama siswa harus tampil;
   - halaman guru dapat dibuka melalui `/guru.html`;
   - periksa login, jadwal/token, mulai ujian, timer, pengiriman jawaban, dan konfirmasi server.

## Menghubungkan subdomain sekolah

Setelah URL `pages.dev` berhasil diuji:

1. Di proyek Pages, buka **Custom domains**.
2. Pilih **Set up a domain**.
3. Masukkan `ujian.smpn4praya.web.id`.
4. Ikuti konfirmasi Cloudflare sampai status domain aktif dan HTTPS tersedia.
5. Jangan mengubah DNS domain utama `smpn4praya.web.id` atau Worker website utama.

Cloudflare Pages akan mengatur DNS secara otomatis jika zona domain sekolah sudah dikelola pada akun Cloudflare yang sama. Jika tidak, ikuti nilai CNAME yang ditampilkan oleh Cloudflare.

## Catatan keamanan dan migrasi

- Jangan memasukkan service-role key, password admin, atau kredensial rahasia ke HTML/JavaScript.
- Supabase anon/publishable key yang digunakan aplikasi browser bukan pengganti kebijakan keamanan database. Pastikan RLS dan validasi Edge Function tetap aktif.
- Backend ujian tetap berada pada Supabase proyek ujian SMPN4. Dokumen ini hanya menyiapkan hosting tampilan HTML di Cloudflare Pages.
- Jangan menonaktifkan GitHub Pages atau menghapus file produksi lama sebelum URL Cloudflare, login guru/siswa, dan alur ujian berhasil diuji.
- Dashboard siswa website utama baru boleh menampilkan nilai setelah tersedia pemetaan identitas siswa yang tervalidasi (NISN portal ke ID siswa ujian) dan endpoint server yang membatasi hasil hanya milik siswa yang sedang login.
