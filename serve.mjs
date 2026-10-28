/**
 * Локальный сервер без зависимостей.
 *
 *   node serve.mjs          — http://localhost:8080 (для проверки на компьютере)
 *   node serve.mjs 3000     — другой порт
 *
 * ВАЖНО про камеру: браузеры отдают доступ к камере только в «безопасном
 * контексте» — это https:// или http://localhost. По адресу http://192.168.x.x
 * с телефона камера будет заблокирована. Варианты:
 *   1) туннель:      cloudflared tunnel --url http://localhost:8080
 *                    npx localtunnel --port 8080
 *   2) выложить папку на Netlify Drop / GitHub Pages (там сразу https)
 *   3) положить рядом cert.pem и key.pem (например, из mkcert) — сервер сам
 *      поднимет https на порту 8443, а сертификат надо поставить на телефон
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};

function handler(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch (_) {
    res.writeHead(400).end('bad request');
    return;
  }
  if (urlPath.endsWith('/')) urlPath += 'index.html';

  const target = path.join(ROOT, path.normalize(urlPath).replace(/^([/\\])+/, ''));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404: ' + urlPath);
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*',
    });
    fs.createReadStream(target).pipe(res);
  });
}

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    }
  }
  return out;
}

http.createServer(handler).listen(PORT, '0.0.0.0', () => {
  const lan = lanAddresses();
  console.log('');
  console.log('  🔥 Пол — это лава');
  console.log('  ────────────────────────────────────────────────');
  console.log(`  на компьютере:  http://localhost:${PORT}`);
  for (const ip of lan) console.log(`  в сети:         http://${ip}:${PORT}   (камера по http не откроется)`);
  console.log('  ────────────────────────────────────────────────');
  console.log('  Камера работает только по https:// или на localhost.');
  console.log('  С телефона: туннель (cloudflared / localtunnel) или Netlify Drop.');
  console.log('');
});

const keyPath = path.join(ROOT, 'key.pem');
const certPath = path.join(ROOT, 'cert.pem');
if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  try {
    https
      .createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, handler)
      .listen(HTTPS_PORT, '0.0.0.0', () => {
        console.log(`  🔒 https://0.0.0.0:${HTTPS_PORT} — сертификат из key.pem/cert.pem`);
        console.log('');
      });
  } catch (e) {
    console.warn('  ⚠️  не удалось поднять https:', e.message);
  }
} else {
  console.log('  (подсказка: положите сюда cert.pem и key.pem — поднимется https)');
  console.log('');
}
