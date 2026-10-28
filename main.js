/**
 * «Пол — это лава» — AR-игра на веб-странице.
 *
 * Телефон стоит на подставке и смотрит на игровую зону. Камера видит человека,
 * MediaPipe находит стопы, гомография переводит их в координаты пола, и на полу
 * загорается лава с безопасными камнями. Экран дублируется на телевизор.
 */

import { FloorMap } from './floor.js';
import { PoseEngine } from './pose.js';
import { FootTracker } from './feet.js';
import { LavaGame } from './game.js';
import { Renderer } from './render.js';
import { Sfx } from './audio.js';

const MODE = {
  BOOT: 'boot',
  MENU: 'menu',
  CALIB: 'calib',
  READY: 'ready',
  COUNT: 'count',
  PLAY: 'play',
  OVER: 'over',
};

const PREFS_KEY = 'floor-is-lava:v2';

const CALIB_HINTS = [
  'Коснитесь пола в БЛИЖНЕМ ЛЕВОМ углу площадки (ближе к камере)',
  'Теперь БЛИЖНИЙ ПРАВЫЙ угол',
  'Теперь ДАЛЬНИЙ ПРАВЫЙ угол',
  'И последний — ДАЛЬНИЙ ЛЕВЫЙ',
];

const app = {
  mode: MODE.BOOT,
  video: null,
  canvas: null,
  ctx: null,
  view: { sw: 1280, sh: 720, scale: 1, ox: 0, oy: 0 },
  floorMap: new FloorMap(),
  pose: new PoseEngine(),
  feet: new FootTracker(),
  game: new LavaGame(),
  renderer: new Renderer(),
  sfx: new Sfx(),
  stream: null,
  facing: 'environment',
  taps: [],
  demo: false,
  best: 0,
  time: 0,
  lastFrame: 0,
  poseAt: 0,
  landmarks: null,
  countAt: 0,
  countStep: 3,
  noPoseMs: 0,
  deadAt: 0,
  demoX: 0.5,
  demoY: 0.5,
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/*  Загрузка                                                          */
/* ------------------------------------------------------------------ */

function boot() {
  app.video = $('cam');
  app.canvas = $('stage');
  app.ctx = app.canvas.getContext('2d', { alpha: false });

  bindUi();
  onResize();
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 250));

  loadPrefs();
  app.game.resize(app.floorMap.width, app.floorMap.depth);

  // для отладки из консоли: __lava.renderer.occlusion = false и т.п.
  window.__lava = app;

  requestAnimationFrame(loop);
  startEverything();
}

async function startEverything() {
  setMode(MODE.BOOT);
  setBoot('Включаю камеру…');

  try {
    await startCamera();
  } catch (e) {
    bootFail(describeCameraError(e));
    return;
  }

  setBoot('Загружаю модель распознавания тела…');
  try {
    await app.pose.load(setBoot);
  } catch (e) {
    // не критично: без модели можно осмотреть разметку, но играть нельзя
    app.poseError = app.pose.error || 'Модель не загрузилась';
  }

  restoreCalibration();

  const warn = $('menu-warn');
  if (warn) {
    if (app.poseError) {
      warn.textContent = `⚠ ${app.poseError} Играть не получится, но разметку посмотреть можно.`;
      warn.classList.remove('hidden');
    } else {
      warn.classList.add('hidden');
    }
  }

  setMode(MODE.MENU);
}

function setBoot(text) {
  const el = $('boot-status');
  if (el) el.textContent = text;
}

function bootFail(text) {
  $('boot').classList.add('failed');
  $('boot-status').innerHTML = text;
  const spin = document.querySelector('#boot .spinner');
  if (spin) spin.style.display = 'none';
  const btn = $('btn-boot-retry');
  if (btn) btn.classList.remove('hidden');
}

function describeCameraError(e) {
  if (!e) return 'Неизвестная ошибка камеры.';
  if (e.code === 'insecure') {
    return 'Камера доступна только по HTTPS.<br>Откройте страницу по адресу <b>https://…</b> ' +
      '(или через <code>localhost</code> на компьютере).';
  }
  switch (e.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Доступ к камере запрещён.<br>Разрешите камеру в настройках браузера и перезагрузите страницу.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Камера не найдена.';
    case 'NotReadableError':
      return 'Камера занята другим приложением.<br>Закройте другие программы с камерой.';
    default:
      return `Не удалось включить камеру.<br><small>${escapeHtml(String(e.message || e))}</small>`;
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const err = new Error('no mediaDevices');
    err.code = 'insecure';
    throw err;
  }
  stopCamera();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: app.facing },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 },
    },
  });
  app.stream = stream;
  const v = app.video;
  v.srcObject = stream;
  v.muted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  try { await v.play(); } catch (_) { /* автоплей может быть отложен */ }
  if (v.readyState < 2) {
    await new Promise((res) => {
      let done = false;
      const finish = () => { if (!done) { done = true; res(); } };
      v.addEventListener('loadeddata', finish, { once: true });
      setTimeout(finish, 3000);
    });
  }
  onResize();
}

function stopCamera() {
  if (app.stream) {
    for (const t of app.stream.getTracks()) t.stop();
    app.stream = null;
  }
}

/* ------------------------------------------------------------------ */
/*  Настройки                                                         */
/* ------------------------------------------------------------------ */

function loadPrefs() {
  let data = null;
  try {
    data = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
  } catch (_) { data = null; }
  if (!data) return;
  if (Array.isArray(data.size) && data.size.length === 2) {
    app.floorMap.setSize(Number(data.size[0]) || 2.4, Number(data.size[1]) || 3.0);
  }
  if (Number.isFinite(data.offset)) app.feet.offsetPx = data.offset;
  if (Number.isFinite(data.best)) app.best = data.best;
  if (typeof data.sound === 'boolean') app.sfx.enabled = data.sound;
  if (typeof data.demo === 'boolean') app.demo = data.demo;
  if (data.facing === 'user' || data.facing === 'environment') app.facing = data.facing;
  app.savedCorners = data.corners || null;
}

function savePrefs() {
  const v = app.view;
  const data = {
    size: [app.floorMap.width, app.floorMap.depth],
    offset: app.feet.offsetPx,
    best: app.best,
    sound: app.sfx.enabled,
    demo: app.demo,
    facing: app.facing,
    corners: app.floorMap.corners
      ? app.floorMap.corners.map((p) => ({ x: p.x / v.sw, y: p.y / v.sh }))
      : null,
  };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(data)); } catch (_) { /* noop */ }
}

function restoreCalibration() {
  const saved = app.savedCorners;
  if (!saved || saved.length !== 4) return false;
  const v = app.view;
  const pts = saved.map((p) => ({ x: p.x * v.sw, y: p.y * v.sh }));
  const ok = app.floorMap.setCorners(pts);
  if (ok) app.calibAspect = v.sw / v.sh;
  return ok;
}

/* ------------------------------------------------------------------ */
/*  Мобильные удобства (Android)                                      */
/* ------------------------------------------------------------------ */

/** Полный экран + горизонтальная ориентация: иначе на телефоне неудобно. */
async function enterImmersive() {
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    }
  } catch (_) { /* браузер может запретить — не страшно */ }
  try {
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock('landscape');
    }
  } catch (_) { /* блокировка ориентации доступна только в полном экране */ }
}

/** Не даём экрану телефона погаснуть во время партии. */
let wakeLock = null;
async function requestWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (_) { wakeLock = null; }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) requestWakeLock();
});

/* ------------------------------------------------------------------ */
/*  Интерфейс                                                         */
/* ------------------------------------------------------------------ */

function setMode(m) {
  app.mode = m;
  const show = (id, on) => {
    const el = $(id);
    if (!el) return;
    el.classList.toggle('hidden', !on);
  };
  show('boot', m === MODE.BOOT);
  show('menu', m === MODE.MENU);
  show('calib', m === MODE.CALIB || m === MODE.READY);
  show('count', m === MODE.COUNT);
  show('over', m === MODE.OVER);
  show('hud', m === MODE.PLAY || m === MODE.COUNT || m === MODE.OVER);
  document.body.dataset.mode = m;

  if (m === MODE.CALIB) {
    app.taps = [];
    app.floorMap.setCorners(null);
  }
  if (m === MODE.OVER) {
    $('over-score').textContent = app.game.score.toFixed(1);
    $('over-best').textContent = app.best.toFixed(1);
  }
  refreshCalibUi();
  updateHud(true);
}

function refreshCalibUi() {
  const n = app.taps.length;
  const undo = $('btn-undo');
  const go = $('btn-go');
  if (undo) undo.disabled = n === 0;
  const wv = $('w-val');
  const dv = $('d-val');
  if (wv) wv.textContent = `${app.floorMap.width.toFixed(1)} м`;
  if (dv) dv.textContent = `${app.floorMap.depth.toFixed(1)} м`;
  const ov = $('off-val');
  if (ov) ov.textContent = `${app.feet.offsetPx > 0 ? '+' : ''}${Math.round(app.feet.offsetPx)}`;
  const hint = $('calib-hint');
  if (!hint) return;
  if (app.mode === MODE.CALIB) {
    hint.textContent = CALIB_HINTS[n] || CALIB_HINTS[0];
    if (go) { go.disabled = true; go.textContent = 'Поехали'; }
  } else if (app.mode === MODE.READY) {
    hint.textContent = 'Сетка должна лежать ровно по полу. Размер можно поправить.';
    if (go) { go.disabled = false; go.textContent = 'Поехали'; }
  }
}

function showToast(text) {
  const el = $('toast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove('on'), 2600);
}

function bindUi() {
  app.canvas.addEventListener('pointerdown', onCanvasTap);

  // страховка: если автоплей видео не сработал, включаем его по первому касанию
  document.addEventListener('pointerdown', () => {
    if (app.video && app.video.paused) app.video.play().catch(() => {});
    if (app.sfx.ctx) app.sfx.resume();
  }, { capture: true });

  $('btn-start').addEventListener('click', () => {
    app.sfx.init();
    app.sfx.resume();
    requestWakeLock();
    enterImmersive();
    if (app.floorMap.ready) setMode(MODE.READY);
    else setMode(MODE.CALIB);
  });

  $('btn-help').addEventListener('click', () => $('help').classList.remove('hidden'));
  $('btn-help-close').addEventListener('click', () => $('help').classList.add('hidden'));

  $('btn-calib-back').addEventListener('click', () => {
    savePrefs();
    setMode(MODE.MENU);
  });

  $('btn-undo').addEventListener('click', () => {
    app.taps.pop();
    if (app.taps.length < 4) app.floorMap.setCorners(null);
    refreshCalibUi();
  });

  $('btn-reset').addEventListener('click', () => {
    app.taps = [];
    app.floorMap.setCorners(null);
    if (app.mode === MODE.READY) setMode(MODE.CALIB);
    else refreshCalibUi();
  });

  $('btn-go').addEventListener('click', () => {
    if (!app.floorMap.ready) {
      showToast('Сначала отметьте 4 угла площадки');
      return;
    }
    savePrefs();
    startRound();
  });

  $('btn-w-minus').addEventListener('click', () => nudgeSize(-0.1, 0));
  $('btn-w-plus').addEventListener('click', () => nudgeSize(0.1, 0));
  $('btn-d-minus').addEventListener('click', () => nudgeSize(0, -0.1));
  $('btn-d-plus').addEventListener('click', () => nudgeSize(0, 0.1));

  $('btn-off-minus').addEventListener('click', () => nudgeOffset(-3));
  $('btn-off-plus').addEventListener('click', () => nudgeOffset(3));

  $('btn-again').addEventListener('click', () => startRound());
  $('btn-over-menu').addEventListener('click', () => {
    savePrefs();
    setMode(MODE.MENU);
  });
  $('btn-over-calib').addEventListener('click', () => setMode(MODE.CALIB));

  $('btn-sound').addEventListener('click', () => {
    app.sfx.init();
    app.sfx.resume();
    app.sfx.setEnabled(!app.sfx.enabled);
    syncToggles();
    savePrefs();
  });

  $('btn-demo').addEventListener('click', () => {
    app.demo = !app.demo;
    syncToggles();
    savePrefs();
  });

  $('btn-cam').addEventListener('click', switchCamera);
  $('btn-cam2').addEventListener('click', switchCamera);

  $('btn-full').addEventListener('click', toggleFullscreen);

  $('btn-boot-retry').addEventListener('click', () => {
    $('boot').classList.remove('failed');
    $('btn-boot-retry').classList.add('hidden');
    const spin = document.querySelector('#boot .spinner');
    if (spin) spin.style.display = '';
    startEverything();
  });

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      if (app.mode === MODE.MENU) $('btn-start').click();
      else if (app.mode === MODE.OVER) startRound();
      else if (app.mode === MODE.READY) $('btn-go').click();
    }
    if (e.code === 'KeyD') {
      app.debug = !app.debug;
      showToast(app.debug ? 'Отладка включена' : 'Отладка выключена');
    }
  });

  syncToggles();
}

function syncToggles() {
  const s = $('btn-sound');
  if (s) s.textContent = app.sfx.enabled ? '🔊 Звук' : '🔇 Звук';
  const d = $('btn-demo');
  if (d) d.textContent = app.demo ? '🎬 Демо: вкл' : '🎬 Демо';
  const c = $('btn-cam');
  if (c) c.textContent = app.facing === 'user' ? '📷 Фронтальная' : '📷 Основная';
}

async function switchCamera() {
  app.facing = app.facing === 'environment' ? 'user' : 'environment';
  syncToggles();
  try {
    await startCamera();
    app.pose.lastTs = -1;
    app.feet.reset();
    // у другой камеры другой кадр — разметку придётся повторить
    app.taps = [];
    app.calibAspect = null;
    app.floorMap.setCorners(null);
    app.savedCorners = null;
    showToast('Камера переключена — отметьте площадку заново');
    setMode(MODE.CALIB);
  } catch (e) {
    showToast(describeCameraError(e).replace(/<[^>]+>/g, ' '));
  }
  savePrefs();
}

function nudgeSize(dw, dd) {
  const w = Math.max(1.2, Math.min(5, Math.round((app.floorMap.width + dw) * 10) / 10));
  const d = Math.max(1.2, Math.min(6, Math.round((app.floorMap.depth + dd) * 10) / 10));
  app.floorMap.setSize(w, d);
  app.game.resize(w, d);
  refreshCalibUi();
  savePrefs();
}

function nudgeOffset(delta) {
  app.feet.offsetPx = Math.max(-30, Math.min(60, app.feet.offsetPx + delta));
  refreshCalibUi();
  savePrefs();
}

async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('landscape').catch(() => {});
      }
    } else {
      await document.exitFullscreen();
    }
  } catch (_) { /* noop */ }
}

/* ------------------------------------------------------------------ */
/*  Разметка пола                                                     */
/* ------------------------------------------------------------------ */

function onCanvasTap(e) {
  if (app.mode !== MODE.CALIB) return;
  const p = toVideoPx(e.clientX, e.clientY);
  if (p.x < 0 || p.y < 0 || p.x > app.view.sw || p.y > app.view.sh) return;
  e.preventDefault();
  app.taps.push(p);
  app.sfx.init();
  app.sfx.resume();
  app.sfx.tone(620 + app.taps.length * 110, 0.09, { type: 'triangle', vol: 0.18 });

  if (app.taps.length === 4) {
    if (!app.floorMap.setCorners(app.taps.slice())) {
      showToast('Точки слишком близко друг к другу — отметьте заново');
      app.taps = [];
      app.floorMap.setCorners(null);
      refreshCalibUi();
      return;
    }
    app.calibAspect = app.view.sw / app.view.sh;
    setMode(MODE.READY);
    return;
  }
  refreshCalibUi();
}

function toVideoPx(clientX, clientY) {
  const r = app.canvas.getBoundingClientRect();
  const dx = (clientX - r.left) * (app.canvas.width / Math.max(1, r.width));
  const dy = (clientY - r.top) * (app.canvas.height / Math.max(1, r.height));
  return {
    x: (dx - app.view.ox) / app.view.scale,
    y: (dy - app.view.oy) / app.view.scale,
  };
}

/* ------------------------------------------------------------------ */
/*  Игровой цикл                                                      */
/* ------------------------------------------------------------------ */

function onResize() {
  if (!app.canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = app.canvas.clientWidth || window.innerWidth;
  const h = app.canvas.clientHeight || window.innerHeight;
  app.canvas.width = Math.max(2, Math.round(w * dpr));
  app.canvas.height = Math.max(2, Math.round(h * dpr));
  updateView();
}

function updateView() {
  const cw = app.canvas.width;
  const ch = app.canvas.height;
  const sw = app.video.videoWidth || 1280;
  const sh = app.video.videoHeight || 720;
  // «contain»: кадр камеры виден целиком, поля заливаются фоном.
  // Так в кадр гарантированно попадают и пол, и человек — обрезать нельзя.
  const scale = Math.min(cw / sw, ch / sh);
  app.view = { sw, sh, scale, ox: (cw - sw * scale) / 2, oy: (ch - sh * scale) / 2 };

  // если камера сменила ориентацию кадра, старая разметка становится неверной
  const aspect = sw / sh;
  if (app.calibAspect && app.floorMap.ready && Math.abs(aspect / app.calibAspect - 1) > 0.12) {
    app.calibAspect = null;
    app.taps = [];
    app.floorMap.setCorners(null);
    showToast('Камера сменила ориентацию — разметьте площадку заново');
    if (app.mode === MODE.READY || app.mode === MODE.PLAY || app.mode === MODE.COUNT) {
      setMode(MODE.CALIB);
    }
  }
}

function loop(now) {
  requestAnimationFrame(loop);
  const dt = app.lastFrame ? Math.min(0.05, Math.max(0, (now - app.lastFrame) / 1000)) : 0.016;
  app.lastFrame = now;
  app.time += dt;

  updateView();
  stepPose(now);
  stepFeet(dt, now);

  if (app.mode === MODE.COUNT) stepCountdown(now);
  if (app.mode === MODE.PLAY) stepGame(dt);

  stepRender(dt);
  updateHud(false);
}

function stepPose(now) {
  if (app.demo) return;
  if (!app.pose.ready) return;
  if (now - app.poseAt < 40) return;
  app.poseAt = now;
  app.landmarks = app.pose.detect(app.video, now);
}

function stepFeet(dt, now) {
  if (app.demo) {
    stepDemo(dt);
    return;
  }
  app.feet.update(app.landmarks, app.view, app.floorMap, now);
  if (app.feet.anySeen) app.noPoseMs = 0;
  else app.noPoseMs += dt * 1000;

  if (app.mode === MODE.PLAY) {
    if (app.feet.justJumped) app.sfx.jump();
    if (app.feet.landEvents.length) app.sfx.land();
  }
}

function stepDemo(dt) {
  const g = app.game;
  const t = app.time;
  app.demoX = g.width * (0.5 + 0.3 * Math.sin(t * 0.55));
  app.demoY = g.depth * (0.5 + 0.28 * Math.sin(t * 0.37 + 1.2));
  const f = app.feet.feet;
  for (let i = 0; i < 2; i++) {
    f[i].seen = true;
    f[i].down = true;
    f[i].conf = 1;
    f[i].hasFloor = true;
    f[i].fx = app.demoX + (i ? 0.12 : -0.12);
    f[i].fy = app.demoY;
    f[i].u = 0;
    f[i].v = 0;
    f[i].justLanded = false;
  }
  app.feet.anySeen = true;
  app.feet.bothUp = false;
  app.feet.justJumped = false;
  app.feet.landEvents.length = 0;
  app.noPoseMs = 0;
  void dt;
}

function stepGame(dt) {
  const g = app.game;
  g.update(dt, app.feet.feet);
  for (let i = 0; i < g.events.length; i++) {
    const e = g.events[i];
    if (e === 'warn') app.sfx.warn();
    else if (e === 'change') app.sfx.change();
    else if (e === 'dead') onDead();
  }
  app.sfx.setDanger(g.dangerLevel);
}

function onDead() {
  app.sfx.gameOver();
  app.renderer.burst();
  app.best = Math.max(app.best, app.game.score);
  savePrefs();
  app.deadAt = performance.now();
  setTimeout(() => {
    if (app.game.dead) setMode(MODE.OVER);
  }, 900);
}

function stepCountdown(now) {
  const t = (now - app.countAt) / 1000;
  if (t >= 3) {
    app.sfx.start();
    app.sfx.setDanger(0);
    setMode(MODE.PLAY);
    return;
  }
  const n = Math.max(1, Math.ceil(3 - t));
  if (n !== app.countStep) {
    app.countStep = n;
    app.sfx.countdown(n);
    const el = $('count-num');
    el.textContent = String(n);
    if (el.animate) {
      el.animate(
        [{ transform: 'scale(1.5)', opacity: 0.15 }, { transform: 'scale(1)', opacity: 1 }],
        { duration: 420, easing: 'ease-out' },
      );
    }
  }
}

function stepRender(dt) {
  app.renderer.updateEmbers(dt, app.game, app.floorMap);
  app.renderer.draw(app.ctx, {
    view: app.view,
    video: app.video,
    floorMap: app.floorMap,
    game: app.game,
    feet: app.feet.feet,
    time: app.time,
    mode: app.mode,
    calibTaps: app.taps,
    debug: app.debug,
    landmarks: app.landmarks,
  });
}

let lastHud = { score: '', banner: '', hint: '' };

function updateHud(force) {
  const g = app.game;

  const score = g.started ? g.score.toFixed(1) : '0.0';
  if (force || score !== lastHud.score) {
    lastHud.score = score;
    const el = $('score');
    if (el) el.textContent = score;
    const b = $('best');
    if (b) b.textContent = app.best > 0 ? app.best.toFixed(1) : '—';
  }

  let banner = '';
  if (app.mode === MODE.PLAY || app.mode === MODE.OVER) {
    if (g.dangerLevel > 0.12) banner = 'ЛАВА! ПРЫГАЙ!';
    else if (g.phase === 'warn') banner = 'ПЛИТЫ ТОНУТ';
  }
  if (banner !== lastHud.banner) {
    lastHud.banner = banner;
    const el = $('banner');
    if (el) {
      el.textContent = banner;
      el.classList.toggle('on', !!banner);
      el.classList.toggle('hot', g.dangerLevel > 0.12);
    }
  }

  let hint = '';
  if (app.mode === MODE.PLAY) {
    if (!app.pose.ready) hint = 'Модель не загрузилась — распознавание стоп недоступно';
    else if (!g.started) hint = 'Встаньте в зону так, чтобы стопы были видны';
    else if (app.noPoseMs > 1500) hint = 'Вас не видно целиком — поправьте камеру';
  }
  if (hint !== lastHud.hint) {
    lastHud.hint = hint;
    const el = $('hint');
    if (el) el.textContent = hint;
  }

  const d = $('danger');
  if (d) {
    const v = String(Math.min(1, g.dangerLevel * 0.9));
    if (d.style.opacity !== v) d.style.opacity = v;
  }
}

function startRound() {
  app.game.resize(app.floorMap.width, app.floorMap.depth);
  app.game.reset();
  app.renderer.embers.length = 0;
  app.renderer.shake = 0;
  app.renderer.flash = 0;
  requestWakeLock();
  app.countStep = 3;
  app.countAt = performance.now();
  app.sfx.init();
  app.sfx.resume();
  const el = $('count-num');
  if (el) el.textContent = '3';
  app.sfx.countdown(3);
  setMode(MODE.COUNT);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
