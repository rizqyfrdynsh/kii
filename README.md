# Undangan Pernikahan Rizqy & Tasya

Web undangan satu halaman + portal admin + server kecil (Node tanpa dependensi).

- `index.html` : SUMBER undangan (satu berkas: CSS + JS inline). Data ada di objek `UNDANGAN` di bagian script.
- `v2/index.html` : VERSI 2 undangan (desain alternatif, satu berkas, data `UNDANGAN` sama), tampil di `/v2/`.
- `admin/index.html` : portal admin (login kata sandi, generator tautan tamu, rekap RSVP & ucapan).
- `server.js` : server statis + API (`/api/rsvp`, `/api/ucapan`, `/api/login`, `/api/admin/*`), kompres brotli/gzip, HTTP Range.
- `bangun.py` : memecah `index.html` menjadi `dist/index.html` + `dist/aset/*.css|js` ber-hash (cache setahun).
- `uji-beban.js` : uji beban sederhana.
- `CHECKPOINT.md` : catatan tiap revisi (CP01 dst.) dan cara rollback.

Tidak ikut repo (ada di mesin lokal pemilik): `deploy.py`, `img/` (foto), `musik/` (lagu), `checkpoint/`, `dist/`, data server.

Pratinjau lokal: `python bangun.py`, lalu jalankan `node server.js` di dalam `dist/` (salin `server.js` ke sana) dengan `PORT=3999 DATA_DIR=./data`.
Set kata sandi admin: `SANDI_BARU='...' DATA_DIR=./data node server.js --set-password`.
