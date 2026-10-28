/**
 * Обёртка над MediaPipe Pose Landmarker (Tasks Vision).
 *
 * Библиотека и модель грузятся с CDN при первом запуске, поэтому приложению
 * нужен интернет (дальше браузер их кэширует).
 *
 * Модель отдаёт 33 точки тела в нормализованных координатах кадра (0..1, y вниз).
 * Нам нужны только стопы:
 *   27 / 28 — лодыжка левая / правая
 *   29 / 30 — пятка левая / правая
 *   31 / 32 — носок левая / правая
 */

const BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const ESM_URL = `${BASE}/vision_bundle.mjs`;
const WASM_URL = `${BASE}/wasm`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

export const L = {
  ANKLE_L: 27,
  ANKLE_R: 28,
  HEEL_L: 29,
  HEEL_R: 30,
  TOE_L: 31,
  TOE_R: 32,
};

export class PoseEngine {
  constructor() {
    this.landmarker = null;
    this.delegate = null;
    this.error = null;
    this.lastTs = -1;
    this.failures = 0;
  }

  get ready() {
    return !!this.landmarker;
  }

  /**
   * @param {(text: string) => void} [onProgress]
   */
  async load(onProgress) {
    const say = (s) => { try { onProgress && onProgress(s); } catch (_) { /* noop */ } };

    say('Загружаю модель распознавания тела…');
    let mod;
    try {
      mod = await import(/* @vite-ignore */ ESM_URL);
    } catch (e) {
      this.error = 'Не удалось загрузить библиотеку MediaPipe. Проверьте интернет.';
      throw e;
    }

    say('Готовлю вычислитель…');
    const fileset = await mod.FilesetResolver.forVisionTasks(WASM_URL);

    const attempts = ['GPU', 'CPU'];
    let lastErr = null;
    for (const delegate of attempts) {
      try {
        this.landmarker = await mod.PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.4,
          minPosePresenceConfidence: 0.4,
          minTrackingConfidence: 0.4,
        });
        this.delegate = delegate;
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        this.landmarker = null;
      }
    }
    if (!this.landmarker) {
      this.error = 'Не удалось инициализировать модель. Попробуйте перезагрузить страницу.';
      throw lastErr || new Error('pose init failed');
    }
    say('Готово');
    return this;
  }

  /**
   * Один кадр распознавания.
   * @param {HTMLVideoElement} video
   * @param {number} tsMs монотонное время в мс
   * @returns {Array<{x:number,y:number,z:number,visibility:number}>|null}
   */
  detect(video, tsMs) {
    if (!this.landmarker || !video || video.readyState < 2) return null;
    let ts = tsMs;
    if (!(ts > this.lastTs)) ts = this.lastTs + 1;
    try {
      const res = this.landmarker.detectForVideo(video, ts);
      this.lastTs = ts;
      this.failures = 0;
      const lm = res && res.landmarks && res.landmarks[0];
      return lm && lm.length >= 33 ? lm : null;
    } catch (e) {
      this.failures++;
      return null;
    }
  }

  close() {
    try { this.landmarker && this.landmarker.close(); } catch (_) { /* noop */ }
    this.landmarker = null;
  }
}
