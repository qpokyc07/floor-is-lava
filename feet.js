/**
 * Отслеживание стоп в кадре и их проекция на пол.
 *
 * Задача: по точкам MediaPipe понять, где на полу находится каждая стопа,
 * и стоит ли она сейчас на полу (а не в воздухе во время прыжка).
 *
 * Идея определения «стопа на полу»:
 * у каждой стопы есть опорный уровень refV — её обычное положение по вертикали
 * кадра, когда она стоит. Стопа «в воздухе», если уехала вверх больше чем на
 * releaseBand пикселей. При приземлении опора мгновенно пересчитывается, поэтому
 * прыжок вперёд/назад не ломает отслеживание.
 */

import { L } from './pose.js';

const VIS_MIN = 0.3;

export function createFoot(i) {
  return {
    idx: i,
    seen: false,
    down: false,
    conf: 0,
    u: 0,        // пиксель кадра
    v: 0,
    refV: null,  // опорный уровень, px
    airMs: 0,
    justLanded: false,
    fx: 0,       // точка пола, м
    fy: 0,
    hasFloor: false,
  };
}

export class FootTracker {
  constructor() {
    this.offsetPx = 8;      // поправка вниз: точки пятки/носка чуть выше пола
    this.touchBand = 12;    // px, насколько стопа должна вернуться к опоре
    this.releaseBand = 26;  // px, насколько стопа должна подняться
    this.reset();
  }

  reset() {
    this.feet = [createFoot(0), createFoot(1)];
    this._lastT = null;
    this.landEvents = [];
    this.anySeen = false;
    this.bothUp = false;
    this.justJumped = false;
  }

  /** Сырые точки стоп для отладки: [{u,v,vis}] x2 */
  get rawPoints() {
    return this.feet.map((f) => ({ u: f.u, v: f.v, seen: f.seen }));
  }

  /**
   * @param {Array|null} lm 33 точки MediaPipe
   * @param {{sw:number, sh:number}} view размеры кадра в пикселях
   * @param {import('./floor.js').FloorMap|null} floorMap
   * @param {number} tMs монотонное время
   */
  update(lm, view, floorMap, tMs) {
    const sw = (view && view.sw) || 1280;
    const sh = (view && view.sh) || 720;
    let dtMs = this._lastT == null ? 16.7 : tMs - this._lastT;
    this._lastT = tMs;
    if (!(dtMs > 0)) dtMs = 16.7;
    if (dtMs > 120) dtMs = 120;
    const scale = dtMs / 16.7;

    const prevDown = [this.feet[0].down, this.feet[1].down];
    const wasAirborne = !prevDown[0] && !prevDown[1];

    this.landEvents.length = 0;
    this.anySeen = false;

    const visOf = (p) => (p ? (Number.isFinite(p.visibility) ? p.visibility : 1) : 0);

    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      f.justLanded = false;

      if (!lm) {
        f.seen = false;
        f.conf = 0;
        continue;
      }

      const heel = lm[i ? L.HEEL_R : L.HEEL_L];
      const toe = lm[i ? L.TOE_R : L.TOE_L];
      const ankle = lm[i ? L.ANKLE_R : L.ANKLE_L];

      const hOk = visOf(heel) > VIS_MIN;
      const tOk = visOf(toe) > VIS_MIN;
      const aOk = visOf(ankle) > VIS_MIN;

      let u = 0;
      let v = 0;
      let extra = 0;
      let conf = 0;
      if (hOk && tOk) {
        const p = heel.y >= toe.y ? heel : toe;
        u = p.x * sw; v = p.y * sh; conf = 1;
      } else if (hOk || tOk) {
        const p = hOk ? heel : toe;
        u = p.x * sw; v = p.y * sh; conf = 0.6;
      } else if (aOk) {
        // пятка и носок не видны — грубая оценка по лодыжке
        u = ankle.x * sw; v = ankle.y * sh; conf = 0.35; extra = 26;
      } else {
        f.seen = false;
        f.conf = 0;
        continue;
      }

      f.seen = true;
      this.anySeen = true;
      f.u = u;
      f.v = v;
      f.conf = conf;

      const vv = v + this.offsetPx + extra;

      if (f.refV == null) {
        f.refV = vv;
        f.down = true;
        f.justLanded = true;
        f.airMs = 0;
      } else if (prevDown[i] || f.down) {
        // стопа считается стоящей: опора медленно следует за телом
        f.refV += (vv - f.refV) * Math.min(0.6, 0.09 * scale);
        if (vv < f.refV - this.releaseBand) {
          f.down = false;
          f.airMs = 0;
        }
      } else {
        f.airMs += dtMs;
        // одиночный шаг (не прыжок) — потихоньку перекалибровываем опору,
        // иначе шаг назад «залипнет» в воздухе навсегда
        if (!wasAirborne && f.airMs > 120) {
          f.refV += (vv - f.refV) * Math.min(0.5, 0.02 * scale);
        }
        if (vv >= f.refV - this.touchBand) {
          f.down = true;
          f.justLanded = true;
          f.airMs = 0;
          f.refV = vv;
        } else if (f.airMs > 1300) {
          f.down = true;
          f.justLanded = true;
          f.airMs = 0;
          f.refV = vv;
        }
      }

      if (f.justLanded) this.landEvents.push(i);

      // проекция на пол
      if (floorMap && floorMap.ready) {
        const p = floorMap.toFloor(u, vv);
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) < 50 && Math.abs(p.y) < 50) {
          if (f.justLanded || !f.hasFloor) {
            f.fx = p.x;
            f.fy = p.y;
          } else if (f.down) {
            f.fx += (p.x - f.fx) * Math.min(0.9, 0.35 * scale);
            f.fy += (p.y - f.fy) * Math.min(0.9, 0.35 * scale);
          }
          f.hasFloor = true;
        }
      }
    }

    // прыжок = обе стопы в воздухе
    const nowBothUp = !this.feet[0].down && !this.feet[1].down;
    this.justJumped = nowBothUp && !this.bothUp;
    this.bothUp = nowBothUp;
  }
}
