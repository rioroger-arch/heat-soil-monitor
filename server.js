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
        'Lakukan penyiraman segera untuk menurunkan suhu tanah',
        'Gunakan mulsa atau penutup tanah untuk mengurangi evaporasi',
        'Tunda pemupukan hingga suhu kembali normal'
      ],
      alasan: 'Suhu permukaan tanah melebihi batas aman (>45C), dihasilkan dari aturan cadangan karena AI tidak tersedia.'
    };
  } else if (suhuPermukaan > 38) {
    return {
      status: 'PERINGATAN - PANAS',
      rekomendasi: [
        'Tingkatkan frekuensi penyiraman pada pagi atau sore hari',
        'Tambahkan mulsa organik untuk menjaga kelembapan tanah',
        'Kurangi paparan panas berlebih jika memungkinkan'
      ],
      alasan: 'Suhu permukaan tanah di atas rentang optimal, dihasilkan dari aturan cadangan karena AI tidak tersedia.'
    };
  } else if (suhuPermukaan >= 25) {
    return {
      status: 'OPTIMAL',
      rekomendasi: [
        'Kondisi suhu tanah berada pada rentang optimal',
        'Tidak diperlukan tindakan korektif saat ini',
        'Lanjutkan pemantauan dan perawatan rutin'
      ],
      alasan: 'Suhu permukaan tanah berada pada rentang ideal, dihasilkan dari aturan cadangan karena AI tidak tersedia.'
    };
  } else if (suhuPermukaan >= 15) {
    return {
      status: 'PERHATIAN - SEJUK',
      rekomendasi: [
        'Kurangi intensitas penyiraman untuk mencegah kelembapan berlebih',
        'Gunakan mulsa untuk mempertahankan suhu tanah',
        'Lakukan pemantauan suhu secara berkala'
      ],
      alasan: 'Suhu permukaan tanah di bawah rentang optimal, dihasilkan dari aturan cadangan karena AI tidak tersedia.'
    };
  }
  return {
    status: 'PERINGATAN - DINGIN',
    rekomendasi: [
      'Gunakan penutup tanah atau mulsa untuk mengurangi kehilangan panas',
      'Tunda kegiatan budidaya yang sensitif terhadap suhu rendah',
      'Pantau suhu lebih sering pada kondisi ini'
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

  const systemPrompt = `Kamu adalah asisten agronomi berpengalaman yang menganalisis data suhu tanah dari sensor inframerah (MLX90614) pada sebuah lahan pertanian/perkebunan kecil. Tugasmu memberi analisis dan rekomendasi treatment tanah yang mendalam, informatif, dan bisa langsung dikerjakan petani.

Balas HANYA dengan JSON valid, tanpa markdown, tanpa teks lain, dengan format persis:
{
  "status": "satu frasa singkat status kondisi tanah (contoh: OPTIMAL, PERHATIAN - PANAS, KRITIS - TERLALU PANAS)",
  "rekomendasi": ["langkah 1 dengan penjelasan singkat kenapa langkah ini perlu", "langkah 2 dengan penjelasan singkat", "langkah 3 dengan penjelasan singkat", "langkah 4 dengan penjelasan singkat"],
  "alasan": "analisis mendalam 4-6 kalimat yang menjelaskan: kondisi suhu saat ini dan artinya secara agronomis, bagaimana tren dari data historis (naik/turun/stabil dan seberapa cepat), dampak potensial terhadap tanaman/mikroba tanah/kelembapan jika kondisi ini berlanjut, dan konteks tambahan yang relevan (misal waktu hari, musim, atau karakteristik tanah yang perlu diperhatikan)"
}

Berikan MINIMAL 4 langkah rekomendasi (boleh lebih kalau relevan), masing-masing dengan penjelasan singkat kenapa langkah itu penting, bukan cuma instruksi satu baris. Bagian "alasan" harus berupa analisis yang benar-benar mendalam, bukan ringkasan satu-dua kalimat saja. Pertimbangkan suhu permukaan sebagai faktor utama, suhu ruang sebagai konteks pendukung, dan tren dari data historis jika ada (misalnya suhu naik cepat vs stabil, atau pola berulang).`;

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
        thinkingConfig: { thinkingLevel: 'medium' }
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