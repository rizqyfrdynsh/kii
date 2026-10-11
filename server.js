'use strict';
/*
 * Server undangan: file statis + API RSVP / ucapan. Tanpa dependensi (Node bawaan saja).
 * Menggantikan http-server pada proses PM2 `undangan` (port 3006, hanya 127.0.0.1, di belakang Cloudflare Tunnel).
 * Data disimpan DI LUAR folder web: DATA_DIR/rsvp.json
 * /admin dikunci kata sandi (sesi cookie bertanda tangan). Kata sandi disimpan sebagai hash scrypt di DATA_DIR/auth.json.
 * Atur / ganti kata sandi dari server:  SANDI_BARU='...' node server.js --set-password
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || '/root/undangan-data';
const PORT = Number(process.env.PORT) || 3006;
const HOST = process.env.HOST || '127.0.0.1';
const BERKAS = path.join(DATA_DIR, 'rsvp.json');

/* ---------- konfigurasi ---------- */
const muatEnv = () => {
  const out = {};
  try {
    fs.readFileSync(path.join(DATA_DIR, '.env'), 'utf8').split(/\r?\n/).forEach((b) => {
      const m = b.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2];
    });
  } catch (e) { /* belum ada */ }
  return out;
};
const ENV = muatEnv();
const GARAM = ENV.IP_SALT || 'undangan';
let SECRET = process.env.SESSION_SECRET || ENV.SESSION_SECRET || '';

/* ---------- penyimpanan ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  try { fs.appendFileSync(path.join(DATA_DIR, '.env'), '\nSESSION_SECRET=' + SECRET + '\n', { mode: 0o600 }); } catch (e) { console.error('gagal menyimpan SESSION_SECRET:', e.message); }
}
const BERKAS_AUTH = path.join(DATA_DIR, 'auth.json');
let auth = null;
try { auth = JSON.parse(fs.readFileSync(BERKAS_AUTH, 'utf8')); } catch (e) { auth = null; }
const hashSandi = (sandi, garam) => crypto.scryptSync(String(sandi), garam, 64).toString('hex');
const setSandi = (sandi) => {
  const garam = crypto.randomBytes(16).toString('hex');
  auth = { garam, hash: hashSandi(sandi, garam) };
  fs.writeFileSync(BERKAS_AUTH, JSON.stringify(auth), { mode: 0o600 });
};
const cekSandi = (sandi) => {
  if (!auth) return false;
  const a = Buffer.from(hashSandi(sandi, auth.garam), 'hex'), b = Buffer.from(auth.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
if (process.argv[2] === '--set-password') {
  const baru = process.env.SANDI_BARU || '';
  if (baru.length < 8) { console.error('SANDI_BARU minimal 8 karakter'); process.exit(1); }
  setSandi(baru); console.log('kata sandi admin diatur'); process.exit(0);
}
let data = [];
try { data = JSON.parse(fs.readFileSync(BERKAS, 'utf8')); if (!Array.isArray(data)) data = []; } catch (e) { data = []; }
let tulisTertunda = false;
const simpan = () => {
  if (tulisTertunda) return;
  tulisTertunda = true;
  setTimeout(() => {
    tulisTertunda = false;
    const tmp = BERKAS + '.tmp';
    fs.writeFile(tmp, JSON.stringify(data, null, 1), (err) => {
      if (err) { console.error('gagal menulis data:', err.message); return; }
      fs.rename(tmp, BERKAS, (e2) => { if (e2) console.error('gagal rename data:', e2.message); });
    });
  }, 150);
};

/* ---------- util ---------- */
const JENIS = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8'
};
const KOMPRES = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt', '.csv']);
const cacheKompres = new Map();
const TERLARANG = new Set(['server.js', 'package.json', 'package-lock.json']);
const kirimJson = (res, kode, obj, tambahan) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(kode, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, tambahan || {}));
  res.end(b);
};
const tunda = (ms) => new Promise((r) => setTimeout(r, ms));
const ipDari = (req) => String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');
const hashIp = (ip) => crypto.createHash('sha256').update(GARAM + ip).digest('hex').slice(0, 16);
const bersih = (t, maks) => String(t == null ? '' : t).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, maks);
const bacaBadan = (req, maks = 8192) => new Promise((ok, gagal) => {
  let n = 0; const bag = [];
  req.on('data', (c) => { n += c.length; if (n > maks) { gagal(new Error('terlalu besar')); req.destroy(); } else bag.push(c); });
  req.on('end', () => ok(Buffer.concat(bag).toString('utf8')));
  req.on('error', gagal);
});
const idBaru = () => crypto.randomBytes(6).toString('hex');

/* batas kirim per IP */
const catatan = new Map();
const kena = (kunci, maks, jendelaMs) => {
  const t = Date.now(), arr = (catatan.get(kunci) || []).filter((x) => t - x < jendelaMs);
  arr.push(t); catatan.set(kunci, arr);
  return arr.length > maks;
};
setInterval(() => { const t = Date.now(); catatan.forEach((v, k) => { if (!v.some((x) => t - x < 3600000)) catatan.delete(k); }); }, 600000).unref();

/* sesi: cookie `adm=<kedaluwarsa>.<hmac>`, berlaku 30 hari; ganti sandi otomatis mencabut semua sesi lama */
const HARI30 = 30 * 86400;
const tandai = (exp) => crypto.createHmac('sha256', SECRET + (auth ? auth.hash : '')).update(String(exp)).digest('hex');
const cookieMasuk = () => { const exp = Date.now() + HARI30 * 1000; return 'adm=' + exp + '.' + tandai(exp) + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=' + HARI30; };
const cookieKeluar = 'adm=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';
const sesiOk = (req) => {
  const m = /(?:^|;\s*)adm=(\d+)\.([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (!m || !auth || Number(m[1]) < Date.now()) return false;
  const a = Buffer.from(m[2], 'hex'), b = Buffer.from(tandai(m[1]), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const asalOk = (req) => {   // permintaan yang mengubah data harus berasal dari situs ini
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch (e) { return false; }
};
const adminOk = (req) => sesiOk(req) && (req.method === 'GET' || asalOk(req));

const HALAMAN_MASUK = `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Masuk · Admin Undangan</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;1,500&family=Jost:wght@300;400;500&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0}body{min-height:100vh;display:grid;place-items:center;padding:20px;color:#f6f0e4;font:300 16px/1.6 Jost,system-ui,sans-serif;background:radial-gradient(ellipse 80% 50% at 50% 0%,#6a1f2e,transparent 70%),linear-gradient(180deg,#4a121c,#2f0f15)}
main{width:min(100%,400px);background:#fbf8f0;color:#2b1a1a;padding:34px 28px;box-shadow:0 24px 40px -22px rgba(0,0,0,.7);text-align:center}
small{display:block;font:400 11px/1 Jost,sans-serif;letter-spacing:.34em;text-transform:uppercase;color:#a0493c}
h1{margin:12px 0 6px;font:500 34px/1.1 'Cormorant Garamond',serif}h1 em{color:#7b1e2b}
p{font-size:14px;color:#6b5450;margin-bottom:22px}
input{width:100%;padding:13px 14px;border:1px solid rgba(43,26,26,.25);font:inherit;font-size:16px;color:#2b1a1a;background:#fff}input:focus{outline:2px solid #7b1e2b;outline-offset:1px}
button{margin-top:14px;width:100%;min-height:46px;border:1px solid #7b1e2b;background:#7b1e2b;color:#f6f0e4;font:400 12px/1 Jost,sans-serif;letter-spacing:.24em;text-transform:uppercase;cursor:pointer}button:disabled{opacity:.6}
.e{min-height:22px;margin-top:12px;font-size:13px;color:#a33}</style></head><body><main>
<small>Portal Admin</small><h1>Undangan <em>Rizqy &amp; Tasya</em></h1><p>Masukkan kata sandi untuk melanjutkan.</p>
<form id="f"><input type="password" id="s" autocomplete="current-password" placeholder="Kata sandi" autofocus required><button id="b" type="submit">Masuk</button><div class="e" id="e" role="alert"></div></form></main>
<script>document.getElementById('f').addEventListener('submit',async function(ev){ev.preventDefault();var b=document.getElementById('b'),e=document.getElementById('e');b.disabled=true;e.textContent='';
try{var r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sandi:document.getElementById('s').value})});var j=await r.json().catch(function(){return{}});
if(r.ok&&j.ok){location.reload();return}e.textContent=j.pesan||'Gagal masuk.'}catch(x){e.textContent='Server tidak terjangkau.'}b.disabled=false})</script></body></html>`;

/* ---------- API ---------- */
async function api(req, res, url) {
  const ip = ipDari(req);

  /* publik: kirim RSVP */
  if (req.method === 'POST' && url.pathname === '/api/rsvp') {
    if (kena('rsvp:' + ip, 6, 600000)) return kirimJson(res, 429, { ok: false, pesan: 'Terlalu sering mengirim, coba beberapa menit lagi.' });
    let b;
    try { b = JSON.parse(await bacaBadan(req)); } catch (e) { return kirimJson(res, 400, { ok: false, pesan: 'Data tidak valid.' }); }
    if (b.situs) return kirimJson(res, 200, { ok: true });   // kolom jebakan bot: pura-pura berhasil
    const nama = bersih(b.nama, 80);
    const hadir = b.hadir === 'Berhalangan hadir' ? 'Berhalangan hadir' : 'Hadir';
    const jumlah = hadir === 'Hadir' ? Math.min(10, Math.max(1, parseInt(b.jumlah, 10) || 1)) : 0;
    const ucapan = bersih(b.ucapan, 500);
    if (!nama) return kirimJson(res, 400, { ok: false, pesan: 'Nama wajib diisi.' });
    const sudah = data.find((x) => x.nama.toLowerCase() === nama.toLowerCase());
    const sekarang = new Date().toISOString();
    if (sudah) { Object.assign(sudah, { hadir, jumlah, ucapan, diperbarui: sekarang, ip: hashIp(ip) }); }
    else data.push({ id: idBaru(), nama, hadir, jumlah, ucapan, waktu: sekarang, tersembunyi: false, ip: hashIp(ip) });
    simpan();
    return kirimJson(res, 200, { ok: true, diperbarui: !!sudah });
  }

  /* publik: daftar ucapan (tanpa data pribadi lain) */
  if (req.method === 'GET' && url.pathname === '/api/ucapan') {
    const batas = Math.min(30, Math.max(1, parseInt(url.searchParams.get('batas'), 10) || 10));
    const sebelum = url.searchParams.get('sebelum') || '';
    const ts = (x) => x.diperbarui || x.waktu;
    const semua = data.filter((x) => x.ucapan && !x.tersembunyi).sort((a, c) => (ts(c) > ts(a) ? 1 : -1));
    const sisa = sebelum ? semua.filter((x) => ts(x) < sebelum) : semua;   // kursor = waktu ucapan terakhir yang sudah dimuat
    return kirimJson(res, 200, {
      total: semua.length,
      ada_lagi: sisa.length > batas,
      item: sisa.slice(0, batas).map((x) => ({ id: x.id, nama: x.nama, ucapan: x.ucapan, waktu: ts(x) }))
    });
  }

  /* masuk / keluar */
  if (req.method === 'POST' && url.pathname === '/api/login') {
    if (kena('login:' + ip, 8, 600000)) return kirimJson(res, 429, { ok: false, pesan: 'Terlalu banyak percobaan, coba lagi sekitar 10 menit.' });
    let b; try { b = JSON.parse(await bacaBadan(req, 2048)); } catch (e) { return kirimJson(res, 400, { ok: false, pesan: 'Data tidak valid.' }); }
    await tunda(450);
    if (!asalOk(req) || !cekSandi(b.sandi)) return kirimJson(res, 401, { ok: false, pesan: 'Kata sandi salah.' });
    return kirimJson(res, 200, { ok: true }, { 'Set-Cookie': cookieMasuk() });
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') return kirimJson(res, 200, { ok: true }, { 'Set-Cookie': cookieKeluar });

  /* admin */
  if (url.pathname.startsWith('/api/admin/')) {
    if (kena('admin:' + ip, 40, 60000)) return kirimJson(res, 429, { ok: false, pesan: 'Terlalu banyak permintaan.' });
    if (!adminOk(req)) return kirimJson(res, 401, { ok: false, pesan: 'Belum masuk.' });
    if (req.method === 'GET' && url.pathname === '/api/admin/rsvp') {
      const hadir = data.filter((x) => x.hadir === 'Hadir');
      return kirimJson(res, 200, {
        ringkas: { total: data.length, hadir: hadir.length, berhalangan: data.length - hadir.length, orang: hadir.reduce((a, x) => a + (x.jumlah || 0), 0), ucapan: data.filter((x) => x.ucapan).length },
        item: data.slice().sort((a, c) => ((c.diperbarui || c.waktu) > (a.diperbarui || a.waktu) ? 1 : -1)).map(({ ip: _ip, ...x }) => x)
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/sandi') {
      let b; try { b = JSON.parse(await bacaBadan(req, 2048)); } catch (e) { return kirimJson(res, 400, { ok: false }); }
      await tunda(450);
      if (!cekSandi(b.lama)) return kirimJson(res, 403, { ok: false, pesan: 'Kata sandi lama salah.' });
      if (String(b.baru || '').length < 8) return kirimJson(res, 400, { ok: false, pesan: 'Kata sandi baru minimal 8 karakter.' });
      setSandi(String(b.baru));
      return kirimJson(res, 200, { ok: true }, { 'Set-Cookie': cookieMasuk() });
    }
    if (req.method === 'POST') {
      let b; try { b = JSON.parse(await bacaBadan(req)); } catch (e) { return kirimJson(res, 400, { ok: false }); }
      const x = data.find((d) => d.id === b.id);
      if (!x) return kirimJson(res, 404, { ok: false, pesan: 'Tidak ditemukan.' });
      if (url.pathname === '/api/admin/sembunyi') { x.tersembunyi = !!b.tersembunyi; simpan(); return kirimJson(res, 200, { ok: true }); }
      if (url.pathname === '/api/admin/hapus') { data = data.filter((d) => d.id !== b.id); simpan(); return kirimJson(res, 200, { ok: true }); }
    }
  }
  return kirimJson(res, 404, { ok: false });
}

/* ---------- file statis ---------- */
function statis(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let p;
  try { p = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p.includes('\0')) { res.writeHead(400); return res.end(); }
  const bagian = p.split('/').filter(Boolean);
  if (bagian.some((s) => s.startsWith('.') || TERLARANG.has(s))) { res.writeHead(404); return res.end('Tidak ditemukan'); }
  const khusus = bagian[0] === 'admin';
  if (khusus && !sesiOk(req)) {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff' });
    return res.end(req.method === 'HEAD' ? undefined : HALAMAN_MASUK);
  }
  let berkas = path.join(ROOT, ...bagian);
  if (!berkas.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.stat(berkas, (err, st) => {
    if (!err && st.isDirectory()) {
      if (!p.endsWith('/')) { res.writeHead(302, { Location: p + '/' + url.search }); return res.end(); }
      berkas = path.join(berkas, 'index.html');
    }
    fs.stat(berkas, (e2, s2) => {
      if (e2 || !s2.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Tidak ditemukan'); }
      const ext = path.extname(berkas).toLowerCase();
      const jenis = JENIS[ext] || 'application/octet-stream';
      const abadi = bagian[0] === 'aset';   // berkas ber-hash dari bangun.py: aman di-cache setahun (juga oleh Cloudflare)
      const etag = 'W/"' + s2.size.toString(16) + '-' + Math.floor(s2.mtimeMs).toString(16) + '"';
      const h = {
        'Content-Type': jenis, ETag: etag, Vary: 'Accept-Encoding', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Cache-Control': khusus ? 'private, no-store' : abadi ? 'public, max-age=31536000, immutable' : (bagian[0] === 'img' || bagian[0] === 'musik') ? 'public, max-age=86400' : 'public, max-age=60'
      };
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, h); return res.end(); }
      const ae = String(req.headers['accept-encoding'] || '');
      const br = /\bbr\b/.test(ae), gz = /\bgzip\b/.test(ae);
      if (KOMPRES.has(ext) && s2.size > 1024 && (br || gz)) {   // teks dikompres sekali lalu disimpan di memori (br untuk browser modern, gzip cadangan)
        let c = cacheKompres.get(berkas);
        if (!c || c.mtime !== s2.mtimeMs) {
          let isi; try { isi = fs.readFileSync(berkas); } catch (e) { res.writeHead(404); return res.end(); }
          c = { mtime: s2.mtimeMs, br: zlib.brotliCompressSync(isi, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }), gz: zlib.gzipSync(isi, { level: 9 }) };
          cacheKompres.set(berkas, c);
        }
        const badan = br ? c.br : c.gz;
        h['Content-Encoding'] = br ? 'br' : 'gzip'; h['Content-Length'] = badan.length;
        res.writeHead(200, h);
        return req.method === 'HEAD' ? res.end() : res.end(badan);
      }
      const rg = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
      if (rg && (rg[1] || rg[2])) {   // Range: wajib agar audio bisa diputar & digeser di Safari/iOS
        let mulai = rg[1] ? parseInt(rg[1], 10) : Math.max(0, s2.size - parseInt(rg[2], 10));
        let akhir = rg[1] && rg[2] ? Math.min(parseInt(rg[2], 10), s2.size - 1) : s2.size - 1;
        if (mulai >= s2.size || mulai > akhir) { res.writeHead(416, { 'Content-Range': 'bytes */' + s2.size }); return res.end(); }
        h['Content-Range'] = 'bytes ' + mulai + '-' + akhir + '/' + s2.size; h['Content-Length'] = akhir - mulai + 1; h['Accept-Ranges'] = 'bytes';
        res.writeHead(206, h);
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(berkas, { start: mulai, end: akhir }).on('error', () => res.destroy()).pipe(res);
      }
      h['Content-Length'] = s2.size; h['Accept-Ranges'] = 'bytes';
      res.writeHead(200, h);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(berkas).on('error', () => res.destroy()).pipe(res);
    });
  });
}

http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch((e) => { console.error('api error:', e.message); if (!res.headersSent) kirimJson(res, 500, { ok: false }); });
  } else statis(req, res, url);
}).listen(PORT, HOST, () => console.log('undangan server di ' + HOST + ':' + PORT + ' | data: ' + BERKAS + ' | admin ' + (auth ? 'terkunci sandi' : 'BELUM ADA SANDI (jalankan --set-password)')));
