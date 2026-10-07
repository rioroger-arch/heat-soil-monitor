// ============================================================
//  SOIL AI BACKEND
//  Terima data suhu dari ESP32 -> minta peringatan istirahat petani wanita ke Gemini AI
//  -> simpan histori -> sajikan ke web dashboard
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'gemini-3.5-flash-lite';

const DATA_FILE = path.join(__dirname, 'data.json');
const MAX_HISTORY = 200;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Penyimpanan riwayat ----------
// Di Vercel: filesystem read-only, jadi histori disimpan di memori (RAM) selama fungsi masih "hangat".
// Di laptop: tetap disimpan ke data.json supaya histori tidak hilang saat restart.
const isVercel = !!process.env.VERCEL;
let memoriHistori = [];

async function bacaHistori() {
  if (isVercel) {
    return memoriHistori;
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

async function simpanHistori(histori) {
  const dipotong = histori.slice(-MAX_HISTORY);
  memoriHistori = dipotong;
  if (isVercel) return;
  fs.writeFileSync(DATA_FILE, JSON.stringify(dipotong, null, 2));
}

// ---------- Fallback rule-based (kalau AI gagal/timeout) ----------
// Peringatan sederhana: suhu terlalu tinggi -> istirahat, dan apa risikonya kalau dipaksakan.
// Item pertama selalu kategori 'istirahat' (instruksi), sisanya 'kesehatan' (tampil sebagai label "Waspada").
function rekomendasiFallback(suhuPermukaan, suhuRuang) {
  const catatan = ' (Dihasilkan dari aturan cadangan karena AI tidak tersedia.)';
  if (suhuPermukaan > 45 || suhuRuang > 35) {
    return {
      status: 'BAHAYA - HENTIKAN KERJA',
      rekomendasi: [
        { langkah: 'Suhu lahan sangat tinggi. Hentikan pekerjaan dan istirahat di tempat teduh sekarang.', kategori: 'istirahat' },
        { langkah: 'Jika dipaksakan, tubuh bisa kehilangan banyak cairan dan mengalami dehidrasi.', kategori: 'kesehatan' },
        { langkah: 'Jika dipaksakan, bisa muncul pusing, lemas, mual, bahkan pingsan.', kategori: 'kesehatan' },
        { langkah: 'Jika terus dipaksakan, ada risiko sengatan panas yang berbahaya dan butuh pertolongan medis.', kategori: 'kesehatan' }
      ],
      alasan: 'Suhu permukaan lahan dan udara sudah jauh di atas batas aman untuk bekerja.' + catatan
    };
  } else if (suhuPermukaan > 38 || suhuRuang > 32) {
    return {
      status: 'PERINGATAN - ISTIRAHAT DULU',
      rekomendasi: [
        { langkah: 'Suhu lahan terlalu tinggi. Sebaiknya berhenti dan istirahat dulu di tempat teduh.', kategori: 'istirahat' },
        { langkah: 'Jika dipaksakan, tubuh cepat lelah dan mudah kehabisan cairan.', kategori: 'kesehatan' },
        { langkah: 'Jika terus dipaksakan, bisa muncul pusing dan lemas hingga memburuk menjadi sengatan panas.', kategori: 'kesehatan' }
      ],
      alasan: 'Suhu permukaan lahan sudah di atas batas nyaman untuk bekerja dalam waktu lama.' + catatan
    };
  } else if (suhuPermukaan >= 15) {
    return {
      status: 'AMAN',
      rekomendasi: [
        { langkah: 'Suhu lahan masih dalam batas aman untuk bekerja. Tidak perlu istirahat khusus saat ini.', kategori: 'lainnya' }
      ],
      alasan: 'Suhu permukaan lahan belum melewati batas yang mengharuskan istirahat.' + catatan
    };
  }
  return {
    status: 'PERINGATAN - TERLALU DINGIN',
    rekomendasi: [
      { langkah: 'Suhu lahan terlalu rendah. Sebaiknya berhenti sejenak dan menghangatkan diri.', kategori: 'istirahat' },
      { langkah: 'Jika dipaksakan, tubuh cepat kedinginan dan jari tangan bisa kaku atau mati rasa.', kategori: 'kesehatan' }
    ],
    alasan: 'Suhu permukaan lahan sangat rendah sehingga tidak nyaman dan berisiko untuk bekerja lama.' + catatan
  };
}

// ---------- Panggil Gemini API untuk peringatan istirahat ----------
async function mintaRekomendasiAI(suhuRuang, suhuPermukaan, historiSingkat) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY belum diset');
  }

  const konteksHistori = historiSingkat.length
    ? historiSingkat
        .map(h => `- ${h.waktu}: permukaan ${h.suhuPermukaan}C, ruang ${h.suhuRuang}C`)
        .join('\n')
    : '(belum ada data sebelumnya)';

  const systemPrompt = `Kamu adalah sistem peringatan untuk PETANI WANITA yang bekerja di lahan. Kamu menerima data suhu permukaan tanah dan suhu udara dari sensor, lalu memberi PERINGATAN SEDERHANA: apakah suhu sudah terlalu tinggi sehingga harus istirahat, dan apa akibat yang dikhawatirkan jika tetap memaksakan bekerja.

ATURAN ISI (PENTING):
- JANGAN memberi tips kesehatan atau saran panjang (jangan bahas minum air, pakaian, topi, kompres, jadwal kerja, dan sejenisnya). Cukup dua hal: (1) perintah singkat untuk istirahat dan (2) risiko jika dipaksakan.
- JANGAN memberi saran perawatan tanah atau tanaman.
- Suhu tanah dipakai sebagai petunjuk panasnya lahan, bukan suhu tubuh.
- Jika suhu masih aman (permukaan di bawah sekitar 38C dan udara di bawah sekitar 32C), status "AMAN" dan cukup 1 kalimat bahwa belum perlu istirahat khusus.
- Jika suhu terlalu tinggi, sebut dengan jelas bahwa suhunya terlalu tinggi dan petani sebaiknya istirahat. Semakin tinggi suhunya, semakin tegas nadanya (di atas sekitar 45C permukaan atau 35C udara = hentikan kerja).
- Risiko harus nyata dan masuk akal untuk paparan panas, misalnya dehidrasi, pusing, lemas, mual, pingsan, sengatan panas. Jangan menakut-nakuti berlebihan dan jangan mendiagnosis.
- Gunakan bahasa Indonesia yang sederhana dan sopan.

Balas HANYA dengan JSON valid, tanpa markdown, tanpa teks lain, dengan format persis:
{
  "status": "satu frasa singkat (contoh: AMAN, PERINGATAN - ISTIRAHAT DULU, BAHAYA - HENTIKAN KERJA)",
  "rekomendasi": [
    {"langkah": "satu kalimat perintah istirahat yang menyebut suhu terlalu tinggi", "kategori": "istirahat"},
    {"langkah": "satu kalimat risiko jika dipaksakan", "kategori": "kesehatan"},
    {"langkah": "satu kalimat risiko lanjutan jika terus dipaksakan", "kategori": "kesehatan"}
  ],
  "alasan": "1-2 kalimat singkat: kenapa suhu saat ini dianggap tinggi/aman, dan jika ada tren dari data historis (naik/turun/stabil), sebutkan singkat."
}

ATURAN FIELD "kategori": hanya boleh "istirahat" (untuk perintah istirahat, hanya 1 item dan harus yang pertama), "kesehatan" (untuk setiap risiko jika dipaksakan), atau "lainnya" (hanya untuk status AMAN). Untuk kondisi tinggi, berikan 1 item "istirahat" dan 2-3 item "kesehatan".`;

  const userPrompt = `Data sensor saat ini:
- Suhu permukaan tanah: ${suhuPermukaan}C
- Suhu ruang/udara sekitar: ${suhuRuang}C

Data historis terakhir:
${konteksHistori}

Berikan peringatan singkat untuk petani wanita pada kondisi ini.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingLevel: 'low' }
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const teks = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  const bersih = teks.replace(/```json|```/g, '').trim();
  return JSON.parse(bersih);
}

// ---------- Endpoint: ESP32 kirim data sensor ke sini ----------
app.post('/api/data', async (req, res) => {
  const { suhuRuang, suhuPermukaan } = req.body;

  if (typeof suhuRuang !== 'number' || typeof suhuPermukaan !== 'number') {
    return res.status(400).json({ error: 'suhuRuang dan suhuPermukaan wajib berupa angka' });
  }

  const histori = await bacaHistori();
  const historiSingkat = histori.slice(-8).map(h => ({
    waktu: h.waktu,
    suhuRuang: h.suhuRuang,
    suhuPermukaan: h.suhuPermukaan
  }));

  let hasilAI;
  let sumber = 'ai';
  try {
    hasilAI = await mintaRekomendasiAI(suhuRuang, suhuPermukaan, historiSingkat);
  } catch (err) {
    console.error('Gagal memanggil AI, pakai fallback rule-based:', err.message);
    hasilAI = rekomendasiFallback(suhuPermukaan, suhuRuang);
    sumber = 'fallback';
  }

  const entry = {
    waktu: new Date().toISOString(),
    suhuRuang,
    suhuPermukaan,
    status: hasilAI.status,
    rekomendasi: hasilAI.rekomendasi,
    alasan: hasilAI.alasan,
    sumber
  };

  histori.push(entry);
  try {
    await simpanHistori(histori);
  } catch (err) {
    console.error('Gagal simpan histori:', err.message);
  }

  res.json({ ok: true, entry });
});

// ---------- Endpoint: dashboard ambil data terbaru ----------
app.get('/api/latest', async (req, res) => {
  const histori = await bacaHistori();
  if (histori.length === 0) {
    return res.status(404).json({ error: 'Belum ada data masuk' });
  }
  res.json(histori[histori.length - 1]);
});

// ---------- Endpoint: dashboard ambil histori untuk grafik ----------
app.get('/api/history', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const histori = await bacaHistori();
  res.json(histori.slice(-limit));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server jalan di port ${PORT}`);
    console.log(`Model AI: ${AI_MODEL}`);
    console.log(GEMINI_API_KEY ? 'GEMINI_API_KEY terdeteksi.' : 'PERINGATAN: GEMINI_API_KEY belum diset, akan pakai fallback rule-based terus.');
  });
}

module.exports = app;