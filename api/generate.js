/*
  /api/generate  (Vercel Serverless Function)
  Admin menempel/menyimpan link video YouTube, fungsi ini meminta Gemini
  menonton video itu lalu membuat ringkasan + draf soal pilihan ganda.

  Environment Variables (Vercel > Settings > Environment Variables):
    GEMINI_API_KEY   wajib. Buat di https://aistudio.google.com/apikey
    GEMINI_MODEL     opsional. Default: gemini-3.8-flash
    APPS_SCRIPT_URL  opsional. Default: URL Apps Script yang sama dengan app.html
*/

var DEFAULT_MODEL = "gemini-3.8-flash";
var DEFAULT_SCRIPT = "https://script.google.com/macros/s/AKfycbwN77m1gul0hiLCHWH9YFV_lCofUSgoYrXOzPlKg82uoX6o4Fi7Ndh0HPqxXafUIJrLiA/exec";

function ytId(u) {
  var m = String(u || "").match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : "";
}

function shuffle(arr) {
  for (var i = arr.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// Cek kode admin ke Apps Script yang sama dengan yang dipakai situs.
// Tujuannya agar orang asing tidak bisa memakai kuota API Gemini-mu.
async function isAdmin(code) {
  if (!code) return false;
  try {
    var r = await fetch(process.env.APPS_SCRIPT_URL || DEFAULT_SCRIPT, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "adminData", code: code })
    });
    var j = await r.json();
    return !!(j && j.ok);
  } catch (e) {
    return false;
  }
}

function buildPrompt(name, n, objText) {
  var lines = [
    "Kamu adalah instructional designer di bidang Learning & Organizational Development.",
    "Tugasmu: menyusun asesmen pre-test dan post-test untuk sebuah video pembelajaran singkat" + (name ? " (skill: " + name + ")" : "") + ".",
    "Ikuti alur backward design / constructive alignment: tujuan pembelajaran dulu, baru soal yang mengukur tujuan itu.",
    "Tonton videonya, lalu hasilkan JSON dengan isi berikut.",
    "",
    "LANGKAH 1. summary: 5 sampai 7 poin penting isi video, satu kalimat singkat per poin, bahasa Indonesia.",
    ""
  ];
  if (objText) {
    lines.push(
      "LANGKAH 2. objectives: admin sudah menetapkan tujuan pembelajaran berikut. Pakai persis tujuan ini, jangan menambah, mengurangi, atau mengubah maknanya.",
      "Tentukan sendiri level Bloom (C1 sampai C4) tiap tujuan.",
      "--- tujuan dari admin ---",
      objText,
      "--- akhir tujuan ---"
    );
  } else {
    lines.push(
      "LANGKAH 2. objectives: rumuskan 2 sampai 4 tujuan pembelajaran yang benar-benar diajarkan video ini.",
      "- Format: 'Setelah menonton video ini, peserta mampu [kata kerja operasional terukur] ...'.",
      "- Pakai kata kerja terukur (menyebutkan, menjelaskan, membedakan, menerapkan, menganalisis). Hindari 'memahami' atau 'mengetahui'.",
      "- Beri level Bloom revisi: C1 Mengingat, C2 Memahami, C3 Menerapkan, C4 Menganalisis. Video singkat jarang mencapai C5 atau C6, jadi jangan dipaksakan."
    );
  }
  lines.push(
    "",
    "LANGKAH 3. questions: tepat " + n + " soal pilihan ganda bahasa Indonesia sebagai kisi-kisi yang selaras dengan tujuan:",
    "- Tiap tujuan minimal punya 1 soal. Setiap soal dipetakan ke satu tujuan lewat field objective (nomor urut tujuan, mulai dari 0) dan diberi level Bloom di field bloom.",
    "- Level soal harus sesuai tujuannya. Paling banyak sepertiga soal berlevel C1 (hafalan). Sisanya C2 sampai C4: pakai mini kasus atau situasi kerja singkat bila tujuannya menerapkan atau menganalisis.",
    "- Soal harus bisa dijawab dari materi video, bukan sekadar pengetahuan umum atau kemampuan menebak. Jangan menguji angka, nama, atau detail sepele.",
    "- Pokok soal berupa masalah yang lengkap dan jelas. Hindari kalimat negatif ganda dan 'semua benar' atau 'semua salah'.",
    "- Tepat 4 pilihan, hanya satu yang benar. Pilihan salah harus mencerminkan kesalahpahaman yang umum, sejajar bentuk dan panjangnya dengan jawaban benar. Jangan membuat jawaban benar selalu paling panjang.",
    "- Pertanyaan maksimal 300 karakter, tiap pilihan maksimal 150 karakter. answer adalah nomor pilihan yang benar (0 sampai 3).",
    "- rationale: satu atau dua kalimat (maks 200 karakter) tentang mengapa jawaban benar itu benar dan kesalahpahaman apa yang digoda oleh distraktor utama.",
    "- Soal dipakai untuk pre-test dan post-test, jadi jangan menulis 'dalam video tadi' atau merujuk menit tertentu.",
    "",
    "FORMAT KELUARAN: balas HANYA dengan satu objek JSON tanpa teks lain, dengan kunci: summary (array string), objectives (array {text, bloom}), questions (array {objective, bloom, q, options, answer, rationale})."
  );
  return lines.join("\n");
}

var SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "array", items: { type: "string" } },
    objectives: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          bloom: { type: "string", enum: ["C1", "C2", "C3", "C4"] }
        },
        required: ["text", "bloom"]
      }
    },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          objective: { type: "integer", minimum: 0 },
          bloom: { type: "string", enum: ["C1", "C2", "C3", "C4"] },
          q: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          answer: { type: "integer", minimum: 0, maximum: 3 },
          rationale: { type: "string" }
        },
        required: ["objective", "bloom", "q", "options", "answer", "rationale"]
      }
    }
  },
  required: ["summary", "objectives", "questions"]
};

// Skema versi lama (OpenAPI, tipe huruf besar) untuk generationConfig.responseSchema.
var SCHEMA_LEGACY = {
  type: "OBJECT",
  properties: {
    summary: { type: "ARRAY", items: { type: "STRING" } },
    objectives: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { text: { type: "STRING" }, bloom: { type: "STRING" } },
        required: ["text", "bloom"]
      }
    },
    questions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          objective: { type: "INTEGER" },
          bloom: { type: "STRING" },
          q: { type: "STRING" },
          options: { type: "ARRAY", items: { type: "STRING" } },
          answer: { type: "INTEGER" },
          rationale: { type: "STRING" }
        },
        required: ["objective", "bloom", "q", "options", "answer", "rationale"]
      }
    }
  },
  required: ["summary", "objectives", "questions"]
};

// Format "mode JSON" di REST Gemini berbeda antar versi dokumentasi. Coba berurutan:
// 1) responseMimeType + responseSchema, 2) responseFormat (enum APPLICATION_JSON), 3) tanpa skema.
var CONFIG_VARIANTS = [
  { responseMimeType: "application/json", responseSchema: SCHEMA_LEGACY },
  { responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: SCHEMA } } },
  {}
];

// Ambil objek JSON dari teks, termasuk bila dibungkus ```json ... ```.
function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch (e) { /* lanjut */ }
  var a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { /* gagal */ }
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Metode tidak diizinkan." });
  }

  var body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  // Bersihkan kesalahan tempel yang umum: spasi/baris baru, tanda kutip, atau awalan "GEMINI_API_KEY=".
  var key = String(process.env.GEMINI_API_KEY || "")
    .trim()
    .replace(/^GEMINI_API_KEY\s*=\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  // Info samar (3 huruf awal, 2 huruf akhir, panjang) agar admin bisa memeriksa tanpa membuka isi key.
  var keyInfo = key ? (key.slice(0, 3) + "..." + key.slice(-2) + ", " + key.length + " karakter") : "kosong";
  if (!key) {
    return res.status(500).json({ ok: false, error: "GEMINI_API_KEY belum diisi di Vercel." });
  }

  var id = ytId(body.url);
  if (!id) {
    return res.status(400).json({ ok: false, error: "Tautan video bukan link YouTube yang valid." });
  }

  if (!(await isAdmin(String(body.code || "")))) {
    return res.status(403).json({ ok: false, error: "Kode admin tidak valid." });
  }

  var n = parseInt(body.n, 10);
  if (!(n >= 3 && n <= 10)) n = 5;
  var name = String(body.name || "").slice(0, 120);
  var objText = String(body.objectives || "").trim().slice(0, 1200);

  var model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  var endpoint = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent";

  var contents = [{
    parts: [
      { text: buildPrompt(name, n, objText) },
      { file_data: { file_uri: "https://www.youtube.com/watch?v=" + id } }
    ]
  }];

  var data = null, lastErr = "";
  for (var vi = 0; vi < CONFIG_VARIANTS.length; vi++) {
    try {
      var r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: contents, generationConfig: CONFIG_VARIANTS[vi] })
      });
      var d = await r.json();
      if (r.ok) { data = d; break; }
      lastErr = (d && d.error && d.error.message) || ("Gemini membalas status " + r.status);
      // Hanya coba format lain bila ini error 400 (format permintaan ditolak).
      if (r.status !== 400) break;
    } catch (e) {
      return res.status(502).json({ ok: false, error: "Tidak bisa menghubungi Gemini: " + e.message });
    }
  }
  if (!data) {
    var keyHint = /api key|api_key|credential|access token|unauthenticated|permission/i.test(lastErr)
      ? " | Key yang terbaca server: " + keyInfo + " (key AI Studio baru berawalan AQ. dan panjangnya sekitar 50-an karakter)."
      : "";
    return res.status(502).json({
      ok: false,
      error: "Gemini gagal memproses video. Pastikan videonya publik (bukan private/unlisted). Detail: " + lastErr + keyHint
    });
  }

  var text = "";
  try {
    var parts = data.candidates[0].content.parts;
    text = parts.map(function (p) { return p.text || ""; }).join("");
  } catch (e) { /* ditangani di bawah */ }

  var out = parseJsonLoose(text);
  if (!out) {
    return res.status(502).json({ ok: false, error: "Balasan Gemini tidak bisa dibaca. Coba lagi." });
  }

  var summary = (Array.isArray(out.summary) ? out.summary : [])
    .map(function (s) { return String(s || "").trim(); })
    .filter(Boolean)
    .slice(0, 10);

  var objectives = (Array.isArray(out.objectives) ? out.objectives : [])
    .map(function (o) { return { text: String((o && o.text) || "").trim().slice(0, 300), bloom: /^C[1-4]$/.test(o && o.bloom) ? o.bloom : "" }; })
    .filter(function (o) { return o.text; })
    .slice(0, 6);

  // Bentuk akhir sama persis dengan yang dipakai form "Kelola soal": {q, o:[4], a:index}
  // Info kisi-kisi (tujuan, level Bloom, alasan) dikirim terpisah di "blueprint".
  var questions = [];
  var blueprint = [];
  (Array.isArray(out.questions) ? out.questions : []).forEach(function (it) {
    if (!it || !Array.isArray(it.options) || it.options.length < 2) return;
    var opts = it.options.slice(0, 4).map(function (o) { return String(o || "").trim().slice(0, 200); });
    while (opts.length < 4) opts.push("");
    var a = parseInt(it.answer, 10);
    if (!(a >= 0 && a < 4) || !opts[a]) return;
    var q = String(it.q || "").trim().slice(0, 400);
    if (!q) return;

    // Acak urutan pilihan supaya jawaban benar tidak selalu di posisi yang sama.
    var tagged = opts.map(function (o, i) { return { o: o, ok: i === a }; }).filter(function (x) { return x.o; });
    shuffle(tagged);
    var o2 = tagged.map(function (x) { return x.o; });
    var a2 = tagged.findIndex(function (x) { return x.ok; });
    while (o2.length < 4) o2.push("");
    questions.push({ q: q, o: o2, a: a2 });

    var oi = parseInt(it.objective, 10);
    blueprint.push({
      obj: (oi >= 0 && oi < objectives.length) ? oi : -1,
      bloom: /^C[1-4]$/.test(it.bloom) ? it.bloom : "",
      why: String(it.rationale || "").trim().slice(0, 300)
    });
  });

  if (!questions.length) {
    return res.status(502).json({ ok: false, error: "Gemini tidak menghasilkan soal yang valid. Coba lagi." });
  }

  return res.status(200).json({ ok: true, summary: summary, objectives: objectives, blueprint: blueprint, questions: questions });
};
