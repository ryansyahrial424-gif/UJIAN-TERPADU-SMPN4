const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info, x-supabase-api-version, x-requested-with",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
};

function respond(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function cleanText(value: unknown, max = 5000): string {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeQuestionText(value: unknown): string {
  return cleanText(value, 12000).normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("id-ID");
}

// Satu bank soal aktif untuk seluruh kelas paralel pada jenjang yang sama.
function bankClassForClass(value: unknown): string {
  const cls = cleanText(value, 40);
  if (cls === "7.1" || cls === "7.2" || cls === "7.3") return "7.1";
  if (cls === "8.1" || cls === "8.2") return "8.1";
  if (cls === "9.1" || cls === "9.2") return "9.1";
  return cls;
}

function safeEqual(a: string, b: string): boolean {
  // Compare without returning early on the first differing character.
  const encoder = new TextEncoder();
  const aa = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = aa.length ^ bb.length;
  const length = Math.max(aa.length, bb.length);
  for (let i = 0; i < length; i++) {
    diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

const QUESTION_IMAGE_BUCKET = "smpn4-question-images";
const QUESTION_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
const QUESTION_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
};
const SMPN4_PROJECT_ORIGIN = "https://tpyjkxbseblvemqyuapb.supabase.co";

function normalizeQuestionImageUrls(raw: unknown): { value?: string[]; error?: string } {
  if (raw === undefined) return {};
  const items = raw === null ? [] : (Array.isArray(raw) ? raw : null);
  if (!items) return { error: "Daftar gambar soal harus berupa array." };
  if (items.length > 5) return { error: "Maksimal 5 gambar untuk satu soal." };
  const urls: string[] = [];
  for (const item of items) {
    const urlText = typeof item === "string" ? item.trim() : cleanText((item as Record<string, unknown>)?.url ?? (item as Record<string, unknown>)?.public_url, 2048);
    if (!urlText) continue;
    try {
      const parsed = new URL(urlText);
      if (parsed.protocol !== "https:" || parsed.origin !== SMPN4_PROJECT_ORIGIN || !parsed.pathname.startsWith(`/storage/v1/object/public/${QUESTION_IMAGE_BUCKET}/`)) {
        return { error: "URL gambar harus berasal dari bucket gambar SMPN4 yang resmi." };
      }
      urls.push(parsed.toString());
    } catch { return { error: "URL gambar soal tidak valid." }; }
  }
  return { value: [...new Set(urls)] };
}

async function ensureQuestionImageBucket(supabase: any) {
  const { data: existing, error: lookupError } = await supabase.storage.getBucket(QUESTION_IMAGE_BUCKET);
  const config = { public: true, fileSizeLimit: QUESTION_IMAGE_MAX_BYTES, allowedMimeTypes: Object.keys(QUESTION_IMAGE_TYPES) };
  if (existing?.id) {
    const { error: updateError } = await supabase.storage.updateBucket(QUESTION_IMAGE_BUCKET, config);
    if (updateError) throw new Error(`Gagal menyelaraskan pengaturan bucket gambar SMPN4: ${updateError.message}`);
    return;
  }
  const { error: createError } = await supabase.storage.createBucket(QUESTION_IMAGE_BUCKET, config);
  if (createError && !/already exists|duplicate/i.test(String(createError.message || ""))) {
    throw new Error(`Gagal membuat bucket gambar SMPN4: ${createError.message || lookupError?.message || "storage error"}`);
  }
}

async function uploadQuestionImage(supabase: any, body: Record<string, any>) {
  const contentType = cleanText(body.content_type, 80).toLowerCase();
  const extension = QUESTION_IMAGE_TYPES[contentType];
  if (!extension) throw new Error("Format gambar tidak didukung. Gunakan JPG, PNG, atau WEBP.");
  const encoded = String(body.data_base64 || "").trim().replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
  if (!encoded || encoded.length > Math.ceil(QUESTION_IMAGE_MAX_BYTES * 4 / 3) + 16 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("Data gambar kosong atau terlalu besar. Maksimal 3 MB per gambar.");
  }
  let binary: string;
  try { binary = atob(encoded); } catch { throw new Error("Data gambar tidak valid."); }
  if (!binary.length || binary.length > QUESTION_IMAGE_MAX_BYTES) throw new Error("Ukuran gambar harus 1 byte sampai 3 MB.");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const isJpeg = contentType === "image/jpeg" && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = contentType === "image/png" && bytes.length >= 8 && [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((v,i)=>bytes[i]===v);
  const isWebp = contentType === "image/webp" && bytes.length >= 12 && String.fromCharCode(...bytes.slice(0,4)) === "RIFF" && String.fromCharCode(...bytes.slice(8,12)) === "WEBP";
  if (!isJpeg && !isPng && !isWebp) throw new Error("Isi file tidak cocok dengan format gambar yang dipilih.");
  await ensureQuestionImageBucket(supabase);
  const classPart = cleanText(body.class_name,40).replace(/[^a-zA-Z0-9._-]/g, "") || "umum";
  const subjectPart = cleanText(body.subject_name,120).toLowerCase().replace(/[^a-zA-Z0-9._-]/g, "") || "mapel";
  const objectPath = `${classPart}/${subjectPart}/${crypto.randomUUID()}.${extension}`;
  const { data, error } = await supabase.storage.from(QUESTION_IMAGE_BUCKET).upload(objectPath, bytes, { contentType, cacheControl: "31536000", upsert: false });
  if (error) throw new Error(`Gagal mengunggah gambar soal: ${error.message}`);
  const { data: publicData } = supabase.storage.from(QUESTION_IMAGE_BUCKET).getPublicUrl(data?.path || objectPath);
  const publicUrl = cleanText(publicData?.publicUrl, 2048);
  if (!publicUrl) throw new Error("Gambar berhasil diunggah tetapi URL publik tidak tersedia.");
  return { public_url: publicUrl, path: data?.path || objectPath, bucket: QUESTION_IMAGE_BUCKET, size_bytes: bytes.length, content_type: contentType };
}

function extractEssayAnswersOnly(value: unknown): string[] {
  return parseArray(value).map((entry) => {
    if (entry === null || entry === undefined) return "";
    if (typeof entry === "string" || typeof entry === "number") return String(entry).trim();
    if (typeof entry === "object" && !Array.isArray(entry)) {
      const item = entry as Record<string, unknown>;
      const answer = item.answer_text ?? item.student_answer ?? item.studentAnswer ?? item.answer ?? item.response ?? item.value ?? item.text ?? item.jawaban;
      return answer === null || answer === undefined ? "" : String(answer).trim();
    }
    return "";
  });
}

function validateQuestion(input: Record<string, unknown>) {
  const class_name = bankClassForClass(input.class_name);
  const subject_name = cleanText(input.subject_name, 120);
  const question_type = cleanText(input.question_type, 20);
  const question_text = cleanText(input.question_text, 12000);
  const options = input.options === undefined ? [] : input.options;
  const points = Number(input.points ?? 1);
  const sort_order = Number(input.sort_order ?? 0);
  const is_active = input.is_active === undefined ? true : input.is_active;
  const correct_answer = input.correct_answer ?? null;
  const imageResult = normalizeQuestionImageUrls(input.image_urls !== undefined ? input.image_urls : input.imgs);
  if (imageResult.error) return { error: imageResult.error };

  if (!class_name || !subject_name || !question_text) {
    return { error: "Kelas, mata pelajaran, dan teks soal wajib diisi." };
  }
  const allowedClasses = new Set(["7.1", "7.2", "7.3", "8.1", "8.2", "9.1", "9.2"]);
  if (!allowedClasses.has(class_name)) {
    return { error: "Kelas tidak valid. Gunakan salah satu kelas SMPN4 yang terdaftar." };
  }
  if (question_type !== "pg" && question_type !== "essay") {
    return { error: "Jenis soal harus 'pg' atau 'essay'." };
  }
  if (!Array.isArray(options)) {
    return { error: "Pilihan jawaban harus berupa array." };
  }
  if (!Number.isFinite(points) || points <= 0 || points > 100000) {
    return { error: "Poin harus berupa angka lebih besar dari 0." };
  }
  if (!Number.isInteger(sort_order) || Math.abs(sort_order) > 1000000) {
    return { error: "Urutan soal harus berupa bilangan bulat yang valid." };
  }
  if (typeof is_active !== "boolean") {
    return { error: "is_active harus bernilai true atau false." };
  }
  if (question_type === "pg") {
    if (options.length < 2 || options.length > 6) {
      return { error: "Soal pilihan ganda harus memiliki 2 sampai 6 pilihan." };
    }
    if (options.some((v) => typeof v !== "string" || !v.trim())) {
      return { error: "Setiap pilihan jawaban harus berupa teks yang tidak kosong." };
    }
    if (correct_answer === null || correct_answer === "") {
      return { error: "Kunci jawaban wajib diisi untuk soal pilihan ganda." };
    }
    const answerText = String(correct_answer).trim();
    const validAnswer = options.some((option, index) =>
      answerText === String.fromCharCode(65 + index) ||
      answerText === option
    );
    if (!validAnswer) {
      return { error: "Kunci jawaban harus sesuai huruf A-F atau teks pilihan." };
    }
  } else if (options.length !== 0) {
    return { error: "Soal esai tidak boleh memiliki pilihan jawaban." };
  }

  return {
    value: {
      class_name,
      subject_name,
      question_type,
      question_text,
      options,
      correct_answer,
      points,
      sort_order,
      is_active,
      updated_at: new Date().toISOString(),
      ...(imageResult.value !== undefined ? { image_urls: imageResult.value } : {}),
    },
  };
}


function parseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
}

function correctOptionIndex(question: Record<string, unknown>): number {
  const answer = question.correct_answer;
  const options = Array.isArray(question.options) ? question.options : [];
  if (typeof answer === "number" && Number.isInteger(answer)) return answer;
  const text = cleanText(answer, 1000);
  if (/^[A-F]$/i.test(text)) return text.toUpperCase().charCodeAt(0) - 65;
  return options.findIndex((option) => String(option) === text);
}

function publicQuestion(question: Record<string, unknown>, index: number) {
  return {
    question_id: question.question_id,
    question_type: question.question_type,
    question_text: question.question_text,
    options: Array.isArray(question.options) ? question.options : [],
    image_urls: Array.isArray(question.image_urls) ? question.image_urls : [],
    imgs: Array.isArray(question.image_urls) ? question.image_urls : [],
    points: Number(question.points ?? 1),
    sort_order: Number(question.sort_order ?? index),
  };
}

function scheduleBackground(task: Promise<unknown>): boolean {
  try {
    const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
    if (runtime?.waitUntil) { runtime.waitUntil(task); return true; }
  } catch { /* fallback handled by caller */ }
  return false;
}

async function mirrorOneResult(supabase: any, gasUrl: string, mirrorSecret: string, row: Record<string, unknown>) {
  const submissionId = String(row.submission_id ?? "");
  const nextAttempt = Number(row.sheet_mirror_attempts ?? 0) + 1;
  const resultPayload = (row.result_payload && typeof row.result_payload === "object")
    ? row.result_payload as Record<string, unknown> : {};

  try {
    if (!gasUrl || !mirrorSecret) throw new Error("Konfigurasi mirror belum lengkap.");
    if (!submissionId) throw new Error("submission_id kosong pada antrean mirror.");
    if (!Object.keys(resultPayload).length) throw new Error("result_payload kosong; hasil tidak dikirim agar tidak menulis data kosong ke Sheets.");

    const form = new URLSearchParams({
      action: "mirrorSupabaseResult",
      mirrorSecret,
      result: JSON.stringify(resultPayload),
    });
    const response = await fetch(gasUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: form.toString(),
      signal: AbortSignal.timeout(12000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.success !== true || body.saved !== true) {
      throw new Error(cleanText(body?.message || `Mirror Google Sheets gagal (HTTP ${response.status}).`, 500));
    }

    const { error: updateError } = await supabase.from("smpn4_exam_submissions").update({
      sheet_mirror_status: "mirrored",
      sheet_mirror_attempts: nextAttempt,
      sheet_mirror_next_attempt_at: null,
      sheet_mirror_last_error: null,
    }).eq("submission_id", submissionId);
    if (updateError) {
      console.error("Mirror berhasil di GAS tetapi status database gagal diperbarui:", submissionId, updateError.message);
      return { ok: false, message: "GAS menyatakan tersimpan, tetapi status Supabase gagal diperbarui." };
    }
    console.log("Mirror hasil ujian berhasil:", submissionId);
    return { ok: true };
  } catch (error) {
    const message = cleanText(error instanceof Error ? error.message : String(error), 500);
    // Backoff bertahap agar kegagalan GAS tidak membuat antrean dicoba
    // berulang pada setiap request siswa/verifikasi hasil.
    const retryDelayMs = Math.min(300000, 15000 * (2 ** Math.max(0, nextAttempt - 1)));
    const nextAttemptAt = new Date(Date.now() + retryDelayMs).toISOString();
    const { error: updateError } = await supabase.from("smpn4_exam_submissions").update({
      sheet_mirror_status: "error",
      sheet_mirror_attempts: nextAttempt,
      sheet_mirror_next_attempt_at: nextAttemptAt,
      sheet_mirror_last_error: message,
    }).eq("submission_id", submissionId);
    console.error("Mirror hasil ujian gagal:", submissionId, message);
    if (updateError) console.error("Gagal memperbarui status mirror di Supabase:", submissionId, updateError.message);
    return { ok: false, message };
  }
}

async function processSheetMirrorQueue(supabase: any) {
  const gasUrl = (Deno.env.get("SMPN4_GAS_WEB_APP_URL") || "").trim();
  const mirrorSecret = (Deno.env.get("SMPN4_RESULT_MIRROR_SECRET") || "").trim();
  if (!gasUrl || !mirrorSecret) {
    console.error("Antrean mirror tidak dijalankan: secret/url SMPN4 belum terbaca di Edge Function Secrets.", {
      hasGasUrl: Boolean(gasUrl),
      hasMirrorSecret: Boolean(mirrorSecret),
    });
    return;
  }

  const nowIso = new Date().toISOString();
  const { data, error } = await supabase.from("smpn4_exam_submissions")
    .select("submission_id,result_payload,sheet_mirror_attempts")
    .in("sheet_mirror_status", ["pending", "error"])
    .lt("sheet_mirror_attempts", 8)
    .or(`sheet_mirror_next_attempt_at.is.null,sheet_mirror_next_attempt_at.lte.${nowIso}`)
    .order("received_at", { ascending: true }).limit(5);
  if (error) {
    console.error("Gagal membaca antrean mirror SMPN4:", error.message);
    return;
  }
  if (!data?.length) {
    console.log("Antrean mirror SMPN4 kosong.");
    return;
  }
  console.log("Antrean mirror SMPN4 mulai diproses:", data.length, "hasil.");
  for (const row of data) {
    await mirrorOneResult(supabase, gasUrl, mirrorSecret, row as Record<string, unknown>);
  }
}


Deno.serve(async (req: Request): Promise<Response> => {
  // Preflight harus dijawab segera, tanpa memuat pustaka/database atau membaca secrets.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const teacherPin = Deno.env.get("SMPN4_TEACHER_PIN");
  const bankSyncSecret = Deno.env.get("SMPN4_BANK_SYNC_SECRET") || "";

  if (!supabaseUrl || !serviceRoleKey) {
    return respond({
      ok: false,
      message: "Konfigurasi server Supabase belum lengkap.",
      databaseChanged: false,
    }, 500);
  }

  try {
    // Pustaka Supabase dimuat hanya untuk GET/POST. OPTIONS di atas tidak bergantung
    // pada npm import atau koneksi database, sehingga preflight bisa segera selesai.
    const { createClient } = await import("npm:@supabase/supabase-js@2");
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Endpoint GET lama dipertahankan untuk uji koneksi dan jumlah siswa.
    if (req.method === "GET") {
      const { count, error } = await supabase
        .from("smpn4_student_roster")
        .select("student_id", { count: "exact", head: true });

      if (error) throw error;

      return respond({
        ok: true,
        service: "smpn4-exam-api",
        databaseConnected: true,
        rosterCount: count ?? 0,
        databaseChanged: false,
      });
    }

    if (req.method !== "POST") {
      return respond({
        ok: false,
        message: "Metode HTTP tidak didukung.",
        databaseChanged: false,
      }, 405);
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return respond({
        ok: false,
        message: "Body permintaan harus berupa JSON object.",
        databaseChanged: false,
      }, 400);
    }


    const action = cleanText(body.action, 80);

    // Google Sheets tetap menjadi tempat editor soal. Apps Script mendorong
    // salinan tervalidasi ke Supabase; siswa tidak membaca Sheet secara langsung.
    if (action === "sync-question-bank") {
      const suppliedSecret = cleanText(body.sync_secret, 500);
      if (!bankSyncSecret || !safeEqual(suppliedSecret, bankSyncSecret)) {
        return respond({ ok: false, message: "Otorisasi sinkronisasi bank soal ditolak.", databaseChanged: false }, 401);
      }
      const rawQuestions = Array.isArray(body.questions) ? body.questions : [];
      if (!rawQuestions.length || rawQuestions.length > 100) {
        return respond({ ok: false, message: "Batch sinkronisasi harus berisi 1 sampai 100 soal.", databaseChanged: false }, 400);
      }
      const records = [];
      const seenSourceIds = new Set<string>();
      for (const raw of rawQuestions) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          return respond({ ok: false, message: "Setiap item soal harus berupa object JSON.", databaseChanged: false }, 400);
        }
        const source_id = cleanText((raw as Record<string, unknown>).source_id, 160);
        if (!source_id) {
          return respond({ ok: false, message: "Setiap soal wajib memiliki source_id.", databaseChanged: false }, 400);
        }
        if (seenSourceIds.has(source_id)) {
          return respond({ ok: false, message: `source_id duplikat dalam batch: ${source_id}`, databaseChanged: false }, 400);
        }
        seenSourceIds.add(source_id);
        const checked = validateQuestion({
          class_name: (raw as Record<string, unknown>).class_name,
          subject_name: (raw as Record<string, unknown>).subject_name,
          question_type: (raw as Record<string, unknown>).question_type,
          question_text: (raw as Record<string, unknown>).question_text,
          options: (raw as Record<string, unknown>).options ?? [],
          correct_answer: (raw as Record<string, unknown>).correct_answer,
          points: (raw as Record<string, unknown>).points ?? 1,
          sort_order: (raw as Record<string, unknown>).sort_order ?? 0,
          is_active: (raw as Record<string, unknown>).is_active ?? true,
        });
        if (!source_id || "error" in checked) {
          return respond({ ok: false, message: `Data soal tidak valid (${source_id || "tanpa source_id"}): ${"error" in checked ? checked.error : "source_id wajib"}`, databaseChanged: false }, 400);
        }
        records.push({ source_id, ...checked.value });
      }
      const { error } = await supabase.from("smpn4_question_bank_shared").upsert(records, { onConflict: "source_id" });
      if (error) throw error;
      return respond({ ok: true, synced: records.length, databaseChanged: true });
    }

    if (action === "authorize-exam") {
      const studentId = cleanText(body.student_id ?? body.studentId, 120);
      const studentName = cleanText(body.student_name ?? body.name, 200);
      const className = cleanText(body.class_name ?? body.studentClass, 40);
      const token = cleanText(body.token, 200);
      const subjectName = cleanText(body.subject_name ?? body.subject, 120);
      if (!studentId || !studentName || !className || !token) return respond({ success: false, allowed: false, message: "Identitas siswa dan token wajib diisi." }, 400);
      const { data: student, error: rosterError } = await supabase.from("smpn4_student_roster")
        .select("student_id,student_name,class_name,is_active").eq("student_id", studentId).maybeSingle();
      if (rosterError) throw rosterError;
      if (!student || student.is_active !== true || student.student_name !== studentName || student.class_name !== className) return respond({ success: false, allowed: false, reason: "INVALID_STUDENT", message: "Identitas siswa tidak cocok dengan roster." });
      const { data: settings, error: settingsError } = await supabase.from("smpn4_exam_settings")
        .select("exam_token,schedule,login_grace_minutes").eq("id", 1).maybeSingle();
      if (settingsError) throw settingsError;
      if (!settings || !settings.exam_token || token !== settings.exam_token) return respond({ success: false, allowed: false, reason: "INVALID_TOKEN", message: "Token ujian salah atau belum diatur guru." });
      const { data: block, error: blockError } = await supabase.from("smpn4_exam_blocklist").select("block_id")
        .eq("student_id", studentId).eq("is_blocked", true).is("unblocked_at", null).limit(1).maybeSingle();
      if (blockError) throw blockError;
      if (block) return respond({ success: false, allowed: false, reason: "BLACKLIST", message: "Siswa sedang diblokir." });
      const { data: approvedRetake, error: approvedRetakeError } = await supabase.from("smpn4_exam_retake_authorizations")
        .select("authorization_id").eq("student_id", studentId).eq("class_name", className)
        .ilike("subject_name", subjectName).is("used_at", null).gt("expires_at", new Date().toISOString())
        .order("granted_at", { ascending: false }).limit(1).maybeSingle();
      if (approvedRetakeError) throw approvedRetakeError;
      const schedule = settings.schedule && typeof settings.schedule === "object" ? settings.schedule as Record<string, unknown> : {};
      const now = new Date();
      const local = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Makassar" }));
      const dateKey = `${local.getFullYear()}-${String(local.getMonth()+1).padStart(2,"0")}-${String(local.getDate()).padStart(2,"0")}`;
      const slots = Array.isArray(schedule[dateKey]) ? schedule[dateKey] as Record<string, unknown>[] : [];
      const minutesNow = local.getHours()*60+local.getMinutes();
      const grace = Math.max(0, Math.min(120, Number(settings.login_grace_minutes ?? 20)));
      const slot = slots.find((item) => {
        const start = String(item.start ?? "").split(":").map(Number); const end = String(item.end ?? "").split(":").map(Number);
        if (start.length < 2 || end.length < 2 || !Number.isFinite(start[0]) || !Number.isFinite(end[0])) return false;
        const begin = start[0]*60+start[1], finish = end[0]*60+end[1];
        const subjects = Array.isArray(item.subjects) ? item.subjects.map(String) : (item.subject ? [String(item.subject)] : []);
        // Login baru hanya diizinkan sejak jam mulai sampai batas toleransi setelah mulai.
        return minutesNow >= begin && minutesNow <= Math.min(finish, begin + grace) && (!subjectName || !subjects.length || subjects.includes(subjectName));
      });
      // A student who has already started a live Supabase session may re-enter that session.
      const { data: liveSession, error: liveError } = await supabase.from("smpn4_exam_runtime_sessions")
        .select("session_id,expires_at,subject_name,violations").eq("student_id", studentId).eq("class_name", className)
        .eq("status", "active").gt("expires_at", now.toISOString()).order("started_at", { ascending: false }).limit(1).maybeSingle();
      if (liveError) throw liveError;
      const sameLiveSession = Boolean(liveSession && (!subjectName || liveSession.subject_name === subjectName));
      if (!slot && !sameLiveSession && !approvedRetake) return respond({ success: false, allowed: false, message: "Saat ini di luar jadwal ujian yang diizinkan untuk mata pelajaran tersebut." });
      const expiry = sameLiveSession && liveSession?.expires_at ? new Date(liveSession.expires_at).getTime() : now.getTime()+90*60*1000;
      return respond({ success: true, allowed: true, studentId, name: studentName, studentClass: className,
        session: sameLiveSession && liveSession ? liveSession.session_id : `login-${randomToken()}`, expiresAt: expiry,
        subject: subjectName || (sameLiveSession ? liveSession?.subject_name : "") || "", violations: Number(sameLiveSession ? liveSession?.violations ?? 0 : 0),
        schedule: { subjects: slot && Array.isArray(slot.subjects) ? slot.subjects : (subjectName ? [subjectName] : []) } });
    }

    if (action === "record-violation") {
      const studentId = cleanText(body.student_id ?? body.studentId, 120);
      const studentName = cleanText(body.student_name ?? body.name, 200);
      const className = cleanText(body.class_name ?? body.studentClass, 40);
      const sessionId = cleanText(body.session_id ?? body.session, 120);
      const eventId = cleanText(body.event_id ?? body.eventId, 160);
      const reason = cleanText(body.reason, 500) || "Pelanggaran aturan ujian";
      if (!studentId || !studentName || !className || !sessionId || !eventId) {
        return respond({ success: false, blocked: false, message: "ID siswa, nama, kelas, sesi runtime, dan ID kejadian wajib diisi." }, 400);
      }
      if (!isUuid(sessionId)) return respond({ success: false, blocked: false, message: "ID sesi runtime Supabase tidak valid." }, 400);

      const { data: ownedSession, error: ownedError } = await supabase.from("smpn4_exam_runtime_sessions")
        .select("session_id,student_id,student_name,class_name,status,violations")
        .eq("session_id", sessionId).maybeSingle();
      if (ownedError) throw ownedError;
      if (!ownedSession || ownedSession.student_id !== studentId || ownedSession.student_name !== studentName || ownedSession.class_name !== className) {
        return respond({ success: false, blocked: false, message: "Sesi tidak cocok dengan identitas siswa." }, 403);
      }

      // Count is based on persisted events, not the browser's local counter.
      const countViolations = async () => {
        const { count, error } = await supabase.from("smpn4_exam_violation")
          .select("violation_id", { count: "exact", head: true })
          .eq("student_id", studentId).eq("session_id", sessionId);
        if (error) throw error;
        return Number(count ?? 0);
      };
      const findActiveBlock = async () => {
        const { data, error } = await supabase.from("smpn4_exam_blocklist")
          .select("block_id").eq("student_id", studentId).eq("is_blocked", true)
          .is("unblocked_at", null).limit(1).maybeSingle();
        if (error) throw error;
        return data;
      };
      const ensureActiveBlock = async () => {
        let existing = await findActiveBlock();
        if (existing) return true;
        const { error } = await supabase.from("smpn4_exam_blocklist").insert({
          student_id: studentId, student_name: studentName, class_name: className,
          reason, is_blocked: true, blocked_at: new Date().toISOString(),
          created_at: new Date().toISOString(), unblocked_at: null,
        });
        if (error && error.code !== "23505") throw error;
        // Re-read after insert (also covers a concurrent request/unique conflict).
        existing = await findActiveBlock();
        return Boolean(existing);
      };

      // A retry with the same event ID must not increase the count. Still
      // re-evaluate block state, so a retry after a lost response confirms it.
      const { data: duplicate, error: dupError } = await supabase.from("smpn4_exam_violation")
        .select("violation_id,violation_no").eq("event_id", eventId).eq("session_id", sessionId)
        .limit(1).maybeSingle();
      if (dupError) throw dupError;
      if (duplicate) {
        const actualCount = await countViolations();
        if (Number(ownedSession.violations ?? 0) !== actualCount) {
          const { error } = await supabase.from("smpn4_exam_runtime_sessions")
            .update({ violations: actualCount }).eq("session_id", sessionId);
          if (error) throw error;
        }
        const blocked = actualCount >= 3 ? await ensureActiveBlock() : Boolean(await findActiveBlock());
        return respond({ success: true, duplicate: true, violations: actualCount, blocked,
          message: blocked ? "Kejadian sudah tercatat dan blokir aktif terkonfirmasi." : "Kejadian sudah tercatat; tidak dihitung ulang." });
      }

      // A retry for a previously stored event was handled above. A genuinely
      // new event must come from an active runtime session.
      if (ownedSession.status !== "active") {
        return respond({ success: false, blocked: false, message: "Sesi ujian sudah tidak aktif; pelanggaran baru tidak diterima." }, 409);
      }

      // A retry for an already-persisted event was handled above. A genuinely
      // new event must come from an active runtime session.
      if (ownedSession.status !== "active") {
        return respond({ success: false, blocked: false, message: "Sesi ujian sudah tidak aktif; pelanggaran baru tidak diterima." }, 409);
      }

      // Insert first and retry unique collisions. A collision is only treated as
      // duplicate if this exact event_id is already persisted; a collision caused
      // by a concurrent violation_no must not silently discard this event.
      let inserted = false;
      let duplicateEvent = false;
      let lastInsertError: { code?: string; message?: string } | null = null;
      for (let insertAttempt = 0; insertAttempt < 4 && !inserted; insertAttempt++) {
        const beforeCount = await countViolations();
        const { error: insertError } = await supabase.from("smpn4_exam_violation").insert({
          event_id: eventId, session_id: sessionId, student_id: studentId,
          student_name: studentName, class_name: className, reason,
          violation_no: beforeCount + 1, created_at: new Date().toISOString(),
        });
        if (!insertError) {
          inserted = true;
          break;
        }
        lastInsertError = insertError;
        if (insertError.code !== "23505") throw insertError;

        const { data: sameEvent, error: sameEventError } = await supabase.from("smpn4_exam_violation")
          .select("violation_id,event_id,session_id").eq("event_id", eventId).eq("session_id", sessionId)
          .limit(1).maybeSingle();
        if (sameEventError) throw sameEventError;
        if (sameEvent) {
          inserted = true;
          duplicateEvent = true;
          break;
        }
        // A different event won a concurrent counter value. Re-count and retry.
      }
      if (!inserted) {
        const diagnosticCode = lastInsertError?.code || "INSERT_FAILED";
        console.error("Pencatatan pelanggaran gagal setelah retry:", diagnosticCode, lastInsertError?.message || "");
        return respond({ success: false, ok: false, blocked: false,
          message: "Pelanggaran belum tersimpan setelah beberapa percobaan. Periksa skema tabel smpn4_exam_violation dan Function Logs.",
          errorCode: diagnosticCode, databaseChanged: false }, 500);
      }

      // Count from persisted rows. Repeated requests with the same event_id are
      // idempotent and do not create a second increment.
      const violationNo = await countViolations();
      const { error: updateError } = await supabase.from("smpn4_exam_runtime_sessions")
        .update({ violations: violationNo }).eq("session_id", sessionId);
      if (updateError) throw updateError;

      let blocked = Boolean(await findActiveBlock());
      if (violationNo >= 3) blocked = await ensureActiveBlock();
      if (violationNo >= 3 && !blocked) {
        return respond({ success: false, ok: false, blocked: false, violations: violationNo,
          message: "Pelanggaran ketiga tersimpan, tetapi server belum dapat memastikan blokir aktif.",
          databaseChanged: true }, 500);
      }
      return respond({ success: true, ok: true, duplicate: duplicateEvent, violations: violationNo, blocked,
        message: blocked ? "Batas pelanggaran tercapai; blokir aktif terkonfirmasi." : (duplicateEvent ? "Kejadian sudah tersimpan; tidak dihitung ulang." : "Pelanggaran tersimpan di Supabase.") });
    }

    if (action === "blacklist-student") {
      const studentId = cleanText(body.student_id ?? body.studentId, 120);
      const studentName = cleanText(body.student_name ?? body.name, 200);
      const className = cleanText(body.class_name ?? body.studentClass, 40);
      const reason = cleanText(body.reason, 500) || "Mencapai batas pelanggaran";
      const sessionId = cleanText(body.session_id ?? body.session, 120);
      if (!studentId || !studentName || !className || !isUuid(sessionId)) return respond({ success: false, blocked: false, message: "Identitas siswa dan sesi Supabase wajib valid." }, 400);
      const { data: ownedSession, error: ownedError } = await supabase.from("smpn4_exam_runtime_sessions").select("session_id,student_id,student_name,class_name,violations").eq("session_id", sessionId).maybeSingle();
      if (ownedError) throw ownedError;
      if (!ownedSession || ownedSession.student_id !== studentId || ownedSession.student_name !== studentName || ownedSession.class_name !== className) return respond({ success: false, blocked: false, message: "Sesi tidak cocok dengan identitas siswa." }, 403);
      if (Number(ownedSession.violations ?? 0) < 3) return respond({ success: false, blocked: false, message: "Pemblokiran otomatis memerlukan konfirmasi minimal 3 pelanggaran dari server." }, 403);
      const { data: existingBlock, error: existingBlockError } = await supabase.from("smpn4_exam_blocklist").select("block_id").eq("student_id", studentId).eq("is_blocked", true).is("unblocked_at", null).limit(1).maybeSingle();
      if (existingBlockError) throw existingBlockError;
      if (existingBlock) return respond({ success: true, blocked: true, duplicate: true, databaseChanged: false });
      const { data, error } = await supabase.from("smpn4_exam_blocklist").insert({ student_id: studentId, student_name: studentName, class_name: className, reason, is_blocked: true, blocked_at: new Date().toISOString(), created_at: new Date().toISOString(), unblocked_at: null }).select("block_id").single();
      if (error) throw error;
      return respond({ success: true, blocked: true, databaseChanged: Boolean(data) });
    }

    if (action === "get-public-question-bank") {
      const className = cleanText(body.class_name, 40);
      const subjectName = cleanText(body.subject_name, 120);
      if (!className || !subjectName) return respond({ ok: false, message: "Kelas dan mata pelajaran wajib diisi.", databaseChanged: false }, 400);
      const { data, error } = await supabase.from("smpn4_question_bank_shared")
        .select("question_id,class_name,subject_name,question_type,question_text,options,points,sort_order,is_active,image_urls")
        .eq("class_name", bankClassForClass(className)).eq("subject_name", subjectName).eq("is_active", true)
        .order("sort_order", { ascending: true }).limit(500);
      if (error) throw error;
      const questions = (data ?? []).map((q) => ({
        question_id: q.question_id, type: q.question_type, q: q.question_text,
        opt: Array.isArray(q.options) ? q.options : [], imgs: Array.isArray(q.image_urls) ? q.image_urls : [],
        image_urls: Array.isArray(q.image_urls) ? q.image_urls : [], points: Number(q.points ?? 1), sort_order: q.sort_order,
      }));
      return respond({ ok: true, questions, count: questions.length, databaseChanged: false });
    }

    if (action === "student-start-exam") {
      const studentId = cleanText(body.student_id, 120);
      const studentName = cleanText(body.student_name, 200);
      const className = cleanText(body.class_name, 40);
      const subjectName = cleanText(body.subject_name, 120);
      if (!studentId || !studentName || !className || !subjectName) {
        return respond({ ok: false, message: "Identitas siswa dan mata pelajaran wajib diisi.", databaseChanged: false }, 400);
      }

      const suppliedToken = cleanText(body.token, 200);
      const now = new Date();
      const local = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Makassar" }));
      const dateKey = String(local.getFullYear()) + "-" + String(local.getMonth() + 1).padStart(2, "0") + "-" + String(local.getDate()).padStart(2, "0");

      // Satu RPC hanya menggabungkan pembacaan awal; semua aturan izin tetap ditegakkan di Edge Function.
      const snapshotStarted = performance.now();
      const { data: startSnapshot, error: startSnapshotError } = await supabase.rpc("smpn4_student_start_snapshot", {
        p_student_id: studentId,
        p_student_name: studentName,
        p_class_name: className,
        p_subject_name: subjectName,
        p_date_key: dateKey,
      });
      console.log(JSON.stringify({ event: "student_start_snapshot_timing", duration_ms: Math.round(performance.now() - snapshotStarted) }));
      if (startSnapshotError) throw startSnapshotError;

      const student = startSnapshot?.student ?? null;
      const block = startSnapshot?.block ?? null;
      const settings = startSnapshot?.settings ?? null;
      if (!student || student.is_active !== true || student.student_name !== studentName || student.class_name !== className) {
        return respond({ ok: false, message: "Identitas siswa tidak cocok dengan roster Supabase.", databaseChanged: false }, 403);
      }
      if (block) return respond({ ok: false, blocked: true, message: "Siswa memiliki blokir ujian aktif.", databaseChanged: false }, 403);
      if (!settings || !settings.exam_token || suppliedToken !== settings.exam_token) {
        return respond({ ok: false, message: "Token ujian salah atau belum diatur guru.", databaseChanged: false }, 403);
      }

      const dayStartUtc = new Date(dateKey + "T00:00:00+08:00").toISOString();
      const dayEndUtc = new Date(new Date(dayStartUtc).getTime() + 24 * 60 * 60 * 1000).toISOString();

      // Izin ulang tetap berasal dari dashboard guru, berlaku sekali, dan memiliki masa kedaluwarsa.
      const { data: retakeAuthorization, error: retakeAuthorizationError } = await supabase
        .from("smpn4_exam_retake_authorizations")
        .select("authorization_id,granted_at,expires_at,used_at")
        .eq("student_id", studentId).eq("class_name", className).ilike("subject_name", subjectName)
        .is("used_at", null).gt("expires_at", now.toISOString())
        .order("granted_at", { ascending: false }).limit(1).maybeSingle();
      if (retakeAuthorizationError) throw retakeAuthorizationError;

      const { data: priorSubmission, error: priorSubmissionError } = await supabase.from("smpn4_exam_submissions")
        .select("submission_id,session_id,received_at,status")
        .eq("student_id", studentId).eq("class_name", className).ilike("subject_name", subjectName)
        .gte("received_at", dayStartUtc).lt("received_at", dayEndUtc)
        .order("received_at", { ascending: false }).limit(1).maybeSingle();
      if (priorSubmissionError) throw priorSubmissionError;
      if (priorSubmission && !retakeAuthorization) {
        return respond({ ok: false, already_submitted: true, message: "Anda sudah mengirim jawaban untuk mata pelajaran ini hari ini. Login ulang ditolak. Hubungi guru jika perlu pemeriksaan khusus.", databaseChanged: false }, 409);
      }

      const { data: priorCompletedSession, error: priorCompletedError } = await supabase.from("smpn4_exam_runtime_sessions")
        .select("session_id,started_at,status").eq("student_id", studentId).eq("class_name", className)
        .ilike("subject_name", subjectName).eq("status", "submitted")
        .gte("started_at", dayStartUtc).lt("started_at", dayEndUtc)
        .order("started_at", { ascending: false }).limit(1).maybeSingle();
      if (priorCompletedError) throw priorCompletedError;
      if (priorCompletedSession && !retakeAuthorization) {
        return respond({ ok: false, already_submitted: true, message: "Sesi ujian mata pelajaran ini sudah berstatus terkirim. Login ulang ditolak.", databaseChanged: false }, 409);
      }

      const scheduleObject = settings.schedule && typeof settings.schedule === "object" ? settings.schedule as Record<string, unknown> : {};
      const todaySlots = Array.isArray(scheduleObject[dateKey]) ? scheduleObject[dateKey] as Record<string, unknown>[] : [];
      const minutesNow = local.getHours() * 60 + local.getMinutes();
      const grace = Math.max(0, Math.min(120, Number(settings.login_grace_minutes ?? 20)));
      const slotAllowed = todaySlots.some((slot) => {
        const startTime = String(slot.start ?? "").split(":").map(Number);
        const endTime = String(slot.end ?? "").split(":").map(Number);
        if (startTime.length < 2 || endTime.length < 2 || !Number.isFinite(startTime[0]) || !Number.isFinite(startTime[1]) || !Number.isFinite(endTime[0]) || !Number.isFinite(endTime[1])) return false;
        const subjects = Array.isArray(slot.subjects) ? slot.subjects.map(String) : (slot.subject ? [String(slot.subject)] : []);
        const begin = startTime[0] * 60 + startTime[1];
        const finish = endTime[0] * 60 + endTime[1];
        return minutesNow >= begin && minutesNow <= Math.min(finish, begin + grace) && (!subjects.length || subjects.includes(subjectName));
      });

      const existing = startSnapshot?.existing ?? null;
      let session = existing;
      if (!session) {
        if (!slotAllowed && !retakeAuthorization) {
          return respond({ ok: false, message: "Mata pelajaran ini di luar jadwal ujian yang diizinkan.", databaseChanged: false }, 403);
        }

        const questions = Array.isArray(startSnapshot?.questions) ? startSnapshot.questions as Record<string, unknown>[] : [];
        if (!questions.length) {
          return respond({ ok: false, message: "Bank soal untuk kelas dan mata pelajaran ini masih kosong. Guru perlu membuat atau mengimpor soal terlebih dahulu sebelum ujian dimulai.", databaseChanged: false }, 404);
        }

        const questionSetting = startSnapshot?.question_setting ?? { question_count: 0, selection_mode: "ordered", include_essay: true };
        const selected = questions.filter((q) => questionSetting.include_essay === true || q.question_type !== "essay");
        const pgQuestions = selected.filter((q) => q.question_type !== "essay").sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0));
        const essayQuestions = selected.filter((q) => q.question_type === "essay").sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0));
        if (questionSetting.selection_mode === "random") {
          const shuffle = (items: Record<string, unknown>[]) => {
            for (let i = items.length - 1; i > 0; i--) {
              const random = new Uint32Array(1);
              crypto.getRandomValues(random);
              const j = random[0] % (i + 1);
              [items[i], items[j]] = [items[j], items[i]];
            }
          };
          shuffle(pgQuestions);
          shuffle(essayQuestions);
        }
        let chosenQuestions = [...pgQuestions, ...essayQuestions];
        const configuredCount = Number(questionSetting.question_count ?? 0);
        if (Number.isInteger(configuredCount) && configuredCount > 0) chosenQuestions = chosenQuestions.slice(0, configuredCount);
        if (!chosenQuestions.length) {
          return respond({ ok: false, message: "Tidak ada soal yang sesuai pengaturan. Periksa jumlah soal dan pilihan sertakan esai.", databaseChanged: false }, 400);
        }

        const questionSnapshot = chosenQuestions.map((q, i) => ({
          question_id: q.question_id,
          question_type: q.question_type,
          question_text: q.question_text,
          options: Array.isArray(q.options) ? q.options : [],
          correct_answer: q.correct_answer,
          image_urls: Array.isArray(q.image_urls) ? q.image_urls : [],
          points: Number(q.points ?? 1),
          sort_order: Number(q.sort_order ?? i),
        }));
        const startedAt = now.toISOString();
        const expiresAt = new Date(now.getTime() + 90 * 60 * 1000).toISOString();
        const { data: created, error: createError } = await supabase.from("smpn4_exam_runtime_sessions").insert({
          student_id: studentId,
          student_name: studentName,
          class_name: className,
          subject_name: subjectName,
          started_at: startedAt,
          expires_at: expiresAt,
          status: "active",
          question_snapshot: questionSnapshot,
        }).select("session_id,student_id,student_name,class_name,subject_name,started_at,expires_at,status,violations,question_snapshot").single();

        if (createError && createError.code === "23505") {
          const { data: concurrent, error: concurrentError } = await supabase.from("smpn4_exam_runtime_sessions")
            .select("session_id,student_id,student_name,class_name,subject_name,started_at,expires_at,status,violations,question_snapshot")
            .eq("student_id", studentId).eq("class_name", className).eq("subject_name", subjectName)
            .eq("status", "active").gt("expires_at", new Date().toISOString())
            .order("started_at", { ascending: false }).limit(1).maybeSingle();
          if (concurrentError) throw concurrentError;
          if (!concurrent) throw createError;
          session = concurrent;
        } else if (createError) {
          throw createError;
        } else {
          session = created;
        }
      }

      if (retakeAuthorization && session?.status === "active") {
        const { data: consumed, error: consumeError } = await supabase.from("smpn4_exam_retake_authorizations")
          .update({ used_at: new Date().toISOString(), used_session_id: session.session_id })
          .eq("authorization_id", retakeAuthorization.authorization_id).is("used_at", null)
          .select("authorization_id").maybeSingle();
        if (consumeError) throw consumeError;
        if (!consumed) {
          const { data: currentGrant, error: grantReadError } = await supabase.from("smpn4_exam_retake_authorizations")
            .select("used_session_id").eq("authorization_id", retakeAuthorization.authorization_id).maybeSingle();
          if (grantReadError) throw grantReadError;
          if (currentGrant?.used_session_id !== session.session_id) {
            return respond({ ok: false, message: "Izin ujian ulang sudah digunakan pada sesi lain. Hubungi guru.", databaseChanged: false }, 409);
          }
        }
      }

      const questionSnapshot = Array.isArray(session.question_snapshot) ? session.question_snapshot as Record<string, unknown>[] : [];
      const serverNow = new Date();
      const expiresAtMs = new Date(session.expires_at).getTime();
      const remainingSeconds = Number.isFinite(expiresAtMs) ? Math.max(0, Math.ceil((expiresAtMs - serverNow.getTime()) / 1000)) : 0;
      return respond({
        ok: true,
        session_id: session.session_id,
        started_at: session.started_at,
        expires_at: session.expires_at,
        server_now: serverNow.toISOString(),
        remaining_seconds: remainingSeconds,
        subject_name: session.subject_name,
        class_name: session.class_name,
        violations: Number(session.violations ?? 0),
        questions: questionSnapshot.map((q, i) => publicQuestion(q, i)),
        databaseChanged: !existing,
      });
    }

    // Autosave jawaban siswa: hanya sesi aktif milik siswa yang sama.
    if (action === "student-get-progress" || action === "student-save-progress") {
      const sessionId = cleanText(body.session_id, 80);
      const studentId = cleanText(body.student_id, 120);
      if (!sessionId || !isUuid(sessionId) || !studentId) {
        return respond({ ok: false, message: "Sesi atau identitas siswa tidak valid.", databaseChanged: false }, 400);
      }

      const { data: session, error: sessionError } = await supabase
        .from("smpn4_exam_runtime_sessions")
        .select("session_id,student_id,status,expires_at,question_snapshot")
        .eq("session_id", sessionId)
        .eq("student_id", studentId)
        .maybeSingle();
      if (sessionError) throw sessionError;
      if (!session || session.status !== "active" || new Date(session.expires_at).getTime() <= Date.now()) {
        return respond({ ok: false, message: "Sesi ujian tidak aktif atau sudah berakhir.", databaseChanged: false }, 403);
      }

      if (action === "student-get-progress") {
        const { data: progress, error: progressError } = await supabase
          .from("smpn4_exam_answer_progress")
          .select("answers_pg,answers_essay,revision,updated_at")
          .eq("session_id", sessionId)
          .eq("student_id", studentId)
          .maybeSingle();
        if (progressError) throw progressError;
        return respond({
          ok: true,
          found: Boolean(progress),
          answers_pg: Array.isArray(progress?.answers_pg) ? progress.answers_pg : [],
          answers_essay: Array.isArray(progress?.answers_essay) ? progress.answers_essay : [],
          revision: Number(progress?.revision ?? 0),
          updated_at: progress?.updated_at ?? null,
          databaseChanged: false,
        });
      }

      const snapshot = Array.isArray(session.question_snapshot) ? session.question_snapshot as Record<string, unknown>[] : [];
      if (!snapshot.length) return respond({ ok: false, message: "Snapshot soal sesi tidak tersedia.", databaseChanged: false }, 409);
      const rawPg = Array.isArray(body.answers_pg) ? body.answers_pg : [];
      const rawEssay = Array.isArray(body.answers_essay) ? body.answers_essay : [];
      const revision = Number(body.revision);
      if (rawPg.length > snapshot.length || rawEssay.length > snapshot.length ||
          !Number.isSafeInteger(revision) || revision < 1 || revision > 2147483647) {
        return respond({ ok: false, message: "Format jawaban atau nomor revisi autosave tidak valid.", databaseChanged: false }, 400);
      }

      const answersPg: (number | null)[] = [];
      const answersEssay: string[] = [];
      for (let i = 0; i < snapshot.length; i++) {
        const question = snapshot[i];
        if (question.question_type === "essay") {
          const raw = rawEssay[i] ?? "";
          if (typeof raw !== "string" || raw.length > 20000) {
            return respond({ ok: false, message: `Jawaban esai nomor ${i + 1} tidak valid atau melebihi batas.`, databaseChanged: false }, 400);
          }
          answersPg.push(null);
          answersEssay.push(raw);
        } else {
          const raw = rawPg[i];
          if (raw === null || raw === undefined || raw === "") {
            answersPg.push(null);
          } else {
            const answerIndex = Number(raw);
            const options = Array.isArray(question.options) ? question.options : [];
            if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= options.length) {
              return respond({ ok: false, message: `Pilihan jawaban nomor ${i + 1} tidak valid.`, databaseChanged: false }, 400);
            }
            answersPg.push(answerIndex);
          }
          answersEssay.push("");
        }
      }

      const { data: saved, error: saveError } = await supabase.rpc("smpn4_save_exam_answer_progress", {
        p_session_id: sessionId,
        p_student_id: studentId,
        p_answers_pg: answersPg,
        p_answers_essay: answersEssay,
        p_revision: revision,
      });
      if (saveError) throw saveError;
      const result = saved && typeof saved === "object" ? saved as Record<string, unknown> : {};
      if (result.saved !== true) {
        const { data: currentProgress, error: currentProgressError } = await supabase
          .from("smpn4_exam_answer_progress")
          .select("student_id,answers_pg,answers_essay,revision,updated_at")
          .eq("session_id", sessionId)
          .maybeSingle();
        if (currentProgressError) throw currentProgressError;
        if (!currentProgress || currentProgress.student_id !== studentId) {
          return respond({ ok: false, message: "Progres jawaban tidak dapat diverifikasi.", databaseChanged: false }, 409);
        }
        const sameRevisionAndPayload = Number(currentProgress.revision) === revision &&
          JSON.stringify(currentProgress.answers_pg) === JSON.stringify(answersPg) &&
          JSON.stringify(currentProgress.answers_essay) === JSON.stringify(answersEssay);
        if (!sameRevisionAndPayload) {
          return respond({ ok: true, saved: false, stale: true, revision: Number(currentProgress.revision), updated_at: currentProgress.updated_at ?? null, databaseChanged: false });
        }
        return respond({ ok: true, saved: true, revision: Number(currentProgress.revision), updated_at: currentProgress.updated_at ?? null, databaseChanged: false });
      }
      return respond({ ok: true, saved: true, revision: Number(result.revision ?? revision), updated_at: result.updated_at ?? new Date().toISOString(), databaseChanged: true });
    }

    if (action === "student-submit-exam") {
      const sessionId = cleanText(body.session_id, 80);
      const submissionId = cleanText(body.submission_id, 160);
      const studentId = cleanText(body.student_id, 120);
      if (!sessionId || !isUuid(sessionId) || !submissionId || !studentId) {
        return respond({ ok: false, message: "session_id, submission_id, dan student_id wajib valid.", databaseChanged: false }, 400);
      }

      // Satu RPC mengambil status submission lama dan snapshot sesi untuk penilaian.
      const { data: context, error: contextError } = await supabase.rpc("smpn4_submission_context", {
        p_submission_id: submissionId,
        p_session_id: sessionId,
        p_student_id: studentId,
      });
      if (contextError) throw contextError;

      const already = context?.already ?? context?.by_session ?? null;
      if (already) {
        if (already.student_id !== studentId || already.session_id !== sessionId) {
          return respond({ ok: false, message: "Submission ID sudah digunakan untuk sesi lain.", databaseChanged: false }, 409);
        }
        const mirrorTask = processSheetMirrorQueue(supabase);
        if (!scheduleBackground(mirrorTask)) await mirrorTask;
        return respond({
          ok: true, duplicate: true, submission_id: already.submission_id, score: already.score,
          correct: already.correct_count, total: already.total_pg, essay_count: already.essay_count,
          max_score: Number((already.result_payload as Record<string, unknown> | null)?.maxScore ?? 0),
          score_scale: cleanText((already.result_payload as Record<string, unknown> | null)?.scoreScale, 40) || "legacy-percent",
          status: already.status, sheet_mirror_status: already.sheet_mirror_status, databaseChanged: false,
        });
      }

      const session = context?.session ?? null;
      if (!session || session.status !== "active" || new Date(session.expires_at).getTime() < Date.now()) {
        return respond({ ok: false, message: "Sesi ujian tidak valid atau sudah berakhir.", databaseChanged: false }, 403);
      }

      const snapshot = Array.isArray(session.question_snapshot) ? session.question_snapshot as Record<string, unknown>[] : [];
      if (!snapshot.length) return respond({ ok: false, message: "Snapshot soal sesi tidak ditemukan.", databaseChanged: false }, 409);

      const rawPg = parseArray(body.answers_pg);
      const rawEssay = parseArray(body.answers_essay);
      const pgAnswers: (number | null)[] = [];
      const essayAnswers: string[] = [];
      for (let i = 0; i < snapshot.length; i++) {
        const q = snapshot[i];
        if (q.question_type === "essay") {
          const a = rawEssay[i] ?? "";
          if (typeof a !== "string" || a.length > 20000) return respond({ ok:false, message:"Jawaban esai tidak valid.", databaseChanged:false },400);
          pgAnswers.push(null); essayAnswers.push(a);
        } else {
          const a = rawPg[i];
          if (a === null || a === undefined || a === "") pgAnswers.push(null);
          else { const n = Number(a); const opts = Array.isArray(q.options) ? q.options : []; if (!Number.isInteger(n) || n < 0 || n >= opts.length) return respond({ok:false,message:"Pilihan jawaban tidak valid.",databaseChanged:false},400); pgAnswers.push(n); }
          essayAnswers.push("");
        }
      }
      let totalPg = 0, correctCount = 0, essayCount = 0;
      let totalPgPoints = 0, earnedPgPoints = 0;
      snapshot.forEach((q, index) => {
        if (q.question_type === "pg") {
          totalPg++;
          const rawPoints = Number(q.points ?? 1);
          const questionPoints = Number.isFinite(rawPoints) && rawPoints > 0 ? rawPoints : 1;
          totalPgPoints += questionPoints;
          const key = correctOptionIndex(q);
          const answer = Number(pgAnswers[index]);
          if (Number.isInteger(key) && key >= 0 && answer === key) {
            correctCount++;
            earnedPgPoints += questionPoints;
          }
        } else if (q.question_type === "essay") {
          essayCount++;
        }
      });

      const score = Number(earnedPgPoints.toFixed(2));
      const receivedAt = new Date().toISOString();
      const resultPayload = {
        studentId: session.student_id, name: session.student_name, class: session.class_name,
        subject: session.subject_name, score, earnedPgPoints: score, totalPgPoints: Number(totalPgPoints.toFixed(2)),
        maxScore: Number(totalPgPoints.toFixed(2)), scoreScale: "weighted-points",
        violations: Number(session.violations ?? 0),
        session: session.session_id, submissionId, answersPG: JSON.stringify(pgAnswers),
        answersEssay: JSON.stringify(essayAnswers), time: receivedAt,
        sessionCreatedAt: new Date(session.started_at).getTime(),
        correct: correctCount, total: totalPg, status: essayCount ? "review_required" : "processed",
      };

      // Satu transaksi database menyimpan hasil dan menutup sesi secara atomik.
      const { data: committed, error: commitError } = await supabase.rpc("smpn4_commit_exam_submission", {
        p_submission: {
          submission_id: submissionId,
          session_id: session.session_id,
          student_id: session.student_id,
          answers_pg: pgAnswers,
          answers_essay: essayAnswers,
          score,
          correct_count: correctCount,
          total_pg: totalPg,
          essay_count: essayCount,
          violations: Number(session.violations ?? 0),
          status: essayCount ? "review_required" : "processed",
          received_at: receivedAt,
          result_payload: resultPayload,
        },
      });
      if (commitError) throw commitError;

      if (committed?.outcome === "invalid_session") {
        return respond({ ok: false, message: "Sesi ujian tidak valid atau sudah berakhir.", databaseChanged: false }, 403);
      }
      if (committed?.outcome === "submission_conflict") {
        return respond({ ok: false, message: "Submission ID sudah dipakai untuk sesi lain.", databaseChanged: false }, 409);
      }
      if (committed?.outcome === "invalid_input" || !committed?.submission) {
        return respond({ ok: false, message: "Data pengiriman jawaban tidak valid.", databaseChanged: false }, 400);
      }

      const saved = committed.submission as Record<string, unknown>;
      const duplicate = committed.outcome === "duplicate";
      const mirrorTask = processSheetMirrorQueue(supabase);
      if (!scheduleBackground(mirrorTask)) await mirrorTask;

      return respond({
        ok: true,
        duplicate,
        submission_id: saved.submission_id,
        score: saved.score,
        max_score: Number((saved.result_payload as Record<string, unknown> | null)?.maxScore ?? 0),
        score_scale: cleanText((saved.result_payload as Record<string, unknown> | null)?.scoreScale, 40) || "weighted-points",
        correct: saved.correct_count,
        total: saved.total_pg,
        essay_count: saved.essay_count,
        status: saved.status,
        sheet_mirror_status: saved.sheet_mirror_status,
        message: duplicate ? "Jawaban sebelumnya sudah tercatat." : "Jawaban sudah diterima dan nilai pilihan ganda dihitung oleh server Supabase.",
        databaseChanged: !duplicate,
      });
    }

    if (action === "student-verify-submission") {
      const submissionId = cleanText(body.submission_id, 160);
      const studentId = cleanText(body.student_id, 120);
      if (!submissionId || !studentId) return respond({ ok: false, message: "Parameter verifikasi tidak lengkap.", databaseChanged: false }, 400);
      const { data, error } = await supabase.from("smpn4_exam_submissions")
        .select("submission_id,student_id,subject_name,score,correct_count,total_pg,essay_count,status,sheet_mirror_status,received_at,result_payload")
        .eq("submission_id", submissionId).eq("student_id", studentId).maybeSingle();
      if (error) throw error;
      if (!data) return respond({ ok: true, found: false, databaseChanged: false });
      return respond({ ok: true, found: true, submission_id: data.submission_id, subject_name: data.subject_name,
        score: data.score, max_score: Number((data.result_payload as Record<string, unknown> | null)?.maxScore ?? 0),
        score_scale: cleanText((data.result_payload as Record<string, unknown> | null)?.scoreScale, 40) || "legacy-percent",
        correct: data.correct_count, total: data.total_pg, essay_count: data.essay_count,
        status: data.status, sheet_mirror_status: data.sheet_mirror_status, received_at: data.received_at, databaseChanged: false });
    }

    // Endpoint siswa yang sudah berjalan dipertahankan.
    if (action === "get-public-schedule") {
      const { data, error } = await supabase
        .from("smpn4_exam_settings")
        .select("schedule, login_grace_minutes, updated_at")
        .eq("id", 1)
        .maybeSingle();

      if (error) throw error;
      if (!data) {
        return respond({
          ok: false,
          message: "Konfigurasi ujian belum tersedia.",
          databaseChanged: false,
        }, 404);
      }

      return respond({
        ok: true,
        timezone: "Asia/Makassar",
        schedule: data.schedule,
        loginGraceMinutes: data.login_grace_minutes,
        updatedAt: data.updated_at,
        databaseChanged: false,
      });
    }

    if (action === "validate-student") {
      const studentId = cleanText(body.student_id, 120);
      const studentName = cleanText(body.student_name, 200);
      const className = cleanText(body.class_name, 40);

      if (!studentId || !studentName || !className) {
        return respond({
          ok: false,
          valid: false,
          message: "ID, nama, dan kelas wajib diisi.",
          databaseChanged: false,
        }, 400);
      }

      const { data: student, error } = await supabase
        .from("smpn4_student_roster")
        .select("student_id, student_name, class_name, is_active")
        .eq("student_id", studentId)
        .maybeSingle();

      if (error) throw error;

      const valid = Boolean(
        student &&
        student.is_active === true &&
        student.student_name === studentName &&
        student.class_name === className
      );

      return respond({
        ok: true,
        valid,
        message: valid
          ? "Data siswa cocok."
          : "Nama atau kelas tidak cocok dengan roster.",
        student: valid
          ? {
            student_id: student!.student_id,
            student_name: student!.student_name,
            class_name: student!.class_name,
          }
          : null,
        databaseChanged: false,
      });
    }

    if (action === "check-blacklist") {
      const studentId = cleanText(body.student_id, 120);
      const studentName = cleanText(body.student_name, 200);
      const className = cleanText(body.class_name, 40);

      if (!studentId || !studentName || !className) {
        return respond({
          ok: false,
          message: "ID, nama, dan kelas wajib diisi.",
          databaseChanged: false,
        }, 400);
      }

      const { data: student, error: rosterError } = await supabase
        .from("smpn4_student_roster")
        .select("student_id, student_name, class_name, is_active")
        .eq("student_id", studentId)
        .maybeSingle();

      if (rosterError) throw rosterError;

      const identityValid = Boolean(
        student &&
        student.is_active === true &&
        student.student_name === studentName &&
        student.class_name === className
      );

      if (!identityValid) {
        return respond({
          ok: true,
          valid: false,
          blocked: false,
          message: "Identitas siswa tidak cocok dengan roster.",
          databaseChanged: false,
        });
      }

      const { data: block, error: blockError } = await supabase
        .from("smpn4_exam_blocklist")
        .select("reason, blocked_at")
        .eq("student_id", studentId)
        .eq("is_blocked", true)
        .is("unblocked_at", null)
        .limit(1)
        .maybeSingle();

      if (blockError) throw blockError;

      return respond({
        ok: true,
        valid: true,
        blocked: Boolean(block),
        message: block
          ? "Siswa memiliki blokir aktif."
          : "Tidak ada blokir aktif.",
        databaseChanged: false,
      });
    }

    // Login PIN guru. Token sesi mentah hanya dikembalikan sekali;
    // database hanya menyimpan hash token, bukan token aslinya.
    if (action === "teacher-login") {
      if (!teacherPin) {
        return respond({
          ok: false,
          message: "Secret SMPN4_TEACHER_PIN belum dikonfigurasi.",
          databaseChanged: false,
        }, 500);
      }

      const pin = cleanText(body.pin, 200);
      if (!pin || !safeEqual(pin, teacherPin)) {
        return respond({
          ok: false,
          message: "PIN guru tidak valid.",
          databaseChanged: false,
        }, 401);
      }

      const token = randomToken();
      const sessionHash = await sha256(token);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      const { error } = await supabase
        .from("smpn4_teacher_sessions")
        .insert({
          session_hash: sessionHash,
          expires_at: expiresAt,
          revoked_at: null,
        });

      if (error) throw error;

      return respond({
        ok: true,
        session_token: token,
        expires_at: expiresAt,
        expires_in_minutes: 60,
        databaseChanged: true,
      });
    }

    // Jadwal publik untuk Index Siswa. Hanya mengembalikan jadwal dan toleransi login;
    // tidak membocorkan token ujian, data siswa, atau data guru.
    if (action === "get-public-schedule") {
      const { data, error } = await supabase
        .from("smpn4_exam_settings")
        .select("schedule,login_grace_minutes,updated_at")
        .eq("id", 1)
        .maybeSingle();
      if (error) throw error;
      if (!data) return respond({ ok: false, success: false, message: "Pengaturan jadwal ujian belum tersedia." }, 404);
      return respond({
        ok: true, success: true, schedule: data.schedule && typeof data.schedule === "object" ? data.schedule : {},
        minutes: data.login_grace_minutes, loginGraceMinutes: data.login_grace_minutes,
        updated_at: data.updated_at, databaseChanged: false,
      });
    }

    // Semua aksi guru selain login harus menyertakan session_token di body.
    const teacherActions = new Set([
      "teacher-verify-session",
      "teacher-logout",
      "question-list",
      "question-create",
      "question-update",
      "question-disable",
      "get-token", "set-token", "get-schedule", "save-schedule-settings", "reset-schedule",
      "get-active-exam-sessions", "get-results", "get-blacklist", "allow-student", "get-today-attendance",
      "get-question-settings", "save-question-settings", "upload-question-image",
      "getBankSoal", "getArchivedBankSoal", "saveBankSoal", "deleteBankSoal", "restoreBankSoal", "importBankSoalBatch", "syncAllBankSoalToSupabase",
    ]);

    if (teacherActions.has(action)) {
      const token = cleanText(body.session_token, 200);
      if (!token) {
        return respond({
          ok: false,
          authRequired: true,
          message: "Sesi guru wajib disertakan.",
          databaseChanged: false,
        }, 401);
      }

      const sessionHash = await sha256(token);
      const now = new Date().toISOString();
      const { data: session, error: sessionError } = await supabase
        .from("smpn4_teacher_sessions")
        .select("session_hash, expires_at, revoked_at")
        .eq("session_hash", sessionHash)
        .is("revoked_at", null)
        .gt("expires_at", now)
        .maybeSingle();

      if (sessionError) throw sessionError;
      if (!session) {
        return respond({
          ok: false,
          authRequired: true,
          message: "Sesi guru tidak valid atau sudah berakhir. Silakan login kembali.",
          databaseChanged: false,
        }, 401);
      }

      if (action === "teacher-verify-session") {
        return respond({
          ok: true,
          valid: true,
          expires_at: session.expires_at,
          databaseChanged: false,
        });
      }

      if (action === "teacher-logout") {
        const { error } = await supabase
          .from("smpn4_teacher_sessions")
          .update({ revoked_at: new Date().toISOString() })
          .eq("session_hash", sessionHash)
          .is("revoked_at", null);

        if (error) throw error;
        return respond({ ok: true, message: "Sesi guru telah diakhiri.", databaseChanged: true });
      }

      if (action === "upload-question-image") {
        try {
          const uploaded = await uploadQuestionImage(supabase, body);
          return respond({ ok: true, success: true, ...uploaded, databaseChanged: true });
        } catch (uploadError) {
          const message = uploadError && typeof uploadError === "object" && "message" in uploadError ? String((uploadError as {message:unknown}).message) : String(uploadError);
          return respond({ ok: false, success: false, message, databaseChanged: false }, 400);
        }
      }

      // Dashboard Guru runtime actions: all data is read/written in Supabase.
      if (action === "get-token") {
        const { data, error } = await supabase.from("smpn4_exam_settings").select("exam_token").eq("id", 1).maybeSingle();
        if (error) throw error;
        return respond({ ok: true, success: true, token: data?.exam_token ?? "", databaseChanged: false });
      }
      if (action === "set-token") {
        const token = cleanText(body.token, 100);
        if (!token) return respond({ ok: false, success: false, message: "Token tidak boleh kosong.", databaseChanged: false }, 400);
        const { data, error } = await supabase.from("smpn4_exam_settings").update({ exam_token: token, updated_at: new Date().toISOString() }).eq("id", 1).select("exam_token").maybeSingle();
        if (error) throw error;
        if (!data) return respond({ ok: false, success: false, message: "Baris pengaturan ujian id=1 tidak ditemukan.", databaseChanged: false }, 404);
        return respond({ ok: true, success: true, token: data.exam_token, databaseChanged: true });
      }
      if (action === "get-schedule") {
        const { data, error } = await supabase.from("smpn4_exam_settings").select("schedule,login_grace_minutes,updated_at").eq("id", 1).maybeSingle();
        if (error) throw error;
        if (!data) return respond({ ok: false, success: false, message: "Pengaturan ujian belum tersedia." }, 404);
        return respond({ ok: true, success: true, schedule: data.schedule, minutes: data.login_grace_minutes, loginGraceMinutes: data.login_grace_minutes, updated_at: data.updated_at, databaseChanged: false });
      }
      if (action === "reset-schedule") {
        const { data, error } = await supabase.from("smpn4_exam_settings").select("schedule,login_grace_minutes").eq("id", 1).maybeSingle();
        if (error) throw error;
        if (!data) return respond({ ok: false, success: false, message: "Pengaturan ujian id=1 tidak ditemukan." }, 404);
        return respond({ ok: true, success: true, schedule: data.schedule, minutes: data.login_grace_minutes, unchanged: true, message: "Jadwal aktif dipertahankan; jadwal default tidak dikonfigurasi sehingga tidak ada data yang dihapus.", databaseChanged: false });
      }
      if (action === "save-schedule-settings") {
        const schedule = body.schedule;
        const minutes = Number(body.minutes ?? body.login_grace_minutes ?? 20);
        if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) return respond({ ok: false, success: false, message: "Format jadwal harus berupa objek JSON." }, 400);
        if (!Number.isInteger(minutes) || minutes < 0 || minutes > 120) return respond({ ok: false, success: false, message: "Toleransi login harus 0 sampai 120 menit." }, 400);
        const { data, error } = await supabase.from("smpn4_exam_settings").update({ schedule, login_grace_minutes: minutes, updated_at: new Date().toISOString() }).eq("id", 1).select("schedule,login_grace_minutes").maybeSingle();
        if (error) throw error;
        if (!data) return respond({ ok: false, success: false, message: "Pengaturan ujian id=1 tidak ditemukan." }, 404);
        return respond({ ok: true, success: true, schedule: data.schedule, minutes: data.login_grace_minutes, databaseChanged: true });
      }
      if (action === "get-active-exam-sessions") {
        const { data, error } = await supabase.from("smpn4_exam_runtime_sessions").select("session_id,student_id,student_name,class_name,subject_name,started_at,expires_at,status,violations,created_at").eq("status", "active").order("started_at", { ascending: false }).limit(500);
        if (error) throw error;
        const sessions = (data ?? []).map((x) => ({ session: x.session_id, session_id: x.session_id, studentId: x.student_id, student_id: x.student_id, name: x.student_name, student_name: x.student_name, class: x.class_name, class_name: x.class_name, subject: x.subject_name, subject_name: x.subject_name, startTime: x.started_at, started_at: x.started_at, expiresAt: x.expires_at, status: x.status, violations: x.violations }));
        const { count } = await supabase.from("smpn4_student_roster").select("student_id", { count: "exact", head: true }).eq("is_active", true);
        return respond({ ok: true, success: true, sessions, rosterCount: count ?? 0, databaseChanged: false });
      }
      if (action === "get-results") {
        const data: any[] = [];
        const resultPageSize = 500;
        for (let offset = 0; offset < 10000; offset += resultPageSize) {
          const { data: page, error } = await supabase.from("smpn4_exam_submissions")
            .select("submission_id,session_id,student_id,student_name,class_name,subject_name,answers_pg,answers_essay,score,correct_count,total_pg,essay_count,violations,status,received_at,processed_at,result_payload")
            .order("received_at", { ascending: false }).range(offset, offset + resultPageSize - 1);
          if (error) throw error;
          data.push(...(page ?? []));
          if (!page || page.length < resultPageSize) break;
        }
        const results = (data ?? []).map((x) => {
          const payload = x.result_payload && typeof x.result_payload === "object" ? x.result_payload as Record<string, unknown> : {};
          // Kolom answers_essay adalah sumber utama. Bila kosong/null pada baris lama,
          // coba payload lama yang menyimpan jawaban sebagai JSON string.
          const essayFromColumn = parseArray(x.answers_essay);
          const essayFromPayload = parseArray(payload.essayAnswers ?? payload.answers_essay ?? payload.answersEssay ?? payload.answer_essay);
          const essayAnswersRaw = essayFromColumn.some((v) => v !== null && v !== undefined && String(v).trim() !== "")
            ? essayFromColumn : essayFromPayload;
          const essayAnswers = extractEssayAnswersOnly(essayAnswersRaw);
          const startRaw = payload.startTime ?? payload.start_time ?? payload.started_at ?? payload.startedAt ?? payload.sessionStartedAt ?? payload.sessionCreatedAt;
          const startTime = typeof startRaw === "number" && Number.isFinite(startRaw)
            ? new Date(startRaw).toISOString()
            : (typeof startRaw === "string" && startRaw.trim() ? startRaw : null);
          return {
            ...payload,
            studentId: x.student_id, name: x.student_name, student_name: x.student_name,
            class: x.class_name, class_name: x.class_name,
            subject: x.subject_name, subject_name: x.subject_name,
            score: x.score ?? 0, violations: x.violations,
            session: x.session_id, session_id: x.session_id,
            submissionId: x.submission_id, submission_id: x.submission_id,
            time: x.received_at, received_at: x.received_at,
            startTime, started_at: startTime,
            answersPG: JSON.stringify(x.answers_pg ?? []), answers_pg: x.answers_pg ?? [],
            // Kirim kedua bentuk: array terstruktur untuk dashboard dan JSON string untuk kompatibilitas lama.
            essayAnswers, answers_essay: essayAnswers, answersEssay: JSON.stringify(essayAnswers),
            serverVerified: true, server_verified: true, status: x.status,
            correct: x.correct_count, total: x.total_pg, essay_count: x.essay_count,
            max_score: Number(payload.maxScore ?? payload.totalPgPoints ?? 0),
            score_scale: cleanText(payload.scoreScale, 40) || "legacy-percent",
          };
        });
        return respond({ ok: true, success: true, results, data: results, databaseChanged: false });
      }
      if (action === "get-blacklist") {
        const { data, error } = await supabase.from("smpn4_exam_blocklist").select("block_id,student_id,student_name,class_name,reason,is_blocked,blocked_at,unblocked_at,created_at").order("blocked_at", { ascending: false }).limit(1000);
        if (error) throw error;
        const blacklist = (data ?? []).map((x) => ({ id: x.block_id, studentId: x.student_id, student_id: x.student_id, name: x.student_name, student_name: x.student_name, class: x.class_name, class_name: x.class_name, reason: x.reason, blocked: x.is_blocked && !x.unblocked_at, status: x.is_blocked && !x.unblocked_at ? "DIBLOKIR" : "DIIZINKAN", blockedAt: x.blocked_at, violations: 3 }));
        return respond({ ok: true, success: true, blacklist, databaseChanged: false });
      }
      if (action === "allow-student") {
        const studentId = cleanText(body.student_id ?? body.studentId, 120);
        if (!studentId) return respond({ ok: false, success: false, message: "ID siswa wajib diisi." }, 400);

        // Ambil kelas dari catatan blokir aktif sebelum mengubah statusnya.
        const { data: activeBlock, error: activeBlockError } = await supabase.from("smpn4_exam_blocklist")
          .select("block_id,class_name").eq("student_id", studentId).eq("is_blocked", true)
          .is("unblocked_at", null).limit(1).maybeSingle();
        if (activeBlockError) throw activeBlockError;
        // Dukung guru yang sudah lebih dulu membuka blokir sebelum fitur izin ulang tersedia:
        // klik IZINKAN kembali tetap dapat menerbitkan izin ulang dari riwayat blokir terakhir.
        const { data: latestBlockHistory, error: latestBlockHistoryError } = activeBlock
          ? { data: null, error: null }
          : await supabase.from("smpn4_exam_blocklist").select("block_id,class_name")
              .eq("student_id", studentId).order("blocked_at", { ascending: false }).limit(1).maybeSingle();
        if (latestBlockHistoryError) throw latestBlockHistoryError;
        const blockContext = activeBlock || latestBlockHistory;

        let retakeAuthorized = false;
        const retakeSubjects: string[] = [];
        if (blockContext?.class_name) {
          // Jangan hanya melihat sesi terakhir: siswa mungkin sudah mengikuti mapel
          // lain setelah sesi yang terkirim. Izin guru harus cocok dengan setiap
          // sesi submitted hari ini yang akan ditolak oleh pengaman login ulang.
          const now = new Date();
          const local = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Makassar" }));
          const dateKey = `${local.getFullYear()}-${String(local.getMonth()+1).padStart(2,"0")}-${String(local.getDate()).padStart(2,"0")}`;
          const dayStartUtc = new Date(`${dateKey}T00:00:00+08:00`).toISOString();
          const dayEndUtc = new Date(new Date(dayStartUtc).getTime() + 24*60*60*1000).toISOString();
          // Sinkronkan dua sumber bukti penyelesaian. Submit menyimpan jawaban
          // terlebih dahulu, lalu menutup runtime session; jika langkah penutupan
          // gagal, status runtime dapat tertinggal "active" walaupun jawaban sudah ada.
          const [sessionHistory, submissionHistory] = await Promise.all([
            supabase.from("smpn4_exam_runtime_sessions")
              .select("subject_name").eq("student_id", studentId).eq("class_name", blockContext.class_name)
              .eq("status", "submitted").gte("started_at", dayStartUtc).lt("started_at", dayEndUtc),
            supabase.from("smpn4_exam_submissions")
              .select("subject_name").eq("student_id", studentId).eq("class_name", blockContext.class_name)
              .gte("received_at", dayStartUtc).lt("received_at", dayEndUtc),
          ]);
          if (sessionHistory.error) throw sessionHistory.error;
          if (submissionHistory.error) throw submissionHistory.error;
          const subjects = [...new Set([
            ...(sessionHistory.data ?? []).map((x) => cleanText(x.subject_name, 120)),
            ...(submissionHistory.data ?? []).map((x) => cleanText(x.subject_name, 120)),
          ].filter(Boolean))];
          for (const subject of subjects) {
            const grantExpiry = new Date(Date.now() + 24*60*60*1000).toISOString();
            const { data: pendingGrant, error: pendingGrantError } = await supabase.from("smpn4_exam_retake_authorizations")
              .select("authorization_id").eq("student_id", studentId).eq("class_name", blockContext.class_name)
              .ilike("subject_name", subject).is("used_at", null).limit(1).maybeSingle();
            if (pendingGrantError) throw pendingGrantError;
            if (pendingGrant) {
              const { error: refreshGrantError } = await supabase.from("smpn4_exam_retake_authorizations")
                .update({ granted_at: new Date().toISOString(), granted_by_session_hash: sessionHash, expires_at: grantExpiry })
                .eq("authorization_id", pendingGrant.authorization_id).is("used_at", null);
              if (refreshGrantError) throw refreshGrantError;
            } else {
              const { error: createGrantError } = await supabase.from("smpn4_exam_retake_authorizations").insert({
                student_id: studentId, class_name: blockContext.class_name, subject_name: subject,
                granted_at: new Date().toISOString(), granted_by_session_hash: sessionHash, expires_at: grantExpiry,
              });
              if (createGrantError && createGrantError.code !== "23505") throw createGrantError;
            }
            retakeSubjects.push(subject);
          }
          retakeAuthorized = retakeSubjects.length > 0;
        }

        const { data, error } = await supabase.from("smpn4_exam_blocklist")
          .update({ is_blocked: false, unblocked_at: new Date().toISOString() })
          .eq("student_id", studentId).eq("is_blocked", true).is("unblocked_at", null).select("block_id");
        if (error) throw error;
        return respond({ ok: true, success: true, blocked: false, status: "DIIZINKAN",
          updated: data?.length ?? 0, retake_authorized: retakeAuthorized, retake_subjects: retakeSubjects,
          message: retakeAuthorized ? `Blokir dicabut dan satu kali ujian ulang diizinkan untuk: ${retakeSubjects.join(", ")}.` : "Blokir dicabut. Tidak ditemukan sesi terkirim hari ini; sesi aktif dapat dilanjutkan.",
          databaseChanged: Boolean(data?.length) || retakeAuthorized });
      }
      if (action === "get-today-attendance") {
        const today = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Makassar" }));
        const start = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - 8 * 3600000).toISOString();
        const end = new Date(new Date(start).getTime() + 86400000).toISOString();
        const { data, error } = await supabase.from("smpn4_exam_runtime_sessions").select("student_id").gte("started_at", start).lt("started_at", end);
        if (error) throw error;
        const { count, error: rosterError } = await supabase.from("smpn4_student_roster").select("student_id", { count: "exact", head: true }).eq("is_active", true);
        if (rosterError) throw rosterError;
        return respond({ ok: true, success: true, count: new Set((data ?? []).map((x) => x.student_id)).size, total: count ?? 177, date: today.toISOString().slice(0, 10), databaseChanged: false });
      }
      // Pengaturan jumlah, urutan, dan esai untuk setiap kombinasi kelas/mapel.
      if (action === "get-question-settings") {
        const cls = cleanText(body.class_name ?? body.className, 40);
        const subject = cleanText(body.subject_name ?? body.subject, 120).toLowerCase();
        const allowedClasses = new Set(["7.1", "7.2", "7.3", "8.1", "8.2", "9.1", "9.2"]);
        if (!allowedClasses.has(cls) || !subject) return respond({ ok: false, success: false, message: "Kelas dan mata pelajaran wajib valid." }, 400);
        const { data, error } = await supabase.from("smpn4_question_settings")
          .select("class_name,subject_name,question_count,selection_mode,include_essay,updated_at")
          .eq("class_name", bankClassForClass(cls)).eq("subject_name", subject).maybeSingle();
        if (error) throw error;
        return respond({
          ok: true, success: true, exists: Boolean(data),
          question_count: Number(data?.question_count ?? 0),
          selection_mode: data?.selection_mode || "ordered",
          // Default true agar perilaku lama (semua soal termasuk esai) tidak berubah.
          include_essay: data ? data.include_essay === true : true,
          updated_at: data?.updated_at ?? null, databaseChanged: false,
        });
      }
      if (action === "save-question-settings") {
        const cls = cleanText(body.class_name ?? body.className, 40);
        const subject = cleanText(body.subject_name ?? body.subject, 120).toLowerCase();
        const questionCount = Number(body.question_count ?? body.questionCount ?? 0);
        const selectionMode = cleanText(body.selection_mode ?? body.selectionMode ?? "ordered", 20);
        const includeEssay = body.include_essay === true || body.includeEssay === true;
        const allowedClasses = new Set(["7.1", "7.2", "7.3", "8.1", "8.2", "9.1", "9.2"]);
        if (!allowedClasses.has(cls) || !subject) return respond({ ok: false, success: false, saved: false, message: "Kelas dan mata pelajaran wajib valid." }, 400);
        if (!Number.isInteger(questionCount) || questionCount < 0 || questionCount > 1000) return respond({ ok: false, success: false, saved: false, message: "Jumlah soal harus 0 sampai 1.000." }, 400);
        if (!["ordered", "random"].includes(selectionMode)) return respond({ ok: false, success: false, saved: false, message: "Urutan soal tidak valid." }, 400);
        const { data, error } = await supabase.from("smpn4_question_settings").upsert({
          class_name: bankClassForClass(cls), subject_name: subject, question_count: questionCount,
          selection_mode: selectionMode, include_essay: includeEssay, updated_at: new Date().toISOString(),
        }, { onConflict: "class_name,subject_name" })
          .select("class_name,subject_name,question_count,selection_mode,include_essay,updated_at").single();
        if (error) throw error;
        return respond({ ok: true, success: true, saved: true, ...data, databaseChanged: true });
      }

      // Compatibility adapters for the existing bank editor; records stay in Supabase.
      if (action === "getArchivedBankSoal") {
        const cls = cleanText(body.class_name ?? body.className, 40);
        const subject = cleanText(body.subject_name ?? body.subject, 120);
        let query = supabase.from("smpn4_question_bank_archive_20261103")
          .select("question_id,class_name,subject_name,question_type,question_text,options,points,sort_order,is_active,image_urls,created_at,updated_at")
          .order("class_name", { ascending: true }).order("subject_name", { ascending: true }).order("sort_order", { ascending: true }).limit(1000);
        if (cls) query = query.eq("class_name", cls);
        if (subject) query = query.eq("subject_name", subject);
        const { data, error } = await query;
        if (error) throw error;
        return respond({ ok: true, success: true, questions: data ?? [], count: data?.length ?? 0, read_only: true, databaseChanged: false });
      }

      if (action === "getBankSoal") {
        const cls = cleanText(body.class_name ?? body.className, 40);
        const subject = cleanText(body.subject_name ?? body.subject, 120);
        let query = supabase.from("smpn4_question_bank_shared").select("question_id,class_name,subject_name,question_type,question_text,options,correct_answer,points,sort_order,is_active,image_urls,created_at,updated_at").order("sort_order", { ascending: true }).limit(1000);
        if (cls) query = query.eq("class_name", bankClassForClass(cls));
        if (subject) query = query.eq("subject_name", subject);
        if (body.includeInactive !== true) query = query.eq("is_active", true);
        const { data, error } = await query;
        if (error) throw error;
        const questions = (data ?? []).map((q) => { const opts = Array.isArray(q.options) ? q.options : []; const rawAnswer = String(q.correct_answer ?? ""); const numericAnswer = Number(rawAnswer); let ans = rawAnswer !== "" && Number.isInteger(numericAnswer) && numericAnswer >= 0 && numericAnswer < opts.length ? numericAnswer : (/^[A-F]$/i.test(rawAnswer) ? rawAnswer.toUpperCase().charCodeAt(0) - 65 : opts.findIndex((v) => String(v) === rawAnswer)); return { id: q.question_id, question_id: q.question_id, className: cls || q.class_name, subject: q.subject_name, type: q.question_type, q: q.question_text, opt: opts, ans: Math.max(0, ans), points: q.points, sort_order: q.sort_order, is_active: q.is_active, imgs: Array.isArray(q.image_urls) ? q.image_urls : [] }; });
        return respond({ ok: true, success: true, questions, count: questions.length, databaseChanged: false });
      }
      if (action === "saveBankSoal") {
        const q = body.question && typeof body.question === "object" ? body.question as Record<string, unknown> : {};
        const id = cleanText(q.question_id ?? q.id, 80);
        const className = bankClassForClass(q.class_name ?? q.className);
        const subjectName = cleanText(q.subject_name ?? q.subject, 120);
        let priorSortOrder: number | null = null, priorPoints: number | null = null;
        if (id && isUuid(id)) {
          const { data: prior, error: priorError } = await supabase.from("smpn4_question_bank_shared").select("sort_order,points").eq("question_id", id).maybeSingle();
          if (priorError) throw priorError;
          if (prior) { priorSortOrder = Number(prior.sort_order ?? 0); priorPoints = Number(prior.points ?? 1); }
        } else {
          let maxQuery = supabase.from("smpn4_question_bank_shared").select("sort_order").eq("class_name", className).eq("subject_name", subjectName).order("sort_order", { ascending: false }).limit(1);
          const { data: lastQuestion, error: maxError } = await maxQuery.maybeSingle();
          if (maxError) throw maxError;
          priorSortOrder = lastQuestion ? Number(lastQuestion.sort_order ?? 0) + 1 : 0;
        }
        const type = cleanText(q.type, 20) === "essay" ? "essay" : "pg";
        const opts = Array.isArray(q.opt) ? q.opt.map(String) : [];
        const answer = type === "pg" ? (opts[Math.max(0, Number(q.ans ?? 0))] ?? q.ans ?? "A") : null;
        const checked = validateQuestion({ class_name: className, subject_name: subjectName, question_type: type, question_text: q.question_text ?? q.q, options: type === "pg" ? opts : [], correct_answer: answer, points: q.points ?? priorPoints ?? 1, sort_order: q.sort_order ?? priorSortOrder ?? 0, is_active: q.is_active !== false, image_urls: q.imgs !== undefined ? q.imgs : q.image_urls });
        if ("error" in checked) return respond({ ok: false, success: false, saved: false, message: checked.error }, 400);
        let result;
        if (id && isUuid(id)) result = await supabase.from("smpn4_question_bank_shared").update(checked.value).eq("question_id", id).select("question_id").maybeSingle();
        else result = await supabase.from("smpn4_question_bank_shared").insert(checked.value).select("question_id").single();
        if (result.error) throw result.error;
        if (!result.data) return respond({ ok: false, success: false, saved: false, message: "Soal tidak ditemukan." }, 404);
        return respond({ ok: true, success: true, saved: true, id: result.data.question_id, supabaseSynced: true, databaseChanged: true });
      }
      if (action === "deleteBankSoal") {
        const id = cleanText(body.id ?? body.question_id, 80);
        if (!isUuid(id)) return respond({ ok: false, success: false, deleted: false, message: "ID soal tidak valid." }, 400);
        const { data, error } = await supabase.from("smpn4_question_bank_shared").update({ is_active: false, updated_at: new Date().toISOString() }).eq("question_id", id).select("question_id").maybeSingle();
        if (error) throw error;
        return respond({ ok: true, success: true, deleted: Boolean(data), databaseChanged: Boolean(data) });
      }
      if (action === "restoreBankSoal") {
        const id = cleanText(body.id ?? body.question_id, 80);
        if (!isUuid(id)) return respond({ ok: false, success: false, restored: false, message: "ID soal tidak valid." }, 400);
        const { data, error } = await supabase.from("smpn4_question_bank_shared").update({ is_active: true, updated_at: new Date().toISOString() }).eq("question_id", id).select("question_id,is_active").maybeSingle();
        if (error) throw error;
        return respond({ ok: true, success: true, restored: Boolean(data && data.is_active), databaseChanged: Boolean(data && data.is_active) });
      }
      if (action === "importBankSoalBatch") {
        const incoming = Array.isArray(body.questions) ? body.questions : [];
        if (!incoming.length || incoming.length > 100) return respond({ ok: false, success: false, message: "Setiap batch harus berisi 1 sampai 100 soal.", databaseChanged: false }, 400);
        const prepared: Array<{operation: string; id: string; value: Record<string, unknown>}> = [];
        const seen = new Set<string>();
        for (let i = 0; i < incoming.length; i++) {
          const row = incoming[i] && typeof incoming[i] === "object" ? incoming[i] as Record<string, unknown> : {};
          const operation = cleanText(row.operation ?? "add", 20).toLowerCase();
          const id = cleanText(row.id ?? row.question_id, 80);
          if (operation !== "add" && operation !== "update") return respond({ ok: false, success: false, message: `Baris ${i + 1}: operasi harus add atau update.`, databaseChanged: false }, 400);
          if (operation === "update" && !isUuid(id)) return respond({ ok: false, success: false, message: `Baris ${i + 1}: ID soal untuk pembaruan tidak valid.`, databaseChanged: false }, 400);
          if (operation === "update" && seen.has(id)) return respond({ ok: false, success: false, message: `ID soal duplikat dalam batch: ${id}.`, databaseChanged: false }, 400);
          if (operation === "update") seen.add(id);
          const rawType = cleanText(row.type ?? row.question_type, 20).toLowerCase();
          const type = ["essay", "esai", "uraian"].includes(rawType) ? "essay" : (["pg", "pilihan ganda"].includes(rawType) ? "pg" : "");
          if (!type) return respond({ ok: false, success: false, message: `Baris ${i + 1}: tipe soal harus PG atau essay.`, databaseChanged: false }, 400);
          const opts = Array.isArray(row.opt) ? row.opt.map(String) : (Array.isArray(row.options) ? row.options.map(String) : []);
          let answer: unknown = null;
          if (type === "pg") {
            const raw = row.ans ?? row.correct_answer;
            if (raw === undefined || raw === null || String(raw).trim() === "") answer = null;
            else if (typeof raw === "number" || /^\d+$/.test(String(raw))) {
              const answerIndex = Number(raw);
              answer = opts[answerIndex] ?? String.fromCharCode(65 + answerIndex);
            } else answer = String(raw);
          }
          const checked = validateQuestion({
            class_name: row.className ?? row.class_name,
            subject_name: row.subject ?? row.subject_name,
            question_type: type,
            question_text: row.q ?? row.question_text,
            options: type === "pg" ? opts : [],
            correct_answer: answer,
            points: row.points ?? 1,
            sort_order: row.sort_order ?? 0,
            is_active: row.is_active === undefined ? true : row.is_active,
          });
          if ("error" in checked) return respond({ ok: false, success: false, message: `Baris ${i + 1}: ${checked.error}`, databaseChanged: false }, 400);
          prepared.push({ operation, id, value: checked.value });
        }
        // Preflight seluruh batch sebelum penulisan: tidak boleh ada soal duplikat, termasuk yang nonaktif.
        // Pemeriksaan ini juga dijalankan backend agar tidak bergantung pada validasi dashboard saja.
        const incomingQuestionKeys = new Map<string, { index: number; operation: string; id: string }>();
        const groupKeys = new Set<string>();
        for (let i = 0; i < prepared.length; i++) {
          const item = prepared[i];
          const key = `${String(item.value.class_name)}\u0000${String(item.value.subject_name)}\u0000${normalizeQuestionText(item.value.question_text)}`;
          const priorIncoming = incomingQuestionKeys.get(key);
          if (priorIncoming && (priorIncoming.operation === "add" || item.operation === "add" || priorIncoming.id !== item.id)) {
            return respond({ ok: false, success: false, message: `Baris ${i + 1}: teks soal duplikat di dalam batch (berkaitan dengan baris ${priorIncoming.index + 1}). Tidak ada perubahan disimpan.`, databaseChanged: false }, 409);
          }
          incomingQuestionKeys.set(key, { index: i, operation: item.operation, id: item.id });
          groupKeys.add(`${String(item.value.class_name)}\u0000${String(item.value.subject_name)}`);
        }
        const existingQuestionKeys = new Map<string, string[]>();
        for (const groupKey of groupKeys) {
          const [className, subjectName] = groupKey.split("\u0000");
          let start = 0;
          while (true) {
            const { data: existingRows, error: existingError } = await supabase
              .from("smpn4_question_bank_shared")
              .select("question_id,question_text")
              .eq("class_name", className)
              .eq("subject_name", subjectName)
              .range(start, start + 999);
            if (existingError) throw existingError;
            for (const existingRow of existingRows ?? []) {
              const existingKey = `${className}\u0000${subjectName}\u0000${normalizeQuestionText(existingRow.question_text)}`;
              const ids = existingQuestionKeys.get(existingKey) ?? [];
              ids.push(String(existingRow.question_id));
              existingQuestionKeys.set(existingKey, ids);
            }
            if (!existingRows || existingRows.length < 1000) break;
            start += 1000;
          }
        }
        for (let i = 0; i < prepared.length; i++) {
          const item = prepared[i];
          const key = `${String(item.value.class_name)}\u0000${String(item.value.subject_name)}\u0000${normalizeQuestionText(item.value.question_text)}`;
          const existingIds = existingQuestionKeys.get(key) ?? [];
          const conflictingId = existingIds.find((existingId) => item.operation === "add" || existingId !== item.id);
          if (conflictingId) {
            return respond({ ok: false, success: false, message: `Baris ${i + 1}: soal yang sama sudah ada di bank soal${existingIds.length > 1 ? " (termasuk soal nonaktif)" : ""}. Tidak ada perubahan dari batch ini yang disimpan.`, duplicateQuestionId: conflictingId, databaseChanged: false }, 409);
          }
        }
        // Pastikan seluruh UUID yang akan diperbarui memang ada sebelum melakukan insert/update apa pun.
        const updateIds = prepared.filter((item) => item.operation === "update").map((item) => item.id);
        if (updateIds.length) {
          const { data: updateRows, error: updatePreflightError } = await supabase
            .from("smpn4_question_bank_shared")
            .select("question_id")
            .in("question_id", updateIds);
          if (updatePreflightError) throw updatePreflightError;
          const foundIds = new Set((updateRows ?? []).map((row) => String(row.question_id)));
          const missingId = updateIds.find((id) => !foundIds.has(id));
          if (missingId) return respond({ ok: false, success: false, message: `ID soal untuk pembaruan tidak ditemukan: ${missingId}. Tidak ada perubahan dari batch ini yang disimpan.`, databaseChanged: false }, 404);
        }

        // Semua validasi dan preflight selesai; operasi di bawah hanya menyentuh baris yang diminta.
        let inserted = 0, updated = 0;
        for (const item of prepared) {
          if (item.operation === "update") {
            const { data, error } = await supabase.from("smpn4_question_bank_shared").update({ ...item.value, updated_at: new Date().toISOString() }).eq("question_id", item.id).select("question_id").maybeSingle();
            if (error) throw error;
            if (!data) return respond({ ok: false, success: false, message: `Soal untuk pembaruan tidak ditemukan: ${item.id}. Batch berhenti setelah ${inserted + updated} perubahan.`, inserted, updated, databaseChanged: inserted + updated > 0 }, 404);
            updated++;
          } else {
            const { data, error } = await supabase.from("smpn4_question_bank_shared").insert({ ...item.value, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }).select("question_id").single();
            if (error) throw error;
            if (!data) throw new Error("Supabase tidak mengembalikan ID soal baru.");
            inserted++;
          }
        }
        return respond({ ok: true, success: true, inserted, updated, processed: inserted + updated, databaseChanged: inserted + updated > 0 });
      }
      if (action === "syncAllBankSoalToSupabase") {
        return respond({ ok: false, success: false, message: "Sinkronisasi massal bawaan tetap dinonaktifkan untuk mencegah duplikasi. Gunakan impor Word untuk soal baru atau impor Excel dengan operasi terpilih; duplikasi ditolak server.", databaseChanged: false }, 400);
      }

      if (action === "question-list") {
        let query = supabase
          .from("smpn4_question_bank_shared")
          .select("question_id,class_name,subject_name,question_type,question_text,options,correct_answer,points,sort_order,is_active,image_urls,created_at,updated_at")
          .order("class_name", { ascending: true })
          .order("subject_name", { ascending: true })
          .order("sort_order", { ascending: true })
          .limit(1000);

        const classFilter = cleanText(body.class_name, 40);
        const subjectFilter = cleanText(body.subject_name, 120);
        if (classFilter) query = query.eq("class_name", bankClassForClass(classFilter));
        if (subjectFilter) query = query.eq("subject_name", subjectFilter);
        if (typeof body.is_active === "boolean") {
          query = query.eq("is_active", body.is_active);
        }

        const { data, error } = await query;
        if (error) throw error;
        return respond({
          ok: true,
          questions: data ?? [],
          count: data?.length ?? 0,
          databaseChanged: false,
        });
      }

      if (action === "question-create") {
        const checked = validateQuestion(body);
        if ("error" in checked) {
          return respond({ ok: false, message: checked.error, databaseChanged: false }, 400);
        }

        const { data, error } = await supabase
          .from("smpn4_question_bank_shared")
          .insert(checked.value)
          .select("question_id,class_name,subject_name,question_type,question_text,options,correct_answer,points,sort_order,is_active,image_urls,created_at,updated_at")
          .single();

        if (error) throw error;
        return respond({ ok: true, question: data, databaseChanged: true }, 201);
      }

      if (action === "question-update") {
        const questionId = cleanText(body.question_id, 80);
        if (!isUuid(questionId)) {
          return respond({ ok: false, message: "question_id tidak valid.", databaseChanged: false }, 400);
        }

        const checked = validateQuestion(body);
        if ("error" in checked) {
          return respond({ ok: false, message: checked.error, databaseChanged: false }, 400);
        }

        const { data, error } = await supabase
          .from("smpn4_question_bank_shared")
          .update(checked.value)
          .eq("question_id", questionId)
          .select("question_id,class_name,subject_name,question_type,question_text,options,correct_answer,points,sort_order,is_active,image_urls,created_at,updated_at")
          .maybeSingle();

        if (error) throw error;
        if (!data) {
          return respond({ ok: false, message: "Soal tidak ditemukan.", databaseChanged: false }, 404);
        }
        return respond({ ok: true, question: data, databaseChanged: true });
      }

      if (action === "question-disable") {
        const questionId = cleanText(body.question_id, 80);
        if (!isUuid(questionId)) {
          return respond({ ok: false, message: "question_id tidak valid.", databaseChanged: false }, 400);
        }

        const { data, error } = await supabase
          .from("smpn4_question_bank_shared")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("question_id", questionId)
          .select("question_id,is_active")
          .maybeSingle();

        if (error) throw error;
        if (!data) {
          return respond({ ok: false, message: "Soal tidak ditemukan.", databaseChanged: false }, 404);
        }
        return respond({
          ok: true,
          question: data,
          message: "Soal dinonaktifkan, bukan dihapus.",
          databaseChanged: true,
        });
      }
    }

    return respond({
      ok: false,
      message: "Action tidak dikenal.",
      databaseChanged: false,
    }, 400);
  } catch (error) {
    const diagnostic = error && typeof error === "object"
      ? error as { code?: unknown; message?: unknown }
      : null;
    const errorCode = cleanText(diagnostic?.code, 40) || "API_ERROR";
    // Log rincian server untuk admin, tetapi kirim hanya kode yang aman ke browser.
    console.error("smpn4-exam-api error:", { code: errorCode, message: cleanText(diagnostic?.message, 800) || String(error) });
    return respond({
      ok: false,
      success: false,
      message: "Pencatatan server gagal. Periksa Function Logs; kode diagnostik: " + errorCode + ".",
      errorCode,
      databaseChanged: false,
    }, 500);
  }
});
