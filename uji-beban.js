'use strict';
/*
 * Uji beban undangan. Pemakaian:
 *   node uji-beban.js <base-url> burst <jumlah-tamu> [post]      -> semua tamu masuk BERSAMAAN (membuka halaman + ucapan [+ kirim RSVP])
 *   node uji-beban.js <base-url> tahan <konkurensi> <detik>       -> beban terus-menerus tanpa jeda (cari batas kemampuan)
 * Tiap "tamu" membuka sambungan baru (seperti HP sungguhan), memuat / lalu /api/ucapan.
 * Header cf-connecting-ip diacak supaya pembatas kirim per-IP tidak menutupi hasil (hanya berpengaruh ke server uji).
 */
const http = require('http');
const https = require('https');

const [, , BASE, MODE = 'burst', ARG1 = '20', ARG2 = '10'] = process.argv;
const url = new URL(BASE);
const klien = url.protocol === 'https:' ? https : http;
const agen = new klien.Agent({ keepAlive: false, maxSockets: Infinity });
const ipAcak = () => '10.' + [1, 2, 3].map(() => Math.floor(Math.random() * 250 + 1)).join('.');

const minta = (metode, jalur, badan) => new Promise((ok) => {
  const t0 = process.hrtime.bigint();
  const opsi = { method: metode, hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: jalur, agent: agen, headers: { ...(url.protocol === 'https:' ? {} : { 'cf-connecting-ip': ipAcak() }), 'user-agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36', accept: 'text/html,application/json,*/*', 'accept-language': 'id-ID,id;q=0.9' }, timeout: 30000 };
  if (badan) { opsi.headers['content-type'] = 'application/json'; opsi.headers['content-length'] = Buffer.byteLength(badan); }
  const r = klien.request(opsi, (res) => {
    let n = 0; res.on('data', (c) => { n += c.length; });
    res.on('end', () => ok({ kode: res.statusCode, ms: Number(process.hrtime.bigint() - t0) / 1e6, bytes: n }));
  });
  r.on('timeout', () => { r.destroy(); ok({ kode: 0, ms: 30000, bytes: 0, galat: 'timeout' }); });
  r.on('error', (e) => ok({ kode: 0, ms: Number(process.hrtime.bigint() - t0) / 1e6, bytes: 0, galat: e.code || e.message }));
  if (badan) r.write(badan);
  r.end();
});

const persen = (arr, p) => { if (!arr.length) return 0; const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p / 100 * a.length))]; };
const ringkas = (nama, hasil, detik) => {
  const ms = hasil.map((h) => h.ms), gagal = hasil.filter((h) => h.kode < 200 || h.kode >= 400);
  const galat = {}; gagal.forEach((h) => { const k = h.galat || h.kode; galat[k] = (galat[k] || 0) + 1; });
  return { tes: nama, permintaan: hasil.length, rps: detik ? +(hasil.length / detik).toFixed(0) : undefined, gagal: gagal.length, galat, p50: +persen(ms, 50).toFixed(0), p95: +persen(ms, 95).toFixed(0), p99: +persen(ms, 99).toFixed(0), maks: +Math.max(0, ...ms).toFixed(0), MB: +(hasil.reduce((a, h) => a + h.bytes, 0) / 1048576).toFixed(1) };
};

async function tamu(kirim) {
  const a = await minta('GET', '/' + '?to=Tamu' + Math.floor(Math.random() * 1e6));
  const b = await minta('GET', '/api/ucapan?batas=12');
  const hasil = [a, b];
  if (kirim) hasil.push(await minta('POST', '/api/rsvp', JSON.stringify({ nama: 'Uji Beban ' + Math.random().toString(36).slice(2, 8), hadir: 'Hadir', jumlah: 2, ucapan: 'uji beban otomatis' })));
  return { hasil, total: hasil.reduce((s, h) => s + h.ms, 0) };
}

(async () => {
  if (MODE === 'burst') {
    const n = parseInt(ARG1, 10), kirim = process.argv[5] === 'post';
    const t0 = Date.now();
    const semua = await Promise.all(Array.from({ length: n }, () => tamu(kirim)));
    const detik = (Date.now() - t0) / 1000;
    const totalTamu = semua.map((s) => s.total);
    const r = ringkas('burst ' + n + ' tamu bersamaan' + (kirim ? ' + kirim RSVP' : ''), semua.flatMap((s) => s.hasil), 0);
    r.tamu_selesai_dalam_detik = +detik.toFixed(2);
    r.waktu_total_per_tamu_ms = { p50: +persen(totalTamu, 50).toFixed(0), p95: +persen(totalTamu, 95).toFixed(0), maks: +Math.max(...totalTamu).toFixed(0) };
    console.log(JSON.stringify(r));
  } else {
    const k = parseInt(ARG1, 10), detik = parseInt(ARG2, 10), akhir = Date.now() + detik * 1000, hasil = [];
    await Promise.all(Array.from({ length: k }, async () => {
      while (Date.now() < akhir) { const s = await tamu(false); hasil.push(...s.hasil); }
    }));
    console.log(JSON.stringify(ringkas('tahan ' + k + ' pengguna terus-menerus ' + detik + ' dtk', hasil, detik)));
  }
})();
