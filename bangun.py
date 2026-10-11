#!/usr/bin/env python3
"""Bangun versi produksi: index.html (sumber, satu berkas) -> dist/
  - <style> besar   -> dist/aset/gaya.<hash>.css
  - <script> utama  -> dist/aset/app.<hash>.js   (data UNDANGAN tetap inline di HTML supaya mudah diedit)
Berkas di /aset/ ber-hash, jadi boleh di-cache setahun oleh browser dan Cloudflare; halaman HTML tinggal ~5 KB,
sehingga tunnel (jalur lambat) hampir tidak terbebani. Sumber (index.html) tidak diubah.
Pemakaian:  python bangun.py            (hanya bangun)
            python deploy.py            (bangun + unggah ke VPS)
"""
import hashlib
import io
import os
import re
import shutil
import sys

AKAR = os.path.dirname(os.path.abspath(__file__))
SUMBER = os.path.join(AKAR, 'index.html')
DIST = os.path.join(AKAR, 'dist')


def hash_(teks):
    return hashlib.sha1(teks.encode('utf-8')).hexdigest()[:10]


def main():
    s = io.open(SUMBER, encoding='utf-8', newline='').read()

    m = re.search(r'<style>(.*?)</style>', s, re.S)
    if not m:
        sys.exit('gagal: <style> tidak ditemukan')
    css = m.group(1)

    akhir = s.index('</body>')
    i = s.rindex('<script>', 0, akhir)
    j = s.index('</script>', i)
    js = s[i + len('<script>'):j]
    if 'const UNDANGAN' not in js:
        sys.exit('gagal: <script> utama (berisi UNDANGAN) tidak ditemukan')
    k = js.index('\n(() => {')
    cfg, app = js[:k], js[k:]

    hc, ha = hash_(css), hash_(app)
    if os.path.isdir(DIST):
        shutil.rmtree(DIST)
    os.makedirs(os.path.join(DIST, 'aset'))
    io.open(os.path.join(DIST, 'aset', 'gaya.%s.css' % hc), 'w', encoding='utf-8', newline='').write(css)
    io.open(os.path.join(DIST, 'aset', 'app.%s.js' % ha), 'w', encoding='utf-8', newline='').write(app)

    out = s[:m.start()] + '<link rel="stylesheet" href="/aset/gaya.%s.css">' % hc + s[m.end():]
    # posisi i/j bergeser karena penggantian <style>; hitung ulang pada teks baru
    akhir = out.index('</body>')
    i = out.rindex('<script>', 0, akhir)
    j = out.index('</script>', i)
    out = out[:i] + '<script>' + cfg + '\n</script>\n<script src="/aset/app.%s.js" defer></script>' % ha + out[j + len('</script>'):]
    if os.path.isdir(os.path.join(AKAR, 'img')):   # foto galeri & gambar pratinjau WhatsApp
        shutil.copytree(os.path.join(AKAR, 'img'), os.path.join(DIST, 'img'))
    if os.path.isdir(os.path.join(AKAR, 'musik')):   # lagu latar (opsional)
        shutil.copytree(os.path.join(AKAR, 'musik'), os.path.join(DIST, 'musik'))
    if os.path.isdir(os.path.join(AKAR, 'v2')):   # versi 2 (satu berkas, disalin apa adanya) -> /v2/
        shutil.copytree(os.path.join(AKAR, 'v2'), os.path.join(DIST, 'v2'))
    io.open(os.path.join(DIST, 'index.html'), 'w', encoding='utf-8', newline='').write(out)

    kb = lambda t: round(len(t.encode('utf-8')) / 1024, 1)
    print('sumber %s KB -> halaman %s KB + gaya %s KB + app %s KB' % (kb(s), kb(out), kb(css), kb(app)))
    print('gaya.%s.css  app.%s.js' % (hc, ha))


if __name__ == '__main__':
    main()
