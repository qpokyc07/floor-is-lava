/**
 * Проективная геометрия пола.
 *
 * Игровая площадка — прямоугольник W x D метров. Любая точка пола (x, y)
 * переводится в пиксели видеокадра гомографией (проективным преобразованием).
 * Это позволяет рисовать «плоские» объекты (плитки лавы, камни, круги под
 * ногами) так, будто они лежат на полу в реальной перспективе.
 *
 * Система координат пола:
 *   (0, 0)   — ближний левый угол (со стороны камеры)
 *   (W, 0)   — ближний правый
 *   (W, D)   — дальний правый
 *   (0, D)   — дальний левый
 * Ось Y уходит от камеры вглубь комнаты.
 */

/** Решение СЛАУ методом Гаусса с выбором ведущего элемента. */
export function solveLinear(A, b) {
  const n = b.length;
  const M = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = new Array(n + 1);
    for (let j = 0; j < n; j++) row[j] = A[i][j];
    row[n] = b[i];
    M[i] = row;
  }
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r][col]);
      if (v > best) { best = v; piv = r; }
    }
    if (best < 1e-12) return null;
    if (piv !== col) { const t = M[piv]; M[piv] = M[col]; M[col] = t; }
    const d = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = M[i][n];
  return out;
}

/**
 * Гомография по 4 соответствиям.
 * @param {Array<[number,number]>} src точки в метрах
 * @param {Array<[number,number]>} dst точки в пикселях
 * @returns {number[]|null} матрица 3x3 (9 чисел, построчно, h33 = 1)
 */
export function homography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const X = src[i][0];
    const Y = src[i][1];
    const u = dst[i][0];
    const v = dst[i][1];
    A.push([X, Y, 1, 0, 0, 0, -u * X, -u * Y]); b.push(u);
    A.push([0, 0, 0, X, Y, 1, -v * X, -v * Y]); b.push(v);
  }
  const h = solveLinear(A, b);
  if (!h) return null;
  for (let i = 0; i < 8; i++) {
    if (!Number.isFinite(h[i])) return null;
  }
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** Обратная матрица 3x3. */
export function invert3(m) {
  const a = m[0], b = m[1], c = m[2];
  const d = m[3], e = m[4], f = m[5];
  const g = m[6], h = m[7], i = m[8];
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;
  const k = 1 / det;
  return [
    A * k, (c * h - b * i) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, (c * d - a * f) * k,
    C * k, (b * g - a * h) * k, (a * e - b * d) * k,
  ];
}

/** Применить гомографию к точке. Возвращает {x, y} или null. */
export function apply(m, x, y) {
  const w = m[6] * x + m[7] * y + m[8];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-9) return null;
  const iw = 1 / w;
  const u = (m[0] * x + m[1] * y + m[2]) * iw;
  const v = (m[3] * x + m[4] * y + m[5]) * iw;
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  return { x: u, y: v };
}

/** Площадь четырёхугольника (для проверки, что разметка не выродилась). */
export function quadArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) * 0.5;
}

/**
 * Хранит разметку пола и обе матрицы преобразования.
 */
export class FloorMap {
  constructor() {
    this.H = null;      // пол (м) -> кадр (px)
    this.Hinv = null;   // кадр (px) -> пол (м)
    this.width = 2.4;   // ширина площадки, м
    this.depth = 3.0;   // глубина площадки, м
    this.corners = null; // [{x,y} x4] в пикселях кадра
  }

  /** Углы площадки в пикселях кадра: БЛ, БП, ДП, ДЛ. */
  setCorners(corners) {
    this.corners = corners && corners.length === 4 ? corners.slice(0, 4) : null;
    return this.rebuild();
  }

  setSize(width, depth) {
    this.width = Math.max(0.8, width);
    this.depth = Math.max(0.8, depth);
    return this.rebuild();
  }

  rebuild() {
    this.H = null;
    this.Hinv = null;
    if (!this.corners) return false;
    if (!this.corners.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))) return false;
    if (quadArea(this.corners) < 2000) return false;

    const src = [
      [0, 0],
      [this.width, 0],
      [this.width, this.depth],
      [0, this.depth],
    ];
    const dst = this.corners.map((p) => [p.x, p.y]);
    const H = homography(src, dst);
    if (!H) return false;
    const inv = invert3(H);
    if (!inv) return false;
    this.H = H;
    this.Hinv = inv;
    return true;
  }

  get ready() {
    return this.H !== null;
  }

  /** Точка пола (м) -> пиксель кадра. */
  toScreen(x, y) {
    return this.H ? apply(this.H, x, y) : null;
  }

  /** Пиксель кадра -> точка пола (м). */
  toFloor(u, v) {
    return this.Hinv ? apply(this.Hinv, u, v) : null;
  }

  /** Попадает ли точка пола в размеченную площадку (с запасом pad, м). */
  contains(x, y, pad = 0) {
    return x >= -pad && y >= -pad && x <= this.width + pad && y <= this.depth + pad;
  }
}
