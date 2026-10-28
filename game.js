/**
 * Правила игры «пол — это лава».
 *
 * Площадка бьётся на плитки. Большая часть плиток — лава, небольшая часть —
 * безопасные камни. Раз в несколько секунд камни «тонут» и всплывают в другом
 * месте: сначала короткое предупреждение, потом смена. Если стопа оказалась
 * на лаве дольше GRACE секунд — конец игры.
 */

const TARGET_TILE = 0.58;  // желаемый размер плитки, м
const GRACE = 0.3;         // сколько секунд можно стоять на лаве

export class LavaGame {
  constructor() {
    this.width = 2.4;
    this.depth = 3.0;
    this.cols = 4;
    this.rows = 5;
    this.tileW = 0.6;
    this.tileH = 0.6;
    this.safe = new Uint8Array(0);
    this.next = new Uint8Array(0);
    this.events = [];
    this.reset();
    this.resize(2.4, 3.0);
  }

  resize(width, depth) {
    this.width = Math.max(1.2, width);
    this.depth = Math.max(1.2, depth);
    const cols = Math.max(3, Math.round(this.width / TARGET_TILE));
    const rows = Math.max(3, Math.round(this.depth / TARGET_TILE));
    const n = cols * rows;
    const changed = cols !== this.cols || rows !== this.rows || this.safe.length !== n;
    this.cols = cols;
    this.rows = rows;
    this.tileW = this.width / cols;
    this.tileH = this.depth / rows;
    if (changed) {
      this.safe = new Uint8Array(n);
      this.next = new Uint8Array(n);
      this.reset();
    }
    return this;
  }

  reset() {
    this.safe.fill(0);
    this.next.fill(0);
    this.started = false;
    this.dead = false;
    this.score = 0;
    this.cycleT = 0;
    this.phase = 'calm';
    this.calmDur = 2.8;
    this.warnDur = 1.6;
    this.playerCell = null;
    this.footDanger = [0, 0];
    this.footOnLava = [false, false];
    this.dangerLevel = 0;
    this.events.length = 0;
    this.changes = 0;
  }

  get warnProgress() {
    if (this.phase !== 'warn' || this.warnDur <= 0) return 0;
    return Math.max(0, Math.min(1, this.cycleT / this.warnDur));
  }

  get calmProgress() {
    if (this.phase !== 'calm' || this.calmDur <= 0) return 0;
    return Math.max(0, Math.min(1, this.cycleT / this.calmDur));
  }

  idx(c, r) {
    return r * this.cols + c;
  }

  inb(c, r) {
    return c >= 0 && r >= 0 && c < this.cols && r < this.rows;
  }

  cellOf(x, y) {
    const c = Math.max(0, Math.min(this.cols - 1, Math.floor(x / this.tileW)));
    const r = Math.max(0, Math.min(this.rows - 1, Math.floor(y / this.tileH)));
    return { c, r, i: this.idx(c, r) };
  }

  isSafeCell(c, r) {
    if (!this.inb(c, r)) return true;
    return this.safe[this.idx(c, r)] === 1;
  }

  /**
   * Безопасна ли точка пола. Допуск tol «раздувает» камни — чтобы на границе
   * плитки не было ложных срабатываний, а стопа шириной 10 см не «проваливалась».
   * За пределами площадки лавы нет: точка прижимается к краю и судится по
   * ближайшей плитке.
   */
  isSafeAt(x, y, tol = 0.09) {
    if (x < -0.6 || y < -0.6 || x > this.width + 0.6 || y > this.depth + 0.6) return true;
    const px = Math.max(0, Math.min(this.width, x));
    const py = Math.max(0, Math.min(this.depth, y));
    const c0 = Math.floor((px - tol) / this.tileW);
    const c1 = Math.floor((px + tol) / this.tileW);
    const r0 = Math.floor((py - tol) / this.tileH);
    const r1 = Math.floor((py + tol) / this.tileH);
    for (let r = r0; r <= r1; r++) {
      if (r < 0 || r >= this.rows) continue;
      for (let c = c0; c <= c1; c++) {
        if (c < 0 || c >= this.cols) continue;
        if (this.safe[this.idx(c, r)]) return true;
      }
    }
    return false;
  }

  /** Клетка, куда игроку имеет смысл прыгнуть в следующем раунде. */
  pickEscape() {
    const p = this.playerCell;
    if (!p) return null;
    const { cols, rows, tileW, tileH } = this;
    const wantJump = Math.random() < Math.max(0, Math.min(0.35, (this.score - 8) * 0.012));
    const near = [];
    const far = [];
    const nearDist = Math.max(tileW, tileH) * 1.5;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        if (!dc && !dr) continue;
        const c = p.c + dc;
        const r = p.r + dr;
        if (!this.inb(c, r)) continue;
        const dist = Math.hypot(dc * tileW, dr * tileH);
        if (dist > 1.35) continue;
        if (dist <= nearDist) near.push({ c, r });
        else far.push({ c, r });
      }
    }
    const pool = wantJump && far.length ? far : (near.length ? near : far);
    if (!pool.length) return { c: p.c, r: p.r };
    return pool[(Math.random() * pool.length) | 0];
  }

  /**
   * Сгенерировать узор камней.
   * @param {{start?: {c:number,r:number}|null, forceSafe?: {c:number,r:number}|null,
   *          forbid?: {c:number,r:number}|null}} opts
   */
  buildPattern(opts = {}) {
    const { cols, rows } = this;
    const total = cols * rows;
    const safe = new Uint8Array(total);
    const idx = (c, r) => r * cols + c;

    const density = 0.28 + Math.min(0.16, this.score * 0.0035);
    const target = Math.max(3, Math.round(total * density));

    let cur;
    if (opts.start && this.inb(opts.start.c, opts.start.r)) cur = { c: opts.start.c, r: opts.start.r };
    else cur = { c: (cols - 1) >> 1, r: (rows - 1) >> 1 };

    safe[idx(cur.c, cur.r)] = 1;
    let count = 1;
    let guard = 0;

    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

    while (count < target && guard++ < 700) {
      const step = Math.random() < 0.55 ? 1 : 2;
      const d = dirs[(Math.random() * dirs.length) | 0];
      const nc = cur.c + d[0] * step;
      const nr = cur.r + d[1] * step;
      if (!this.inb(nc, nr)) {
        cur = { c: (Math.random() * cols) | 0, r: (Math.random() * rows) | 0 };
        continue;
      }
      cur = { c: nc, r: nr };
      if (!safe[idx(nc, nr)]) {
        safe[idx(nc, nr)] = 1;
        count++;
      }
    }

    guard = 0;
    while (count < target && guard++ < 500) {
      const i = (Math.random() * total) | 0;
      if (!safe[i]) {
        safe[i] = 1;
        count++;
      }
    }

    if (opts.forceSafe) safe[idx(opts.forceSafe.c, opts.forceSafe.r)] = 1;

    if (opts.forbid) {
      safe[idx(opts.forbid.c, opts.forbid.r)] = 0;
      // обязан остаться безопасный сосед — иначе игрок обречён
      let hasNeighbour = false;
      for (let dr = -1; dr <= 1 && !hasNeighbour; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dc && !dr) continue;
          const c = opts.forbid.c + dc;
          const r = opts.forbid.r + dr;
          if (this.inb(c, r) && safe[idx(c, r)]) { hasNeighbour = true; break; }
        }
      }
      if (!hasNeighbour) {
        const cands = [];
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (!dc && !dr) continue;
            const c = opts.forbid.c + dc;
            const r = opts.forbid.r + dr;
            if (this.inb(c, r)) cands.push({ c, r });
          }
        }
        if (cands.length) {
          const pick = cands[(Math.random() * cands.length) | 0];
          safe[idx(pick.c, pick.r)] = 1;
        }
      }
    }

    return safe;
  }

  begin(feet) {
    let pt = null;
    for (let i = 0; i < feet.length; i++) {
      const f = feet[i];
      if (f && f.seen && f.hasFloor && (f.down || pt === null)) {
        pt = f;
        if (f.down) break;
      }
    }
    if (!pt) return false;
    const cell = this.cellOf(pt.fx, pt.fy);
    this.playerCell = cell;
    this.safe = this.buildPattern({ start: { c: cell.c, r: cell.r }, forceSafe: { c: cell.c, r: cell.r } });
    this.next.fill(0);
    this.started = true;
    this.cycleT = 0;
    this.phase = 'calm';
    this.score = 0;
    return true;
  }

  playerCellFrom(feet) {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let i = 0; i < feet.length; i++) {
      const f = feet[i];
      if (f && f.seen && f.hasFloor) { sx += f.fx; sy += f.fy; n++; }
    }
    if (!n) return null;
    return this.cellOf(sx / n, sy / n);
  }

  /**
   * @param {number} dt секунды
   * @param {Array} feet состояние стоп
   */
  update(dt, feet) {
    this.events.length = 0;
    if (this.dead) return;

    if (!this.started) {
      if (this.begin(feet)) this.events.push('start');
      else return;
    }

    this.score += dt;

    const cell = this.playerCellFrom(feet);
    if (cell) this.playerCell = cell;

    let worst = 0;
    let anyBad = false;
    for (let i = 0; i < 2; i++) {
      const f = feet[i];
      const bad = !!(f && f.seen && f.down && f.hasFloor && !this.isSafeAt(f.fx, f.fy));
      this.footOnLava[i] = bad;
      if (bad) {
        anyBad = true;
        this.footDanger[i] = Math.min(1.5, this.footDanger[i] + dt);
        if (this.footDanger[i] > worst) worst = this.footDanger[i];
      } else {
        this.footDanger[i] = Math.max(0, this.footDanger[i] - dt * 3.5);
      }
      if (this.footDanger[i] > worst) worst = this.footDanger[i];
    }
    this.dangerLevel = Math.max(0, Math.min(1, worst / GRACE));

    if (anyBad && worst > GRACE) {
      this.dead = true;
      this.events.push('dead');
      return;
    }

    this.calmDur = Math.max(0.75, 2.8 - this.score * 0.03);
    this.warnDur = Math.max(0.85, 1.6 - this.score * 0.012);
    this.cycleT += dt;

    if (this.phase === 'calm') {
      if (this.cycleT >= this.calmDur) {
        this.phase = 'warn';
        this.cycleT = 0;
        this.next = this.buildPattern({ start: this.pickEscape(), forbid: this.playerCell });
        this.events.push('warn');
      }
    } else if (this.cycleT >= this.warnDur) {
      this.safe = this.next.slice();
      this.next.fill(0);
      this.phase = 'calm';
      this.cycleT = 0;
      this.changes++;
      this.events.push('change');
    }
  }
}
