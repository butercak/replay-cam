'use strict';
/*
 * 回放相機 — a phone "replay buffer" camera (like OBS Replay Buffer).
 *
 * Pipeline: camera <video> --requestVideoFrameCallback--> VideoFrame --> VideoEncoder (H.264)
 *           mic --AudioWorklet--> AudioData --> AudioEncoder (AAC / Opus)
 * Encoded chunks live in an in-memory ring buffer trimmed at keyframes (every 2 s), so the
 * buffer always covers at least the last X minutes. "Save" muxes the tail into an MP4.
 */

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');          // synthetic camera for testing on a computer
const KEY_US = 2_000_000;                  // keyframe interval
const AUDIO_KEEP_EXTRA_US = 1_500_000;     // keep a bit of audio before first video frame (for offset)

// ---------- settings ----------
const DEFAULTS = { minutes: 2, res: '1080', fps: 60, mbps: 12, offsetMs: 0, rawAudio: true, facing: 'environment' };
function loadSettings() {
  try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('rc-settings') || '{}')); }
  catch { return Object.assign({}, DEFAULTS); }
}
function saveSettings() { try { localStorage.setItem('rc-settings', JSON.stringify(S)); } catch {} }
const S = loadSettings();
const bufUs = () => Math.max(0.25, Number(S.minutes) || 2) * 60e6;

// ---------- ui helpers ----------
const video = $('#preview');
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtMB(bytes) { return (bytes / 1048576).toFixed(bytes > 100 * 1048576 ? 0 : 1) + ' MB'; }
function minutesLabel() {
  const m = Number(S.minutes);
  return m < 1 ? `${Math.round(m * 60)} 秒` : `${+m.toFixed(2)} 分鐘`;
}
function showStart(msg) {
  $('#startOverlay').hidden = false;
  $('#startOverlay').style.display = '';
  const p = $('#startMsg');
  p.hidden = !msg; p.textContent = msg || '';
}
function hideStart() { $('#startOverlay').style.display = 'none'; }

// ---------- capability check ----------
function unsupportedReason() {
  if (!window.isSecureContext) return '需要用 https:// 網址開啟（本機測試可用 localhost）。';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return '這個瀏覽器不能使用相機。';
  if (!('VideoEncoder' in window) || !('VideoFrame' in window)) return '這個瀏覽器不支援 WebCodecs。請使用 iOS 16.4 以上的 Safari，或 Android 的 Chrome。';
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return '這個瀏覽器版本太舊，請更新。';
  if (!window.Mp4Muxer) return 'mp4-muxer.js 沒有載入。';
  return null;
}

// ---------- session ----------
let cur = null;     // current capture session
let saving = false;

function constraints() {
  const h = Number(S.res), w = Math.round(h * 16 / 9);
  const fps = Number(S.fps);
  const raw = !!S.rawAudio;
  const video = {
    facingMode: { ideal: S.facing },
    width: { ideal: w }, height: { ideal: h },
    frameRate: { ideal: fps, max: fps },
  };
  // Chromium only exposes zoom if it is requested up front.
  const sup = navigator.mediaDevices.getSupportedConstraints ? navigator.mediaDevices.getSupportedConstraints() : {};
  if ('userAgentData' in navigator && sup.zoom) video.zoom = true;
  return {
    video,
    audio: {
      echoCancellation: !raw, noiseSuppression: !raw, autoGainControl: !raw,
      channelCount: { ideal: 2 },
    },
  };
}

async function getCamera() {
  const c = constraints();
  try { return await navigator.mediaDevices.getUserMedia(c); }
  catch (e) {
    if (!c.video.zoom || e.name === 'NotAllowedError') throw e;
    delete c.video.zoom; // retry without the zoom permission request
    return await navigator.mediaDevices.getUserMedia(c);
  }
}

async function startSession() {
  // Create the AudioContext synchronously inside the user gesture (required on iOS).
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ latencyHint: 'interactive' });
  const old = cur;
  const sess = {
    alive: true, ctx,
    v: [], a: [], pcm: [], vBytes: 0, aBytes: 0,
    w: 0, h: 0, configuring: false, vEnc: null, vMeta: null, vCodec: '',
    lastKey: -Infinity, lastTs: 0, frames: 0, dropped: 0, useCanvas: false, useCaptureTime: null,
    aMode: 'none', aEnc: null, aMeta: null, aCodec: '', sr: 0, ch: 0, aBase: undefined, aErr: 0, aOut: 0, aPush: 0,
    vErrors: 0, fpsCount: 0, fpsShown: 0, fpsT: performance.now(),
  };
  cur = sess;
  if (old) stopSession(old);
  setSaveEnabled(false);
  $('#bufText').textContent = '啟動中…';

  try {
    ctx.resume().catch(() => {});
    sess.stream = DEMO ? demoStream(sess) : await getCamera();
    if (!sess.alive) return;
    video.srcObject = sess.stream;
    video.classList.toggle('mirror', S.facing === 'user' && !DEMO);
    await video.play().catch(() => {});
    const vt = sess.stream.getVideoTracks()[0];
    const vs = vt.getSettings ? vt.getSettings() : {};
    sess.trackFps = vs.frameRate || Number(S.fps);
    vt.addEventListener('ended', () => { if (cur === sess) { stopSession(sess); setIdleMsg('相機被系統關閉了（可能是切到別的 App 或鎖定螢幕）。按紅色按鈕重新開始。'); } });

    await setupAudio(sess);
    if (!sess.alive) return;
    video.requestVideoFrameCallback((n, m) => onFrame(sess, n, m));
    hideStart();
    document.body.classList.add('running');
    $('#saveLabel').textContent = `保存過去 ${minutesLabel()}`;
    requestWakeLock();
  } catch (e) {
    console.error(e);
    stopSession(sess);
    let msg = '無法開啟相機：' + (e && e.message ? e.message : e);
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) msg = '相機或麥克風權限被拒絕了。請到瀏覽器／系統設定允許後再試一次。';
    if (e && e.name === 'OverconstrainedError') msg = '這個鏡頭不支援目前的解析度或幀率，請到設定調低。';
    showStart(msg);
  }
}

function stopSession(sess) {
  if (!sess || !sess.alive) return;
  sess.alive = false;
  try { sess.vEnc && sess.vEnc.state !== 'closed' && sess.vEnc.close(); } catch {}
  try { sess.aEnc && sess.aEnc.state !== 'closed' && sess.aEnc.close(); } catch {}
  try { sess.node && sess.node.port.postMessage('stop'); } catch {}
  try { sess.stream && sess.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { sess.demoStop && sess.demoStop(); } catch {}
  try { sess.ctx && sess.ctx.close(); } catch {}
  sess.v = []; sess.a = []; sess.pcm = [];
  if (video.srcObject === sess.stream) video.srcObject = null;
  if (cur === sess) {
    setSaveEnabled(false);
    $('#bufText').textContent = '待機中';
    $('#liveDot').classList.remove('live');
    document.body.classList.remove('running', 'dimmed');
    $('#saveLabel').textContent = '按下開始';
    releaseWakeLock();
  }
}

function setIdleMsg(msg) { $('#idleMsg').textContent = msg; }

let lastSaveAt = 0;
function stopByUser() {
  const s = cur;
  if (!s || !s.alive) return;
  const buffered = s.v.length ? (s.v[s.v.length - 1].ts - s.v[0].ts) / 1e6 : 0;
  // Guard against losing a good take: ask only if there is unsaved footage.
  if (buffered > 10 && Date.now() - lastSaveAt > 30000 && !confirm('停止後，還沒保存的回放畫面會被清掉。確定要停止嗎？')) return;
  stopSession(s);
  setIdleMsg('已停止，相機已關閉。按紅色按鈕重新開始。');
}

// ---------- video ----------
function avcLevel(w, h, fps) {
  const mbps = Math.ceil(w / 16) * Math.ceil(h / 16) * fps; // macroblocks per second
  if (mbps <= 108000) return '1F';  // 3.1
  if (mbps <= 216000) return '20';  // 3.2
  if (mbps <= 245760) return '28';  // 4.0
  if (mbps <= 522240) return '2A';  // 4.2
  if (mbps <= 983040) return '33';  // 5.1
  return '34';                      // 5.2
}

async function pickVideoConfig(w, h, fps) {
  const L = avcLevel(w, h, fps);
  const codecs = [`avc1.6400${L}`, `avc1.4D40${L}`, `avc1.42E0${L}`, `avc1.4200${L}`, 'avc1.640034', 'avc1.42E034'];
  const base = { width: w, height: h, bitrate: Math.round(Number(S.mbps) * 1e6), framerate: fps, avc: { format: 'avc' } };
  for (const latencyMode of ['realtime', undefined]) {
    for (const codec of codecs) {
      const cfg = Object.assign({ codec }, base);
      if (latencyMode) cfg.latencyMode = latencyMode;
      try {
        const r = await VideoEncoder.isConfigSupported(cfg);
        if (r.supported) return cfg;
      } catch {}
    }
  }
  return null;
}

async function configureVideo(sess, w, h) {
  sess.configuring = true;
  const hadBuffer = sess.v.length > 0;
  try { sess.vEnc && sess.vEnc.state !== 'closed' && sess.vEnc.close(); } catch {}
  sess.vEnc = null; sess.v = []; sess.vBytes = 0; sess.vMeta = null; sess.lastKey = -Infinity;
  if (hadBuffer) toast('畫面方向或大小改變了，回放緩衝重新開始');
  const fps = Math.round(sess.trackFps || Number(S.fps));
  const cfg = await pickVideoConfig(w, h, fps);
  if (!sess.alive) return;
  if (!cfg) {
    stopSession(sess);
    showStart(`這台裝置無法用 H.264 編碼 ${w}×${h}@${fps}。請到設定調低解析度或幀率。`);
    return;
  }
  const enc = new VideoEncoder({
    output: (chunk, meta) => onVideoChunk(sess, chunk, meta),
    error: (e) => onVideoError(sess, e),
  });
  enc.configure(cfg);
  sess.vEnc = enc; sess.w = w; sess.h = h; sess.vCodec = cfg.codec; sess.vFps = fps;
  sess.configuring = false;
}

function onVideoError(sess, e) {
  console.error('VideoEncoder error', e);
  if (!sess.alive) return;
  sess.vErrors++;
  if (sess.vErrors > 3) { stopSession(sess); showStart('影像編碼器一直出錯：' + (e && e.message)); return; }
  toast('影像編碼器出錯，重新啟動中…');
  sess.w = 0; sess.h = 0; sess.configuring = false; // next frame reconfigures
}

function makeFrame(sess, ts) {
  const w = sess.w, h = sess.h;
  if (!sess.useCanvas) {
    const init = { timestamp: ts };
    if (video.videoWidth !== w || video.videoHeight !== h) init.visibleRect = { x: 0, y: 0, width: w, height: h };
    return new VideoFrame(video, init);
  }
  if (!sess.canvas || sess.canvas.width !== w || sess.canvas.height !== h) {
    sess.canvas = document.createElement('canvas');
    sess.canvas.width = w; sess.canvas.height = h;
    sess.cctx = sess.canvas.getContext('2d', { alpha: false });
  }
  sess.cctx.drawImage(video, 0, 0, w, h);
  return new VideoFrame(sess.canvas, { timestamp: ts });
}

function onFrame(sess, now, md) {
  if (!sess.alive) return;
  video.requestVideoFrameCallback((n, m) => onFrame(sess, n, m));
  const w = video.videoWidth & ~1, h = video.videoHeight & ~1;
  if (!w || !h) return;
  if (w !== sess.w || h !== sess.h) { if (!sess.configuring) configureVideo(sess, w, h); return; }
  const enc = sess.vEnc;
  if (!enc || enc.state !== 'configured') return;
  if (enc.encodeQueueSize > 4) { sess.dropped++; return; }

  // Timestamp in the performance.now() clock (µs). Prefer the real capture time when offered.
  if (sess.useCaptureTime === null) {
    sess.useCaptureTime = !!(md && Number.isFinite(md.captureTime) && Math.abs(md.captureTime - now) < 1000);
  }
  const t = sess.useCaptureTime && Number.isFinite(md.captureTime) ? md.captureTime : now;
  let ts = Math.round(t * 1000);
  if (ts <= sess.lastTs) ts = sess.lastTs + 1;
  sess.lastTs = ts;

  let frame;
  try { frame = makeFrame(sess, ts); }
  catch (e) {
    if (!sess.useCanvas) { sess.useCanvas = true; return; }
    console.error(e); return;
  }
  const key = ts - sess.lastKey >= KEY_US;
  if (key) sess.lastKey = ts;
  try { enc.encode(frame, { keyFrame: key }); } catch (e) { console.error(e); }
  frame.close();
  sess.frames++; sess.fpsCount++;
}

function cleanDecoderConfig(dc) {
  const out = { codec: dc.codec };
  if (dc.codedWidth) out.codedWidth = dc.codedWidth;
  if (dc.codedHeight) out.codedHeight = dc.codedHeight;
  if (dc.sampleRate) out.sampleRate = dc.sampleRate;
  if (dc.numberOfChannels) out.numberOfChannels = dc.numberOfChannels;
  if (dc.description) {
    const d = dc.description;
    const view = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    out.description = view.slice();
  }
  const cs = dc.colorSpace;
  if (cs && cs.primaries && cs.transfer && cs.matrix && cs.fullRange != null) {
    out.colorSpace = { primaries: cs.primaries, transfer: cs.transfer, matrix: cs.matrix, fullRange: cs.fullRange };
  }
  return out;
}

function onVideoChunk(sess, chunk, meta) {
  if (!sess.alive) return;
  if (meta && meta.decoderConfig) sess.vMeta = cleanDecoderConfig(meta.decoderConfig);
  const key = chunk.type === 'key';
  if (!sess.v.length && !key) return;
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  sess.v.push({ ts: chunk.timestamp, key, data });
  sess.vBytes += data.byteLength;
  if (key) trimBuffers(sess);
  if (sess.vMeta && !saving) setSaveEnabled(true);
}

function trimBuffers(sess) {
  const v = sess.v;
  if (v.length) {
    const limit = v[v.length - 1].ts - bufUs();
    let cut = 0;
    for (let i = 0; i < v.length; i++) {
      if (v[i].ts > limit) break;
      if (v[i].key) cut = i;
    }
    if (cut > 0) {
      let b = 0;
      for (let i = 0; i < cut; i++) b += v[i].data.byteLength;
      v.splice(0, cut); sess.vBytes -= b;
    }
  }
  trimAudio(sess);
}

function trimAudio(sess) {
  const arr = sess.aMode === 'pcm' ? sess.pcm : sess.a;
  if (!arr.length) return;
  const ref = sess.v.length ? sess.v[0].ts : arr[arr.length - 1].ts - bufUs();
  const limit = ref - AUDIO_KEEP_EXTRA_US - Math.abs(Number(S.offsetMs) || 0) * 1000;
  let i = 0, b = 0;
  while (i < arr.length && arr[i].ts < limit) { b += arr[i].data.byteLength; i++; }
  if (i > 0) { arr.splice(0, i); sess.aBytes -= b; }
}

// ---------- audio ----------
async function setupAudio(sess) {
  const track = sess.stream.getAudioTracks()[0];
  if (!track) { toast('沒有麥克風，只會錄畫面'); return; }
  const ctx = sess.ctx;
  try { await ctx.resume(); } catch {}
  await ctx.audioWorklet.addModule('audio-tap.js');
  if (!sess.alive) return;
  const ts = track.getSettings ? track.getSettings() : {};
  const ch = Math.min(2, Math.max(1, ts.channelCount || 1));
  const src = ctx.createMediaStreamSource(new MediaStream([track]));
  const node = new AudioWorkletNode(ctx, 'tap-processor', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    channelCount: ch, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    processorOptions: { channels: ch },
  });
  const mute = ctx.createGain(); mute.gain.value = 0;
  src.connect(node); node.connect(mute); mute.connect(ctx.destination);
  sess.node = node; sess.sr = ctx.sampleRate; sess.ch = ch;

  // Pick an encoder: AAC (best compatibility) -> Opus -> raw PCM (saved as a separate WAV).
  sess.aMode = 'pcm';
  if ('AudioEncoder' in window) {
    const tries = [
      { codec: 'mp4a.40.2', muxCodec: 'aac', bitrate: 192000 },
      { codec: 'opus', muxCodec: 'opus', bitrate: 160000 },
    ];
    for (const t of tries) {
      const cfg = { codec: t.codec, sampleRate: sess.sr, numberOfChannels: ch, bitrate: t.bitrate };
      try {
        const r = await AudioEncoder.isConfigSupported(cfg);
        if (!r.supported) continue;
        const enc = new AudioEncoder({
          output: (c, m) => onAudioChunk(sess, c, m),
          error: (e) => { console.error('AudioEncoder error', e); if (sess.alive) { sess.aMode = 'none'; toast('聲音編碼器出錯，之後的影片會沒有聲音'); } },
        });
        enc.configure(cfg);
        sess.aEnc = enc; sess.aCodec = t.muxCodec; sess.aMode = 'enc';
        sess.aFrameSize = t.muxCodec === 'aac' ? 1024 : Math.round(sess.sr * 0.02);
        break;
      } catch (e) { console.warn(e); }
    }
  }
  if (sess.aMode === 'pcm') toast('這台裝置不支援聲音編碼，聲音會另外存成 WAV 檔', 4000);
  node.port.onmessage = (e) => onAudioBlock(sess, e.data);
}

function onAudioBlock(sess, { frame, frames, data }) {
  if (!sess.alive || sess.aMode === 'none') return;
  const sr = sess.sr;
  const nowUs = performance.now() * 1000;
  const endRel = (frame + frames) / sr * 1e6;
  if (sess.aBase === undefined) sess.aBase = nowUs - endRel;
  // Keep the audio sample clock locked to performance.now() (slow slew for drift, jump for gaps).
  const err = nowUs - (sess.aBase + endRel);
  if (Math.abs(err) > 150000) { sess.aBase += err; sess.aErr = 0; }
  else {
    sess.aErr = sess.aErr * 0.98 + err * 0.02;
    const corr = Math.max(-150, Math.min(150, sess.aErr * 0.05));
    sess.aBase += corr; sess.aErr -= corr;
  }
  const ts = sess.aBase + frame / sr * 1e6;

  if (sess.aMode === 'enc') {
    if (!sess.aEnc || sess.aEnc.state !== 'configured') return;
    const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: frames, numberOfChannels: sess.ch, timestamp: Math.round(ts), data });
    try { sess.aEnc.encode(ad); } catch (e) { console.error(e); }
    ad.close();
  } else if (sess.aMode === 'pcm') {
    const ch = sess.ch, pcm = new Int16Array(frames * ch);
    for (let c = 0; c < ch; c++) {
      const off = c * frames;
      for (let i = 0; i < frames; i++) {
        const s = Math.max(-1, Math.min(1, data[off + i]));
        pcm[i * ch + c] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
    }
    sess.pcm.push({ ts, frames, data: pcm });
    sess.aBytes += pcm.byteLength;
    if (++sess.aPush % 50 === 0) trimAudio(sess);
  }
}

function onAudioChunk(sess, chunk, meta) {
  if (!sess.alive) return;
  if (meta && meta.decoderConfig) sess.aMeta = { decoderConfig: cleanDecoderConfig(meta.decoderConfig) };
  const sr = sess.sr;
  const n = chunk.duration ? Math.round(chunk.duration * sr / 1e6) : sess.aFrameSize;
  // Timestamp from our own sample counter mapped through the drift-corrected clock.
  const ts = sess.aBase + sess.aOut / sr * 1e6;
  sess.aOut += n;
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  sess.a.push({ ts, dur: n / sr * 1e6, data });
  sess.aBytes += data.byteLength;
  if (++sess.aPush % 50 === 0) trimAudio(sess);
}

// ---------- save ----------
function setSaveEnabled(on) { $('#saveBtn').disabled = !on; }

async function saveClip() {
  const sess = cur;
  if (saving) return;
  if (!sess || !sess.alive || !sess.v.length || !sess.vMeta) { toast('還在準備中，請稍等…'); return; }
  saving = true; setSaveEnabled(false);
  const fl = $('#flash'); fl.style.opacity = '.55'; setTimeout(() => { fl.style.opacity = '0'; }, 120);
  if (navigator.vibrate) navigator.vibrate(30);
  $('#saveLabel').textContent = '保存中…';
  await new Promise((r) => setTimeout(r, 40));
  try {
    const v = sess.v.slice();
    const newest = v[v.length - 1].ts;
    const limit = newest - bufUs();
    let s = 0;
    for (let i = 0; i < v.length; i++) { if (v[i].ts > limit) break; if (v[i].key) s = i; }
    const t0 = v[s].ts;
    const frameDur = Math.round(1e6 / (sess.vFps || 30));
    const tEnd = newest + frameDur;
    const off = (Number(S.offsetMs) || 0) * 1000;
    const hasAudio = sess.aMode === 'enc' && sess.aMeta && sess.a.length > 0;

    const muxer = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: 'avc', width: sess.w, height: sess.h },
      audio: hasAudio ? { codec: sess.aCodec, numberOfChannels: sess.ch, sampleRate: sess.sr } : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'cross-track-offset',
    });
    for (let i = s; i < v.length; i++) {
      const c = v[i];
      const next = i + 1 < v.length ? v[i + 1].ts : c.ts + frameDur;
      muxer.addVideoChunkRaw(c.data, c.key ? 'key' : 'delta', c.ts - t0, Math.max(1, next - c.ts), i === s ? { decoderConfig: sess.vMeta } : undefined);
    }
    if (hasAudio) {
      let first = true, last = -1;
      for (const c of sess.a.slice()) {
        const t = Math.round(c.ts + off - t0);
        if (t < 0 || t > tEnd - t0 || t <= last) continue;
        muxer.addAudioChunkRaw(c.data, 'key', t, c.dur, first ? sess.aMeta : undefined);
        first = false; last = t;
      }
    }
    muxer.finalize();
    const stamp = fileStamp();
    const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
    const clip = { id: stamp + Math.random(), name: `replay_${stamp}.mp4`, blob, dur: (tEnd - t0) / 1e6, w: sess.w, h: sess.h };
    if (sess.aMode === 'pcm' && sess.pcm.length) {
      clip.wav = { name: `replay_${stamp}.wav`, blob: makeWav(sess.pcm.slice(), sess.sr, sess.ch, t0 - off, tEnd - off) };
    }
    addClip(clip);
    lastSaveAt = Date.now();
    toast(`已保存 ${fmtTime(clip.dur)}，點右上角影片圖示存到相簿`);
  } catch (e) {
    console.error(e);
    toast('保存失敗：' + (e && e.message ? e.message : e), 5000);
  } finally {
    saving = false;
    $('#saveLabel').textContent = cur && cur.alive ? `保存過去 ${minutesLabel()}` : '按下開始';
    if (cur && cur.alive && cur.vMeta) setSaveEnabled(true);
  }
}

function makeWav(blocks, sr, ch, tStart, tEnd) {
  const parts = [];
  let total = 0;
  for (const b of blocks) {
    const bEnd = b.ts + b.frames / sr * 1e6;
    if (bEnd < tStart || b.ts > tEnd) continue;
    parts.push(b.data); total += b.data.byteLength;
  }
  const header = new DataView(new ArrayBuffer(44));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) header.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); header.setUint32(4, 36 + total, true); w(8, 'WAVE');
  w(12, 'fmt '); header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, ch, true);
  header.setUint32(24, sr, true); header.setUint32(28, sr * ch * 2, true); header.setUint16(32, ch * 2, true); header.setUint16(34, 16, true);
  w(36, 'data'); header.setUint32(40, total, true);
  return new Blob([header, ...parts], { type: 'audio/wav' });
}

function fileStamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------- clips ----------
const clips = [];
function addClip(c) { c.url = URL.createObjectURL(c.blob); clips.unshift(c); renderClips(); }
function removeClip(id) {
  const i = clips.findIndex((c) => c.id === id);
  if (i < 0) return;
  URL.revokeObjectURL(clips[i].url);
  clips.splice(i, 1); renderClips();
}
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function shareClip(c) {
  const files = [new File([c.blob], c.name, { type: 'video/mp4' })];
  if (c.wav) files.push(new File([c.wav.blob], c.wav.name, { type: 'audio/wav' }));
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files, title: c.name }); }
    catch (e) { if (e.name !== 'AbortError') toast('分享失敗：' + e.message); }
  } else {
    toast('這個瀏覽器不能直接分享，改用下載');
    download(c.blob, c.name);
  }
}
function renderClips() {
  const n = clips.length;
  $('#clipCount').hidden = n === 0; $('#clipCount').textContent = n;
  const list = $('#clipList');
  list.textContent = '';
  if (!n) { list.innerHTML = '<div class="empty">還沒有保存的影片</div>'; return; }
  for (const c of clips) {
    const row = document.createElement('div'); row.className = 'clip';
    const v = document.createElement('video'); v.src = c.url; v.muted = true; v.playsInline = true; v.preload = 'metadata'; v.controls = true;
    const info = document.createElement('div'); info.className = 'info';
    const b = document.createElement('b'); b.textContent = c.name;
    const meta = document.createElement('span'); meta.className = 'sub';
    meta.textContent = `${fmtTime(c.dur)} ・ ${c.w}×${c.h} ・ ${fmtMB(c.blob.size)}${c.wav ? ' ・ 聲音另存 WAV' : ''}`;
    const acts = document.createElement('div'); acts.className = 'acts';
    const mk = (label, cls, fn) => { const x = document.createElement('button'); x.className = 'secondary ' + (cls || ''); x.textContent = label; x.onclick = fn; acts.appendChild(x); };
    mk('存到相簿／分享', 'share', () => shareClip(c));
    mk('下載', '', () => { download(c.blob, c.name); if (c.wav) download(c.wav.blob, c.wav.name); });
    mk('刪除', '', () => removeClip(c.id));
    info.append(b, meta, acts);
    row.append(v, info);
    list.appendChild(row);
  }
}

// ---------- status loop ----------
setInterval(() => {
  const s = cur;
  if (!s || !s.alive) return;
  const live = s.v.length > 0;
  $('#liveDot').classList.toggle('live', live);
  if (live) {
    const have = Math.min((s.v[s.v.length - 1].ts - s.v[0].ts) / 1e6, bufUs() / 1e6);
    $('#bufText').textContent = `${fmtTime(have)} / ${fmtTime(bufUs() / 1e6)}`;
  } else {
    $('#bufText').textContent = '準備中…';
  }
  const now = performance.now();
  if (now - s.fpsT >= 1000) { s.fpsShown = Math.round(s.fpsCount * 1000 / (now - s.fpsT)); s.fpsCount = 0; s.fpsT = now; }
  const mem = $('#memText');
  mem.hidden = !live;
  mem.textContent = `${fmtMB(s.vBytes + s.aBytes)} ・ ${s.fpsShown} fps`;
}, 500);

// ---------- wake lock ----------
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) { console.warn('wakeLock', e); }
}
function releaseWakeLock() {
  try { wakeLock && wakeLock.release(); } catch {}
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (cur && cur.alive) {
    requestWakeLock();
    if (video.paused) video.play().catch(() => {});
    if (cur.ctx && cur.ctx.state !== 'running') cur.ctx.resume().catch(() => {});
    const vt = cur.stream && cur.stream.getVideoTracks()[0];
    if (vt && vt.readyState === 'ended') { stopSession(cur); setIdleMsg('相機被系統關閉了（可能是切到別的 App 或鎖定螢幕）。按紅色按鈕重新開始。'); }
  }
});

// ---------- settings sheet ----------
function openSheet(id) { $(id).classList.add('open'); }
function closeSheets() { document.querySelectorAll('.sheet-wrap').forEach((x) => x.classList.remove('open')); }
document.querySelectorAll('.sheet-wrap').forEach((w) => {
  w.addEventListener('click', (e) => { if (e.target === w || e.target.closest('[data-close]')) closeSheets(); });
});

function fillSettings() {
  $('#sMinutes').value = S.minutes; $('#sRes').value = S.res; $('#sFps').value = String(S.fps);
  $('#sMbps').value = String(S.mbps); $('#sOffset').value = S.offsetMs; $('#sRawAudio').checked = !!S.rawAudio;
  updateEstimate();
  const s = cur;
  $('#caps').textContent = s && s.alive && s.w
    ? `目前：${s.vCodec} ${s.w}×${s.h} @ ${s.vFps}fps ・ 聲音 ${s.aMode === 'enc' ? s.aCodec.toUpperCase() : s.aMode === 'pcm' ? 'WAV（另存）' : '無'} ${s.sr ? (s.sr / 1000) + 'kHz ' + s.ch + 'ch' : ''}${s.useCanvas ? ' ・ canvas 模式' : ''}`
    : '';
}
function updateEstimate() {
  const min = Math.max(0.25, Number($('#sMinutes').value) || 2);
  const mbps = Number($('#sMbps').value);
  const mb = (mbps * 1e6 + 192e3) / 8 * min * 60 / 1048576;
  const el = $('#estimate');
  el.textContent = `預估回放緩衝會佔用約 ${Math.round(mb)} MB 記憶體，按保存的瞬間還需要差不多一倍。` +
    (mb > 450 ? '這樣有點多，iPhone 可能會把 App 強制關掉，建議縮短時間或降低畫質。' : '');
  el.classList.toggle('warn', mb > 450);
}
['#sMinutes', '#sMbps'].forEach((s) => $(s).addEventListener('input', updateEstimate));

$('#applyBtn').addEventListener('click', () => {
  S.minutes = Math.min(30, Math.max(0.25, Number($('#sMinutes').value) || 2));
  S.res = $('#sRes').value; S.fps = Number($('#sFps').value); S.mbps = Number($('#sMbps').value);
  S.offsetMs = Math.max(-1000, Math.min(1000, Number($('#sOffset').value) || 0));
  S.rawAudio = $('#sRawAudio').checked;
  saveSettings(); closeSheets();
  if (cur && cur.alive) startSession(); else toast('設定已儲存');
});
// Offset can change without restarting: it is applied at save time.
$('#sOffset').addEventListener('change', () => {
  S.offsetMs = Math.max(-1000, Math.min(1000, Number($('#sOffset').value) || 0)); saveSettings();
});

// ---------- camera controls (focus / exposure / white balance / zoom / torch) ----------
function vTrack() { return cur && cur.alive && cur.stream ? cur.stream.getVideoTracks()[0] : null; }
function camCaps(t) { try { return t.getCapabilities ? t.getCapabilities() : {}; } catch { return {}; } }
function camSettings(t) { try { return t.getSettings(); } catch { return {}; } }
const isRange = (v) => v && typeof v === 'object' && !Array.isArray(v) && Number.isFinite(v.min) && Number.isFinite(v.max) && v.max > v.min;
const modesOf = (caps, k) => (Array.isArray(caps[k]) ? caps[k] : []);

// Apply constraints and check that string/boolean values actually took effect
// (unsatisfiable "advanced" constraints are silently ignored by browsers).
async function applyCam(c, quiet) {
  const t = vTrack();
  if (!t) return false;
  const took = () => {
    const s = camSettings(t);
    return Object.keys(c).every((k) => typeof c[k] !== 'string' && typeof c[k] !== 'boolean' ? true : s[k] === undefined || s[k] === c[k]);
  };
  try { await t.applyConstraints({ advanced: [c] }); if (took()) return true; } catch (e) { console.warn('advanced', e); }
  try {
    const exact = {};
    for (const k of Object.keys(c)) exact[k] = (typeof c[k] === 'object') ? c[k] : { exact: c[k] };
    await t.applyConstraints(exact);
    if (took()) return true;
  } catch (e) { console.warn('exact', e); }
  if (!quiet) toast('這支手機沒有套用這個設定');
  return false;
}

function fmtShutter(v100us) { // exposureTime is in units of 100 µs
  const s = v100us / 1e4;
  return s >= 0.5 ? s.toFixed(1) + ' 秒' : '1/' + Math.round(1 / s) + ' 秒';
}
const round = (v, step) => (step ? Math.round(v / step) * step : v);

function camRow(label, hint) {
  const row = document.createElement('div'); row.className = 'row';
  const l = document.createElement('label'); l.textContent = label;
  if (hint) { const sm = document.createElement('small'); sm.textContent = hint; l.appendChild(sm); }
  row.appendChild(l);
  return row;
}
function camToggle(box, label, hint, checked, onChange) {
  const row = camRow(label, hint);
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!checked;
  cb.onchange = async () => { cb.disabled = true; await onChange(cb.checked); cb.disabled = false; refreshCamPanel(); };
  row.appendChild(cb); box.appendChild(row);
  return cb;
}
function camSlider(box, label, range, value, fmt, onCommit) {
  const row = document.createElement('div'); row.className = 'row col';
  const top = document.createElement('div'); top.className = 'top';
  const l = document.createElement('label'); l.textContent = label;
  const val = document.createElement('span'); val.className = 'val';
  top.append(l, val);
  const inp = document.createElement('input'); inp.type = 'range';
  inp.min = range.min; inp.max = range.max; inp.step = range.step || (range.max - range.min) / 100;
  inp.value = Number.isFinite(value) ? value : range.min;
  val.textContent = fmt(Number(inp.value));
  let busy = false, pending = null;
  const send = async () => {
    if (busy) return; busy = true;
    while (pending !== null) { const v = pending; pending = null; await onCommit(v); }
    busy = false;
  };
  inp.oninput = () => { val.textContent = fmt(Number(inp.value)); pending = Number(inp.value); send(); };
  row.append(top, inp); box.appendChild(row);
}
function camSection(box, title) { const d = document.createElement('div'); d.className = 'sec'; d.textContent = title; box.appendChild(d); }

function refreshCamPanel() { if ($('#camSheet').classList.contains('open')) buildCamPanel(); }

function buildCamPanel() {
  const box = $('#camControls');
  box.textContent = '';
  const t = vTrack();
  if (!t) { box.innerHTML = '<div class="empty">先按開始，開啟相機後才能調整。</div>'; return; }
  const caps = camCaps(t), set = camSettings(t);
  let shown = 0;

  // Focus
  const fModes = modesOf(caps, 'focusMode');
  const canLockF = fModes.includes('manual') || fModes.includes('single-shot');
  if (canLockF || isRange(caps.focusDistance)) {
    camSection(box, '對焦'); shown++;
    if (canLockF) {
      camToggle(box, '鎖定對焦', '鎖在現在對到的位置，手指晃過去也不會重新對焦', set.focusMode && set.focusMode !== 'continuous', async (on) => {
        if (!on) return applyCam({ focusMode: 'continuous' });
        const s = camSettings(t);
        if (fModes.includes('manual') && Number.isFinite(s.focusDistance)) return applyCam({ focusMode: 'manual', focusDistance: s.focusDistance });
        return applyCam({ focusMode: fModes.includes('single-shot') ? 'single-shot' : 'manual' });
      });
    }
    if (isRange(caps.focusDistance) && fModes.includes('manual')) {
      const r = caps.focusDistance;
      camSlider(box, '對焦距離（手動）', r, set.focusDistance, (v) => v.toFixed(2), (v) => applyCam({ focusMode: 'manual', focusDistance: v }, true));
    }
  }

  // Exposure
  const eModes = modesOf(caps, 'exposureMode');
  const canLockE = eModes.includes('manual') || eModes.includes('single-shot');
  const hasShutter = isRange(caps.exposureTime) && eModes.includes('manual');
  const hasIso = isRange(caps.iso) && eModes.includes('manual');
  if (canLockE || isRange(caps.exposureCompensation) || hasShutter) {
    camSection(box, '曝光'); shown++;
    if (canLockE) {
      camToggle(box, '鎖定曝光', '螢幕閃爍時亮度不會一直跳', set.exposureMode && set.exposureMode !== 'continuous', async (on) => {
        if (!on) return applyCam({ exposureMode: 'continuous' });
        const s = camSettings(t);
        if (eModes.includes('manual') && Number.isFinite(s.exposureTime)) {
          const c = { exposureMode: 'manual', exposureTime: s.exposureTime };
          if (Number.isFinite(s.iso)) c.iso = s.iso;
          return applyCam(c);
        }
        return applyCam({ exposureMode: eModes.includes('single-shot') ? 'single-shot' : 'manual' });
      });
    }
    if (isRange(caps.exposureCompensation)) {
      camSlider(box, '曝光補償（自動曝光時）', caps.exposureCompensation, set.exposureCompensation ?? 0,
        (v) => (Math.abs(v) < 0.05 ? '0.0' : (v > 0 ? '+' : '') + v.toFixed(1)) + ' EV', (v) => applyCam({ exposureCompensation: round(v, caps.exposureCompensation.step) }, true));
    }
    if (hasShutter) {
      const r = caps.exposureTime;
      const row = camRow('快門速度', '越快手指越不會糊，但畫面會變暗');
      const sel = document.createElement('select');
      sel.add(new Option('自動', 'auto'));
      for (const den of [30, 60, 120, 250, 500, 1000, 2000]) {
        const v = 1e4 / den;
        if (v >= r.min && v <= r.max) sel.add(new Option('1/' + den + ' 秒', String(v)));
      }
      sel.value = set.exposureMode === 'manual' && Number.isFinite(set.exposureTime)
        ? ([...sel.options].find((o) => o.value !== 'auto' && Math.abs(Number(o.value) - set.exposureTime) / set.exposureTime < 0.08) || { value: 'auto' }).value
        : 'auto';
      if (sel.value === 'auto' && set.exposureMode === 'manual' && Number.isFinite(set.exposureTime)) {
        sel.add(new Option(fmtShutter(set.exposureTime) + '（目前）', 'cur')); sel.value = 'cur';
      }
      sel.onchange = async () => {
        if (sel.value === 'cur') return;
        if (sel.value === 'auto') await applyCam({ exposureMode: 'continuous' });
        else {
          const c = { exposureMode: 'manual', exposureTime: Number(sel.value) };
          const s = camSettings(t);
          if (Number.isFinite(s.iso)) c.iso = s.iso;
          await applyCam(c);
        }
        refreshCamPanel();
      };
      row.appendChild(sel); box.appendChild(row);
    }
    if (hasIso) {
      camSlider(box, 'ISO（手動曝光時）', caps.iso, set.iso, (v) => String(Math.round(v)), (v) => {
        const s = camSettings(t);
        const c = { exposureMode: 'manual', iso: round(v, caps.iso.step) };
        if (Number.isFinite(s.exposureTime)) c.exposureTime = s.exposureTime;
        return applyCam(c, true);
      });
    }
  }

  // White balance
  const wModes = modesOf(caps, 'whiteBalanceMode');
  const canLockW = wModes.includes('manual') || wModes.includes('single-shot');
  if (canLockW || isRange(caps.colorTemperature)) {
    camSection(box, '白平衡'); shown++;
    if (canLockW) {
      camToggle(box, '鎖定白平衡', '螢幕顏色變化時，畫面色調不會跟著飄', set.whiteBalanceMode && set.whiteBalanceMode !== 'continuous', async (on) => {
        if (!on) return applyCam({ whiteBalanceMode: 'continuous' });
        const s = camSettings(t);
        if (wModes.includes('manual') && Number.isFinite(s.colorTemperature)) return applyCam({ whiteBalanceMode: 'manual', colorTemperature: s.colorTemperature });
        return applyCam({ whiteBalanceMode: wModes.includes('single-shot') ? 'single-shot' : 'manual' });
      });
    }
    if (isRange(caps.colorTemperature) && wModes.includes('manual')) {
      camSlider(box, '色溫（手動）', caps.colorTemperature, set.colorTemperature, (v) => Math.round(v) + ' K',
        (v) => applyCam({ whiteBalanceMode: 'manual', colorTemperature: round(v, caps.colorTemperature.step) }, true));
    }
  }

  // Zoom / torch
  const hasTorch = caps.torch === true || (Array.isArray(caps.torch) && caps.torch.includes(true));
  if (isRange(caps.zoom) || hasTorch) {
    camSection(box, '其他'); shown++;
    if (isRange(caps.zoom)) {
      camSlider(box, '變焦', caps.zoom, set.zoom, (v) => v.toFixed(1) + '×', (v) => applyCam({ zoom: round(v, caps.zoom.step) }, true));
    }
    if (hasTorch) camToggle(box, '補光燈', '', !!set.torch, (on) => applyCam({ torch: on }));
  }

  if (!shown) {
    box.innerHTML = '<div class="empty">這支手機的瀏覽器沒有開放任何鏡頭控制。<br>（iPhone 的 Safari 常常是這樣，只能靠原生 App 才能鎖對焦／曝光。）</div>';
  }
  $('#camReset').hidden = !shown;

  // Capability report
  const yes = (b) => (b ? '✅' : '—');
  $('#camCaps').innerHTML = '';
  const lines = [
    ['鎖定對焦', canLockF], ['手動對焦距離', isRange(caps.focusDistance) && fModes.includes('manual')],
    ['鎖定曝光', canLockE], ['曝光補償', isRange(caps.exposureCompensation)], ['手動快門', hasShutter], ['手動 ISO', hasIso],
    ['鎖定白平衡', canLockW], ['手動色溫', isRange(caps.colorTemperature) && wModes.includes('manual')],
    ['變焦', isRange(caps.zoom)], ['補光燈', hasTorch], ['點畫面對焦', tapFocusSupported(caps)],
  ];
  const ul = document.createElement('div');
  ul.textContent = lines.map(([n, b]) => `${yes(b)} ${n}`).join('　');
  ul.style.lineHeight = '1.9';
  $('#camCaps').appendChild(ul);
  $('#camRaw').textContent = 'capabilities: ' + JSON.stringify(caps) + '\n\nsettings: ' + JSON.stringify(set) + '\n\n' + navigator.userAgent;
}

$('#camReset').addEventListener('click', async () => {
  const t = vTrack(); if (!t) return;
  const caps = camCaps(t), c = {};
  if (modesOf(caps, 'focusMode').includes('continuous')) c.focusMode = 'continuous';
  if (modesOf(caps, 'exposureMode').includes('continuous')) c.exposureMode = 'continuous';
  if (modesOf(caps, 'whiteBalanceMode').includes('continuous')) c.whiteBalanceMode = 'continuous';
  if (isRange(caps.exposureCompensation)) c.exposureCompensation = 0;
  if (Object.keys(c).length) await applyCam(c);
  toast('已恢復自動');
  refreshCamPanel();
});

// Tap on the preview to focus / meter at that point (Android Chrome).
function tapFocusSupported(caps) {
  const sup = navigator.mediaDevices.getSupportedConstraints ? navigator.mediaDevices.getSupportedConstraints() : {};
  return !!sup.pointsOfInterest && (modesOf(caps, 'focusMode').length > 0 || modesOf(caps, 'exposureMode').length > 0);
}
video.addEventListener('click', async (e) => {
  const t = vTrack();
  if (!t || document.body.classList.contains('dimmed')) return;
  const caps = camCaps(t);
  if (!tapFocusSupported(caps)) return;
  // Map the tap into the video frame (object-fit: contain, maybe mirrored).
  const r = video.getBoundingClientRect(), vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  const scale = Math.min(r.width / vw, r.height / vh);
  const dw = vw * scale, dh = vh * scale, ox = r.left + (r.width - dw) / 2, oy = r.top + (r.height - dh) / 2;
  let x = (e.clientX - ox) / dw, y = (e.clientY - oy) / dh;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  if (video.classList.contains('mirror')) x = 1 - x;
  const ring = $('#focusRing');
  ring.style.left = e.clientX + 'px'; ring.style.top = e.clientY + 'px';
  ring.classList.add('show'); setTimeout(() => ring.classList.remove('show'), 900);
  const c = { pointsOfInterest: [{ x, y }] };
  const f = modesOf(caps, 'focusMode'), ex = modesOf(caps, 'exposureMode');
  if (f.includes('single-shot')) c.focusMode = 'single-shot'; else if (f.includes('continuous')) c.focusMode = 'continuous';
  if (ex.includes('continuous')) c.exposureMode = 'continuous';
  await applyCam(c, true);
  refreshCamPanel();
});

// ---------- buttons ----------
$('#camBtn').addEventListener('click', () => { buildCamPanel(); openSheet('#camSheet'); });
$('#startBtn').addEventListener('click', () => startSession());
$('#goBtn').addEventListener('click', () => startSession());
$('#stopBtn').addEventListener('click', () => stopByUser());
$('#saveBtn').addEventListener('click', () => saveClip());
// Power saver: cover the preview with (almost) black. Recording continues underneath.
$('#dimBtn').addEventListener('click', () => document.body.classList.add('dimmed'));
$('#dim').addEventListener('click', () => document.body.classList.remove('dimmed'));
$('#settingsBtn').addEventListener('click', () => { fillSettings(); openSheet('#settingsSheet'); });
$('#clipsBtn').addEventListener('click', () => { renderClips(); openSheet('#clipsSheet'); });
$('#flipBtn').addEventListener('click', () => {
  S.facing = S.facing === 'user' ? 'environment' : 'user'; saveSettings();
  if (cur && cur.alive) startSession();
  else toast(S.facing === 'user' ? '已切換成前鏡頭' : '已切換成後鏡頭');
});
// Bluetooth shutter remotes / keyboards: Space, Enter or Volume Up saves.
document.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('input, select, textarea')) return;
  if (document.querySelector('.sheet-wrap.open')) return;
  if (e.code === 'Space' || e.key === 'Enter' || e.key === 'AudioVolumeUp' || e.key === 'VolumeUp') {
    e.preventDefault(); saveClip();
  }
});
window.addEventListener('beforeunload', (e) => { if (clips.length) { e.preventDefault(); e.returnValue = ''; } });

// ---------- demo stream (for testing without a camera) ----------
function demoStream(sess) {
  const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
  const g = c.getContext('2d');
  let raf, t0 = performance.now();
  const draw = () => {
    const t = (performance.now() - t0) / 1000;
    // White flash during each beep (beeps start on whole seconds of the audio clock) = A/V sync check.
    const flash = (sess.ctx.currentTime % 1) < 0.08;
    g.fillStyle = flash ? '#fff' : `hsl(${(t * 40) % 360},50%,25%)`; g.fillRect(0, 0, 1280, 720);
    g.fillStyle = '#fff'; g.font = 'bold 120px sans-serif'; g.textAlign = 'center';
    g.fillText(t.toFixed(2) + 's', 640, 400);
    g.fillStyle = '#ff3b45'; g.fillRect(((t * 300) % 1380) - 100, 560, 100, 100);
    raf = requestAnimationFrame(draw);
  };
  draw();
  const stream = c.captureStream(30);
  const ctx = sess.ctx, dest = ctx.createMediaStreamDestination();
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.frequency.value = 880; gain.gain.value = 0; osc.connect(gain); gain.connect(dest); osc.start();
  const beep = setInterval(() => { const n = Math.ceil(ctx.currentTime + 0.05); gain.gain.setValueAtTime(0.3, n); gain.gain.setValueAtTime(0, n + 0.08); }, 1000);
  stream.addTrack(dest.stream.getAudioTracks()[0]);
  sess.demoStop = () => { cancelAnimationFrame(raf); clearInterval(beep); };
  return stream;
}

// ---------- init ----------
renderClips();
{
  const why = unsupportedReason();
  if (why) { showStart(why); $('#startBtn').disabled = true; $('#goBtn').disabled = true; setIdleMsg(why); }
}
if ('serviceWorker' in navigator && !DEMO) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('sw', e));
}
window.__rc = { get cur() { return cur; }, clips, saveClip, S };
