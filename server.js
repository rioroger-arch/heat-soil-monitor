// ============================================================
//  SOIL AI BACKEND
//  Terima data suhu dari ESP32 -> minta rekomendasi ke Claude AI
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

// ---------- Penyimpanan sederhana (file JSON) ----------
function bacaHistori() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function simpanHistori(histori) {
  const dipotong = histori.slice(-MAX_HISTORY);
  fs.writeFileSync(DATA_FILE, JSON.stringify(dipotong, null, 2));
}

// ---------- Fallback rule-based (kalau AI gagal/timeout) ----------
function rekomendasiFallback(suhuPermukaan) {
  if (suhuPermukaan > 45) {
    return {
      status: 'KRITIS - TERLALU PANAS',
      rekomendasi: [
        { langkah: 'Lakukan penyiraman segera untuk menurunkan suhu tanah', kategori: 'penyiraman' },
        { langkah: 'Gunakan mulsa atau penutup tanah untuk mengurangi evaporasi', kategori: 'mulsa' },
        { langkah: 'Pasang naungan sementara untuk mengurangi paparan matahari langsung', kategori: 'naungan' },
        { langkah: 'Tunda pemupukan hingga suhu kembali normal', kategori: 'lainnya' }
      ],
      alasan: 'Suhu permukaan tanah melebihi batas aman (>45C), dihasilkan dari aturan cadangan karena AI tidak tersedia.'
    };
  } else if (suhuPermukaan > 38) {
    return {
      status: 'PERINGATAN - PANAS',
      rekomendasi: [
        { langkah: 'Tingkatkan frekuensi penyiraman pada pagi atau sore hari', kategori: 'penyiraman' },
        { langkah: 'Tambahkan mulsa organik untuk menjaga kelembapan tanah', kategori: 'mulsa' },
        { langkah: 'Kurangi paparan panas berlebih jika memungkinkan', kategori: 'naungan' },
        { langkah: 'Pantau suhu secara berkala untuk memastikan tidak memburuk', kategori: 'pemantauan' }
      ],
      alasan: 'Suhu permukaan tanah di atas rentang optimal, dihasilkan dari aturan cadangan karena AI tidak tersedia.'
    };
  } else if (suhuPermukaan >= 25) {
    return {
      status: 'OPTIMAL',
      rekomendasi: [
        { langkah: 'Kondisi suhu tanah berada pada rentang optimal', kategori: 'pemantauan' },
        { langkah: 'Tidak diperlukan tindakan korektif saat ini', kategori: 'lainnya' },
        { langkah: 'Lanjutkan pemantauan dan perawatan rutin', kategori: 'pemantauan' },
        { langkah: 'Siram sesuai jadwal normal seperti biasa', kategori: 'penyiraman' }
      ],
      alasan: 'Suhu permukaan tanah berada pada rentang ideal, dihasilkan dari aturan cadangan karena AI tidak tersedia.'
    };
  } else if (suhuPermukaan >= 15) {
    return {
      status: 'PERHATIAN - SEJUK',
      rekomendasi: [
        { langkah: 'Kurangi intensitas penyiraman untuk mencegah kelembapan berlebih', kategori: 'penyiraman' },
        { langkah: 'Gunakan mulsa untuk mempertahankan suhu tanah', kategori: 'mulsa' },
        { langkah: 'Lakukan pemantauan suhu secara berkala', kategori: 'pemantauan' },
        { langkah: 'Pertimbangkan pindahkan tanaman pot ke lokasi lebih hangat', kategori: 'lainnya' }
      ],
      alasan: 'Suhu permukaan tanah di bawah rentang optimal, dihasilkan dari aturan cadangan karena AI tidak tersedia.'
    };
  }
  return {
    status: 'PERINGATAN - DINGIN',
    rekomendasi: [
      { langkah: 'Gunakan penutup tanah atau mulsa untuk mengurangi kehilangan panas', kategori: 'mulsa' },
      { langkah: 'Tunda kegiatan budidaya yang sensitif terhadap suhu rendah', kategori: 'lainnya' },
      { langkah: 'Pantau suhu lebih sering pada kondisi ini', kategori: 'pemantauan' },
      { langkah: 'Kurangi penyiraman karena penguapan sangat rendah', kategori: 'penyiraman' }
    ],
    alasan: 'Suhu permukaan tanah jauh di bawah rentang optimal, dihasilkan dari aturan cadangan karena AI tidak tersedia.'
  };
}

// ---------- Panggil Gemini API untuk rekomendasi treatment ----------
async function mintaRekomendasiAI(suhuRuang, suhuPermukaan, historiSingkat) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY belum diset');
  }

  const konteksHistori = historiSingkat.length
    ? historiSingkat
        .map(h => `- ${h.waktu}: permukaan ${h.suhuPermukaan}C, ruang ${h.suhuRuang}C`)
        .join('\n')
    : '(belum ada data sebelumnya)';

  const systemPrompt = `Kamu adalah asisten yang menganalisis data suhu tanah/media tanam dari sensor inframerah (MLX90614), lalu memberi rekomendasi PENANGANAN TANAH terkait suhu tersebut. Target penggunamu BERAGAM: petani/pekebun di lahan pertanian, sampai masyarakat umum yang merawat tanaman di pot, halaman rumah, atau kebun kecil di rumah tangga.

PENTING - BATASAN CAKUPAN: Fokus rekomendasi HARUS pada penanganan TANAH/MEDIA TANAM yang berkaitan langsung dengan suhu yang terukur (penyiraman untuk mengatur suhu, mulsa/penutup tanah, naungan dari matahari, pemantauan suhu). JANGAN memberi saran perawatan tanaman umum yang tidak berkaitan dengan suhu tanah (seperti jadwal pemupukan rutin, pemangkasan, pengendalian hama, penyerbukan, dll) -- itu di luar apa yang bisa disimpulkan dari data suhu ini. Kalau ragu apakah suatu saran relevan, pilih yang paling berkaitan langsung dengan suhu.

Balas HANYA dengan JSON valid, tanpa markdown, tanpa teks lain, dengan format persis:
{
  "status": "satu frasa singkat status kondisi tanah (contoh: OPTIMAL, PERHATIAN - PANAS, KRITIS - TERLALU PANAS)",
  "rekomendasi": [
    {"langkah": "langkah 1 dengan penjelasan singkat kenapa langkah ini perlu", "kategori": "penyiraman"},
    {"langkah": "langkah 2 dengan penjelasan singkat", "kategori": "mulsa"},
    {"langkah": "langkah 3 dengan penjelasan singkat", "kategori": "naungan"},
    {"langkah": "langkah 4 dengan penjelasan singkat", "kategori": "pemantauan"}
  ],
  "alasan": "analisis mendalam 4-6 kalimat yang menjelaskan: kondisi suhu tanah saat ini dan artinya, bagaimana tren dari data historis (naik/turun/stabil dan seberapa cepat), dampak potensial terhadap struktur tanah/mikroba tanah/kelembapan/akar jika kondisi ini berlanjut, dan konteks tambahan yang relevan"
}

ATURAN UNTUK FIELD "kategori": WAJIB diisi salah satu dari daftar tetap berikut ini (case-sensitive, tanpa variasi lain): "penyiraman", "mulsa", "naungan", "pemantauan", "lainnya". Pilih kategori yang paling sesuai dengan isi langkahnya:
- "penyiraman": kalau langkahnya soal menyiram/menambah air ke tanah
- "mulsa": kalau langkahnya soal menutup permukaan tanah (jerami, sekam, daun kering, dll)
- "naungan": kalau langkahnya soal memberi keteduhan/mengurangi paparan matahari langsung ke tanah
- "pemantauan": kalau langkahnya soal memantau/mengecek suhu tanah secara berkala
- "lainnya": kalau langkahnya soal penanganan tanah lain yang masih terkait suhu (drainase, dll) tapi tidak cocok kategori di atas

Berikan MINIMAL 4 langkah rekomendasi, semuanya harus berupa TINDAKAN TERHADAP TANAH, bukan perawatan tanaman secara umum. Bagian "alasan" harus berupa analisis yang benar-benar mendalam, bukan ringkasan satu-dua kalimat saja. Gunakan bahasa yang mudah dipahami baik oleh petani berpengalaman maupun orang rumahan yang baru mulai merawat tanaman. Pertimbangkan suhu permukaan sebagai faktor utama, suhu ruang sebagai konteks pendukung, dan tren dari data historis jika ada.`;

  const userPrompt = `Data sensor saat ini:
- Suhu permukaan tanah: ${suhuPermukaan}C
- Suhu ruang/udara sekitar: ${suhuRuang}C

Data historis terakhir:
${konteksHistori}

Berikan rekomendasi treatment tanah untuk kondisi ini.`;

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

  const histori = bacaHistori();
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
    hasilAI = rekomendasiFallback(suhuPermukaan);
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
  simpanHistori(histori);

  res.json({ ok: true, entry });
});

// ---------- Endpoint: dashboard ambil data terbaru ----------
app.get('/api/latest', (req, res) => {
  const histori = bacaHistori();
  if (histori.length === 0) {
    return res.status(404).json({ error: 'Belum ada data masuk' });
  }
  res.json(histori[histori.length - 1]);
});

// ---------- Endpoint: dashboard ambil histori untuk grafik ----------
app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const histori = bacaHistori();
  res.json(histori.slice(-limit));
});

app.listen(PORT, () => {
  console.log(`Server jalan di port ${PORT}`);
  console.log(`Model AI: ${AI_MODEL}`);
  console.log(GEMINI_API_KEY ? 'GEMINI_API_KEY terdeteksi.' : 'PERINGATAN: GEMINI_API_KEY belum diset, akan pakai fallback rule-based terus.');
});