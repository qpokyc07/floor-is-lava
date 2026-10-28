/**
 * Отрисовка AR-слоя: лава, камни, круги под ногами, искры, разметка.
 *
 * Всё рисуется в координатах видеокадра (пиксели), а преобразование в экран
 * задаётся один раз через ctx.setTransform — так геометрия остаётся корректной
 * при любом размере окна.
 */

const SUB = 3; // подквадратов на плитку по каждой оси

const STOPS = [
  [0.00, [24, 6, 3]],
  [0.22, [62, 13, 4]],
  [0.40, [124, 27, 5]],
  [0.56, [196, 55, 6]],
  [0.70, [246, 108, 12]],
  [0.84, [255, 172, 48]],
  [1.00, [255, 240, 196]],
];

function buildPalette(n = 56) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    let a = STOPS[0];
    let b = STOPS[STOPS.length - 1];
    for (let k = 0; k < STOPS.length - 1; k++) {
      if (t >= STOPS[k][0] && t <= STOPS[k + 1][0]) {
        a = STOPS[k];
        b = STOPS[k + 1];
        break;
      }
    }
    const f = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
    const r = Math.round(a[1][0] + (b[1][0] - a[1][0]) * f);
    const g = Math.round(a[1][1] + (b[1][1] - a[1][1]) * f);
    const bl = Math.round(a[1][2] + (b[1][2] - a[1][2]) * f);
    out[i] = `rgb(${r},${g},${bl})`;
  }
  return out;
}

const PAL = buildPalette();

function hash2(ix, iy) {
  let h = Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise(x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0);
  const b = hash2(x0 + 1, y0);
  const c = hash2(x0, y0 + 1);
  const d = hash2(x0 + 1, y0 + 1);
  const top = a + (b - a) * sx;
  const bot = c + (d - c) * sx;
  return top + (bot - top) * sy;
}

function lavaHeat(x, y, t) {
  const n1 = vnoise(x * 1.9 - t * 0.12, y * 1.9 + t * 0.21);
  const n2 = vnoise(x * 4.3 + 13.7 + t * 0.3, y * 4.3 - 7.1 - t * 0.17);
  let h = 0.13 + n1 * 0.74 + n2 * 0.19;
  h *= 0.85 + 0.15 * Math.sin(t * 2.1 + n1 * 9.0);
  return h < 0 ? 0 : h > 1 ? 1 : h;
}

const Q = new Float64Array(8);

function projPoint(H, x, y, out, off) {
  const w = H[6] * x + H[7] * y + H[8];
  const iw = Math.abs(w) < 1e-9 ? 1e9 : 1 / w;
  out[off] = (H[0] * x + H[1] * y + H[2]) * iw;
  out[off + 1] = (H[3] * x + H[4] * y + H[5]) * iw;
}

function projectQuad(H, x0, y0, x1, y1, out) {
  projPoint(H, x0, y0, out, 0);
  projPoint(H, x1, y0, out, 2);
  projPoint(H, x1, y1, out, 4);
  projPoint(H, x0, y1, out, 6);
  return out;
}

function fillQuad(ctx, q, grow) {
  let cx = 0;
  let cy = 0;
  if (grow) {
    cx = (q[0] + q[2] + q[4] + q[6]) * 0.25;
    cy = (q[1] + q[3] + q[5] + q[7]) * 0.25;
  }
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    let x = q[i * 2];
    let y = q[i * 2 + 1];
    if (grow) {
      const dx = x - cx;
      const dy = y - cy;
      const len = Math.hypot(dx, dy) || 1;
      x += (dx / len) * grow;
      y += (dy / len) * grow;
    }
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

function strokePoly(ctx, pts) {
  if (!pts.length) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.stroke();
}

function fillPoly(ctx, pts) {
  if (!pts.length) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fill();
}

/**
 * Добавляет в текущий путь многоугольник с ПРАВИЛЬНОЙ (положительной) намоткой.
 * Это важно: при заливке по правилу nonzero подпути с разной намоткой
 * взаимно гасятся и в силуэте появляются дыры.
 */
function emitPoly(ctx, pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  const q = s >= 0 ? pts : pts.slice().reverse();
  ctx.moveTo(q[0].x, q[0].y);
  for (let i = 1; i < q.length; i++) ctx.lineTo(q[i].x, q[i].y);
  ctx.closePath();
}

/**
 * Добавляет в текущий путь капсулу (толстый отрезок с круглыми торцами).
 * Нужна для силуэта человека.
 */
function addCapsule(ctx, a, b, r) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * r;
  const ny = (dx / len) * r;
  emitPoly(ctx, [
    { x: a.x + nx, y: a.y + ny },
    { x: b.x + nx, y: b.y + ny },
    { x: b.x - nx, y: b.y - ny },
    { x: a.x - nx, y: a.y - ny },
  ]);
  // ctx.arc(x, y, r, 0, 2PI) идёт с положительной намоткой — как и emitPoly
  ctx.moveTo(a.x + r, a.y);
  ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
  ctx.moveTo(b.x + r, b.y);
  ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
}

/**
 * Строит в текущем пути силуэт человека по точкам скелета.
 * Возвращает false, если ключевых точек не хватает.
 */
function buildBodyPath(ctx, lm, sw, sh, grow) {
  const visOk = (i) => lm[i] && (lm[i].visibility == null || lm[i].visibility > 0.25);
  const need = [11, 12, 23, 24, 25, 26, 27, 28];
  for (const i of need) if (!visOk(i)) return false;
  const P = (i) => ({ x: lm[i].x * sw, y: lm[i].y * sh });

  const Ls = P(11);
  const Rs = P(12);
  const Lh = P(23);
  const Rh = P(24);
  const Lk = P(25);
  const Rk = P(26);
  const La = P(27);
  const Ra = P(28);

  const hipW = Math.hypot(Rh.x - Lh.x, Rh.y - Lh.y) || 40;
  const k = grow;
  const rThigh = hipW * 0.24 * k;
  const rShin = hipW * 0.18 * k;
  const rFoot = hipW * 0.13 * k;

  // ноги
  addCapsule(ctx, Lh, Lk, rThigh);
  addCapsule(ctx, Rh, Rk, rThigh);
  addCapsule(ctx, Lk, La, rShin);
  addCapsule(ctx, Rk, Ra, rShin);

  // стопы
  const foot = (ankle, toeIdx, heelIdx) => {
    if (!visOk(toeIdx) && !visOk(heelIdx)) return;
    const t = visOk(toeIdx) ? P(toeIdx) : P(heelIdx);
    addCapsule(ctx, ankle, t, rFoot);
  };
  foot(La, 31, 29);
  foot(Ra, 32, 30);

  // торс
  const cx = (Ls.x + Rs.x + Lh.x + Rh.x) * 0.25;
  const cy = (Ls.y + Rs.y + Lh.y + Rh.y) * 0.25;
  const inf = (p) => ({ x: cx + (p.x - cx) * 1.06, y: cy + (p.y - cy) * 1.06 });
  emitPoly(ctx, [inf(Ls), inf(Rs), inf(Rh), inf(Lh)]);

  // голова
  if (visOk(0)) {
    const head = P(0);
    const shW = Math.hypot(Rs.x - Ls.x, Rs.y - Ls.y) || 60;
    const rHead = shW * 0.3 * k;
    ctx.moveTo(head.x + rHead, head.y);
    ctx.arc(head.x, head.y, rHead, 0, Math.PI * 2);
  }
  return true;
}

/** Прямоугольник со скруглёнными углами в координатах пола. */
function roundedRect(x0, y0, x1, y1, rad, seg = 3) {
  const pts = [];
  const r = Math.min(rad, (x1 - x0) * 0.45, (y1 - y0) * 0.45);
  const corners = [
    [x1 - r, y0 + r, -Math.PI / 2, 0],
    [x1 - r, y1 - r, 0, Math.PI / 2],
    [x0 + r, y1 - r, Math.PI / 2, Math.PI],
    [x0 + r, y0 + r, Math.PI, Math.PI * 1.5],
  ];
  for (let k = 0; k < 4; k++) {
    const c = corners[k];
    for (let i = 0; i <= seg; i++) {
      const a = c[2] + ((c[3] - c[2]) * i) / seg;
      pts.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
    }
  }
  return pts;
}

export class Renderer {
  constructor() {
    this.embers = [];
    this.shake = 0;
    this.flash = 0;
    this.pxPerM = 400;
    this.occlusion = true;
  }

  burst() {
    this.shake = 1;
    this.flash = 1;
  }

  updateEmbers(dt, game, fm) {
    const spawnRate = game && game.started && !game.dead ? 46 : 14;
    const want = Math.round(spawnRate * dt);
    for (let i = 0; i < want; i++) {
      if (this.embers.length > 90) break;
      this.embers.push({
        x: Math.random() * game.width,
        y: Math.random() * game.depth,
        z: 0,
        vz: 0.25 + Math.random() * 0.55,
        vx: (Math.random() - 0.5) * 0.12,
        vy: (Math.random() - 0.5) * 0.12,
        life: 0,
        max: 0.7 + Math.random() * 0.9,
        sz: 0.8 + Math.random() * 1.8,
        hot: 0.4 + Math.random() * 0.6,
      });
    }
    for (let i = this.embers.length - 1; i >= 0; i--) {
      const e = this.embers[i];
      e.life += dt;
      e.z += e.vz * dt;
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      if (e.life > e.max) this.embers.splice(i, 1);
    }
    this.shake = Math.max(0, this.shake - dt * 2.2);
    this.flash = Math.max(0, this.flash - dt * 2.6);
  }

  draw(ctx, o) {
    const view = o.view;
    const fm = o.floorMap;
    const game = o.game;
    const time = o.time;
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#050302';
    ctx.fillRect(0, 0, cw, ch);

    if (o.video && o.video.readyState >= 2) {
      ctx.setTransform(view.scale, 0, 0, view.scale, view.ox, view.oy);
      try {
        ctx.drawImage(o.video, 0, 0, view.sw, view.sh);
      } catch (_) { /* кадр ещё не готов */ }
    }

    if (!fm.ready) {
      this.drawCalibTaps(ctx, o);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return;
    }

    const amp = this.shake * 14;
    const sx = amp ? (Math.random() - 0.5) * amp : 0;
    const sy = amp ? (Math.random() - 0.5) * amp : 0;
    ctx.setTransform(view.scale, 0, 0, view.scale, view.ox + sx, view.oy + sy);

    const center = fm.toScreen(game.width * 0.5, game.depth * 0.5);
    const ahead = fm.toScreen(game.width * 0.5, game.depth * 0.5 + 0.5);
    if (center && ahead) {
      const d = Math.hypot(center.x - ahead.x, center.y - ahead.y) / 0.5;
      if (d > 20 && d < 20000) this.pxPerM = d;
    }

    this.drawLava(ctx, game, fm, time);
    this.drawGrid(ctx, game, fm);
    this.drawStones(ctx, game, fm, time);
    this.drawAreaBorder(ctx, game, fm);
    this.drawEmbers(ctx, game, fm);
    this.drawFeet(ctx, game, fm, o.feet, time);
    this.drawPlayer(ctx, game, fm, time);
    if (o.debug && o.landmarks) this.drawDebug(ctx, o.landmarks, view);

    // возвращаем «живого» человека поверх лавы — иначе ноги закрашены
    if (this.occlusion && this.shake < 0.05) this.occludeBody(ctx, o);

    if (o.mode === 'calib') this.drawCalibTaps(ctx, o);

    if (this.flash > 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = `rgba(255,90,30,${0.35 * this.flash})`;
      ctx.fillRect(0, 0, cw, ch);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  drawLava(ctx, game, fm, time) {
    const H = fm.H;
    const tw = game.tileW;
    const th = game.tileH;
    for (let r = 0; r < game.rows; r++) {
      for (let c = 0; c < game.cols; c++) {
        const isStone = game.safe[r * game.cols + c] === 1;
        for (let sy = 0; sy < SUB; sy++) {
          for (let sx = 0; sx < SUB; sx++) {
            const x0 = (c + sx / SUB) * tw;
            const x1 = (c + (sx + 1) / SUB) * tw;
            const y0 = (r + sy / SUB) * th;
            const y1 = (r + (sy + 1) / SUB) * th;
            let heat = lavaHeat((x0 + x1) * 0.5, (y0 + y1) * 0.5, time);
            if (isStone) heat *= 0.3;
            projectQuad(H, x0, y0, x1, y1, Q);
            ctx.fillStyle = PAL[(heat * (PAL.length - 1)) | 0];
            fillQuad(ctx, Q, 0.9);
          }
        }
      }
    }
  }

  drawGrid(ctx, game, fm) {
    ctx.strokeStyle = 'rgba(24,5,0,0.5)';
    ctx.lineWidth = Math.max(1, this.pxPerM * 0.012);
    for (let c = 1; c < game.cols; c++) {
      const x = c * game.tileW;
      const a = fm.toScreen(x, 0);
      const b = fm.toScreen(x, game.depth);
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (let r = 1; r < game.rows; r++) {
      const y = r * game.tileH;
      const a = fm.toScreen(0, y);
      const b = fm.toScreen(game.width, y);
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  drawStones(ctx, game, fm, time) {
    const warn = game.warnProgress;
    const pulse = 0.5 + 0.5 * Math.sin(time * 9);
    const pad = Math.min(game.tileW, game.tileH) * 0.09;
    const rad = Math.min(game.tileW, game.tileH) * 0.2;
    const seg = 3;

    for (let r = 0; r < game.rows; r++) {
      for (let c = 0; c < game.cols; c++) {
        const i = r * game.cols + c;
        const isSafe = game.safe[i] === 1;
        const willSafe = game.next && game.next[i] === 1;
        const dying = isSafe && warn > 0 && !willSafe;
        const ghost = !isSafe && warn > 0 && willSafe;
        if (!isSafe && !ghost) continue;

        const sink = dying ? warn * 0.55 : 0;
        const x0 = c * game.tileW + pad + sink * 0.06;
        const y0 = r * game.tileH + pad + sink * 0.06;
        const x1 = (c + 1) * game.tileW - pad - sink * 0.06;
        const y1 = (r + 1) * game.tileH - pad - sink * 0.06;
        if (x1 <= x0 || y1 <= y0) continue;

        const pts = roundedRect(x0, y0, x1, y1, rad, seg).map((p) => {
          const s = fm.toScreen(p[0], p[1]);
          return s ? [s.x, s.y] : [0, 0];
        });

        if (ghost) {
          ctx.globalAlpha = 0.35 + 0.35 * pulse;
          ctx.strokeStyle = '#8ff6ff';
          ctx.lineWidth = Math.max(1, this.pxPerM * 0.02);
          strokePoly(ctx, pts);
          ctx.globalAlpha = 1;
          continue;
        }

        // тень-подложка
        ctx.fillStyle = 'rgba(3,10,16,0.55)';
        ctx.globalAlpha = dying ? 0.4 + 0.3 * pulse : 0.65;
        fillPoly(ctx, pts);
        ctx.globalAlpha = 1;

        // тело камня
        const gx = pts[6][0] - pts[0][0];
        const gy = pts[6][1] - pts[0][1];
        if (Math.hypot(gx, gy) < 2) {
          ctx.fillStyle = dying ? '#5a1d10' : '#12374d';
        } else {
          const g = ctx.createLinearGradient(pts[0][0], pts[0][1], pts[6][0], pts[6][1]);
          if (dying) {
            g.addColorStop(0, 'rgba(120,40,20,1)');
            g.addColorStop(1, 'rgba(60,18,10,1)');
          } else {
            g.addColorStop(0, '#1d4d66');
            g.addColorStop(1, '#0a1d2b');
          }
          ctx.fillStyle = g;
        }
        fillPoly(ctx, pts);

        // светящаяся кромка
        const rim = dying ? '#ff6a3d' : '#7ff0ff';
        ctx.strokeStyle = rim;
        ctx.globalAlpha = dying ? 0.35 + 0.45 * pulse : 0.75;
        ctx.lineWidth = Math.max(1.5, this.pxPerM * 0.026);
        strokePoly(ctx, pts);
        ctx.globalAlpha = dying ? 0.12 + 0.2 * pulse : 0.22;
        ctx.lineWidth = Math.max(4, this.pxPerM * 0.075);
        strokePoly(ctx, pts);
        ctx.globalAlpha = 1;
      }
    }
  }

  drawAreaBorder(ctx, game, fm) {
    const pts = [
      fm.toScreen(0, 0),
      fm.toScreen(game.width, 0),
      fm.toScreen(game.width, game.depth),
      fm.toScreen(0, game.depth),
    ];
    if (pts.some((p) => !p)) return;
    const arr = pts.map((p) => [p.x, p.y]);
    ctx.strokeStyle = 'rgba(127,240,255,0.55)';
    ctx.lineWidth = Math.max(2, this.pxPerM * 0.03);
    strokePoly(ctx, arr);
    ctx.strokeStyle = 'rgba(127,240,255,0.16)';
    ctx.lineWidth = Math.max(7, this.pxPerM * 0.09);
    strokePoly(ctx, arr);
  }

  drawEmbers(ctx, game, fm) {
    if (!this.embers.length) return;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.embers.length; i++) {
      const e = this.embers[i];
      const p = fm.toScreen(e.x, e.y);
      if (!p) continue;
      const k = 1 - e.life / e.max;
      const y = p.y - e.z * this.pxPerM * 0.5;
      const r = e.sz * (0.6 + k * 0.8);
      ctx.fillStyle = `rgba(255,${Math.round(120 + 90 * e.hot)},${Math.round(40 + 120 * k)},${0.5 * k})`;
      ctx.beginPath();
      ctx.arc(p.x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  drawFeet(ctx, game, fm, feet, time) {
    if (!feet) return;
    for (let i = 0; i < feet.length; i++) {
      const f = feet[i];
      if (!f || !f.seen || !f.hasFloor) continue;
      const onLava = game.footOnLava ? game.footOnLava[i] : false;
      const danger = game.footDanger ? game.footDanger[i] : 0;
      const down = f.down;
      const R = 0.15;
      const N = 18;
      const pts = [];
      for (let k = 0; k < N; k++) {
        const a = (k / N) * Math.PI * 2;
        const p = fm.toScreen(f.fx + Math.cos(a) * R, f.fy + Math.sin(a) * R);
        if (p) pts.push([p.x, p.y]);
      }
      if (pts.length < 6) continue;

      const dim = down ? 1 : 0.45;
      const col = onLava ? '255,74,40' : '127,240,255';
      const rp = 0.5 + 0.5 * Math.sin(time * (onLava ? 16 : 5) + i);

      ctx.fillStyle = `rgba(${col},${(0.1 + 0.16 * rp) * dim})`;
      fillPoly(ctx, pts);
      ctx.strokeStyle = `rgba(${col},${0.9 * dim})`;
      ctx.lineWidth = Math.max(2, this.pxPerM * 0.022);
      strokePoly(ctx, pts);
      ctx.strokeStyle = `rgba(${col},${0.18 * dim})`;
      ctx.lineWidth = Math.max(6, this.pxPerM * 0.07);
      strokePoly(ctx, pts);

      if (danger > 0.02) {
        const k = Math.min(1, danger / 0.3);
        ctx.fillStyle = `rgba(255,40,0,${0.28 * k})`;
        fillPoly(ctx, pts);
      }
    }
  }

  drawPlayer(ctx, game, fm, time) {
    const cell = game.playerCell;
    if (!cell || !game.started) return;
    const x0 = cell.c * game.tileW;
    const y0 = cell.r * game.tileH;
    const pts = roundedRect(x0, y0, x0 + game.tileW, y0 + game.tileH, 0.05, 2).map((p) => {
      const s = fm.toScreen(p[0], p[1]);
      return s ? [s.x, s.y] : [0, 0];
    });
    const safe = game.isSafeCell(cell.c, cell.r);
    ctx.globalAlpha = 0.5 + 0.2 * Math.sin(time * 4);
    ctx.strokeStyle = safe ? 'rgba(190,255,255,0.9)' : 'rgba(255,120,60,0.9)';
    ctx.lineWidth = Math.max(1.5, this.pxPerM * 0.016);
    strokePoly(ctx, pts);
    ctx.globalAlpha = 1;
  }

  drawCalibTaps(ctx, o) {
    const taps = o.calibTaps || [];
    const view = o.view;
    const size = Math.max(18, view.sh * 0.035);
    const width = Math.max(3, size * 0.16);
    ctx.setTransform(view.scale, 0, 0, view.scale, view.ox, view.oy);
    for (let i = 0; i < taps.length; i++) {
      const p = taps[i];
      ctx.beginPath();
      ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fill();
      ctx.lineWidth = width;
      ctx.strokeStyle = '#7ff0ff';
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.x - size * 1.5, p.y);
      ctx.lineTo(p.x + size * 1.5, p.y);
      ctx.moveTo(p.x, p.y - size * 1.5);
      ctx.lineTo(p.x, p.y + size * 1.5);
      ctx.strokeStyle = 'rgba(127,240,255,0.55)';
      ctx.lineWidth = width * 0.7;
      ctx.stroke();
      ctx.font = `bold ${Math.round(size * 1.3)}px "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#eaffff';
      ctx.fillText(String(i + 1), p.x, p.y - size * 2.1);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /**
   * Возвращает на место пиксели человека: лава рисуется поверх видео и иначе
   * закрывала бы ноги. Силуэт строится по скелету и вырезается из AR-слоя.
   */
  occludeBody(ctx, o) {
    const view = o.view;
    if (!o.landmarks || !o.video || o.video.readyState < 2) return;
    ctx.setTransform(view.scale, 0, 0, view.scale, view.ox, view.oy);
    ctx.beginPath();
    if (!buildBodyPath(ctx, o.landmarks, view.sw, view.sh, 1.15)) return;
    ctx.save();
    ctx.clip();
    try {
      ctx.drawImage(o.video, 0, 0, view.sw, view.sh);
    } catch (_) { /* кадр не готов */ }
    ctx.restore();
    ctx.setTransform(view.scale, 0, 0, view.scale, view.ox, view.oy);
  }

  /** Служебный слой: точки скелета и сырые точки стоп (клавиша D). */
  drawDebug(ctx, lm, view) {
    const sw = view.sw;
    const sh = view.sh;
    const r = Math.max(2, sh * 0.005);
    for (let i = 0; i < lm.length; i++) {
      const p = lm[i];
      if (!p) continue;
      const vis = p.visibility == null ? 1 : p.visibility;
      if (vis < 0.3) continue;
      const key = i === 27 || i === 28 || i === 29 || i === 30 || i === 31 || i === 32;
      ctx.fillStyle = key ? '#ffe14d' : 'rgba(120,255,170,0.75)';
      ctx.beginPath();
      ctx.arc(p.x * sw, p.y * sh, key ? r * 1.8 : r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
