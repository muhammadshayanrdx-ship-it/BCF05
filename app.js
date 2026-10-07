(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const video = $('video');
  const overlay = $('overlay');
  const target = $('target');
  const startBtn = $('startBtn');
  const switchBtn = $('switchBtn');
  const torchBtn = $('torchBtn');
  const statusEl = $('status');
  const countEl = $('count');
  const matchState = $('matchState');
  const matchValue = $('matchValue');
  const resultsList = $('resultsList');
  const resultCount = $('resultCount');
  const clearBtn = $('clearBtn');
  const badge = $('engineBadge');
  const hint = $('centerHint');

  let stream = null;
  let track = null;
  let running = false;
  let busy = false;
  let facing = 'environment';
  let nativeDetector = null;
  let zxingReader = null;
  let lastFrame = 0;
  let lastBeep = 0;
  let animationId = 0;
  let torchOn = false;
  let lastBoxes = [];

  const found = new Map();

  const UPC_FORMATS = ['upc_a', 'upc_e', 'ean_8', 'ean_13'];

  function setStatus(s) { statusEl.textContent = s; }

  function digits(v) { return String(v || '').replace(/\D/g, ''); }

  // A UPC-A is 12 digits: 11 data digits + 1 check digit.
  // Example 95464834640 is 11 digits, so its data suffix is 3464.
  // For a normal 12-digit UPC-A, the last digit is always excluded first.
  function matchingSuffix(code) {
    const d = digits(code);
    if (d.length === 12) return d.slice(0, -1).slice(-4);
    if (d.length === 11) return d.slice(-4); // accepts the user's example too
    if (d.length === 13) return d.slice(0, -1).slice(-4); // EAN-13 fallback
    return d.slice(-4);
  }

  function wanted() { return digits(target.value).slice(0, 4); }
  function isMatch(code) { return wanted().length === 4 && matchingSuffix(code) === wanted(); }

  function beep() {
    const now = Date.now();
    if (now - lastBeep < 700) return;
    lastBeep = now;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 920;
      gain.gain.setValueAtTime(0.001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.19);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(); osc.stop(ctx.currentTime + 0.2);
      setTimeout(() => ctx.close(), 350);
    } catch (_) {}
  }

  function renderResults() {
    resultsList.innerHTML = '';
    const arr = [...found.values()].sort((a, b) => b.time - a.time);
    resultCount.textContent = arr.length;
    countEl.textContent = `${arr.length} found`;
    for (const x of arr) {
      const li = document.createElement('li');
      if (x.match) li.className = 'match';
      const code = document.createElement('span');
      code.className = 'code'; code.textContent = x.text;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${x.format}${x.match ? ' • MATCH' : ''}`;
      li.append(code, meta);
      resultsList.appendChild(li);
    }
  }

  function register(code, format, box) {
    const value = String(code || '').trim();
    if (!value) return;
    const match = isMatch(value);
    const old = found.get(value);
    const item = old || { text: value, format: format || 'barcode', time: 0, match: false, box: null };
    item.format = format || item.format;
    item.time = Date.now();
    item.match = match;
    item.box = box || item.box;
    found.set(value, item);
    if (match) {
      matchState.textContent = 'MATCH FOUND';
      matchValue.textContent = `${value} • item suffix …${matchingSuffix(value)}`;
      beep();
    }
    renderResults();
  }

  function clearCanvas() {
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
  }

  function boxFromPoints(points) {
    if (!points || !points.length) return null;
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(10, Math.max(...xs) - Math.min(...xs)), h: Math.max(10, Math.max(...ys) - Math.min(...ys)) };
  }

  function drawBoxes() {
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    ctx.lineWidth = Math.max(3, overlay.width / 520);
    ctx.strokeStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,.9)';
    ctx.shadowBlur = 6;
    for (const b of lastBoxes) {
      if (!b) continue;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
    }
    ctx.shadowBlur = 0;
  }

  function syncCanvas() {
    if (video.videoWidth && video.videoHeight && (overlay.width !== video.videoWidth || overlay.height !== video.videoHeight)) {
      overlay.width = video.videoWidth;
      overlay.height = video.videoHeight;
    }
  }

  async function setupEngine() {
    // Android/Chrome: use native BarcodeDetector when available. This is the fast path.
    if ('BarcodeDetector' in window) {
      try {
        const supported = await BarcodeDetector.getSupportedFormats();
        const wantedFormats = supported.filter(x => UPC_FORMATS.includes(x));
        nativeDetector = new BarcodeDetector({ formats: wantedFormats.length ? wantedFormats : undefined });
        badge.textContent = 'Native scanner';
        return 'native';
      } catch (_) {}
    }

    // iPhone/Safari fallback: @zxing/browser UMD is loaded by index.html.
    if (window.ZXingBrowser && window.ZXingBrowser.BrowserMultiFormatReader) {
      try {
        zxingReader = new ZXingBrowser.BrowserMultiFormatReader();
        if (zxingReader.possibleFormats && window.ZXingBrowser.BarcodeFormat) {
          zxingReader.possibleFormats = [
            ZXingBrowser.BarcodeFormat.UPC_A,
            ZXingBrowser.BarcodeFormat.UPC_E,
            ZXingBrowser.BarcodeFormat.EAN_8,
            ZXingBrowser.BarcodeFormat.EAN_13
          ];
        }
        badge.textContent = 'iPhone scanner';
        return 'zxing';
      } catch (_) {}
    }

    badge.textContent = 'Decoder unavailable';
    badge.classList.add('bad');
    return null;
  }

  async function nativeScan() {
    const results = await nativeDetector.detect(video);
    lastBoxes = [];
    for (const r of results) {
      const box = r.boundingBox ? { x: r.boundingBox.x, y: r.boundingBox.y, w: r.boundingBox.width, h: r.boundingBox.height } : boxFromPoints(r.cornerPoints);
      lastBoxes.push(box);
      register(r.rawValue, r.format || 'barcode', box);
    }
    drawBoxes();
  }

  async function zxingScan() {
    // ZXing decodes one barcode per image. We scan overlapping tiles so shelf views
    // can contain several UPCs, then deduplicate by raw value.
    const W = video.videoWidth, H = video.videoHeight;
    if (!W || !H) return;
    const tile = document.createElement('canvas');
    const ctx = tile.getContext('2d', { willReadFrequently: true });
    const cols = 3, rows = 3, overlap = 0.22;
    lastBoxes = [];

    for (let row = 0; row < rows && running; row++) {
      for (let col = 0; col < cols && running; col++) {
        const cw = W / cols, ch = H / rows;
        const x = Math.max(0, col * cw - cw * overlap / 2);
        const y = Math.max(0, row * ch - ch * overlap / 2);
        const right = Math.min(W, (col + 1) * cw + cw * overlap / 2);
        const bottom = Math.min(H, (row + 1) * ch + ch * overlap / 2);
        const w = right - x, h = bottom - y;
        tile.width = Math.max(360, Math.round(w));
        tile.height = Math.max(240, Math.round(h));
        ctx.drawImage(video, x, y, w, h, 0, 0, tile.width, tile.height);
        try {
          zxingReader.reset?.();
          const result = zxingReader.decodeFromCanvas(tile);
          if (result) {
            const pts = result.getResultPoints?.() || [];
            const sx = w / tile.width, sy = h / tile.height;
            const mapped = pts.map(p => ({ x: x + p.getX() * sx, y: y + p.getY() * sy }));
            const box = boxFromPoints(mapped);
            register(result.getText(), String(result.getBarcodeFormat?.() || 'barcode'), box);
            lastBoxes.push(box);
          }
        } catch (_) {
          // NotFoundException is normal for most tiles.
        }
      }
    }
    drawBoxes();
  }

  async function scanLoop() {
    if (!running || busy) return;
    const now = performance.now();
    if (now - lastFrame < 220) return;
    lastFrame = now;
    if (video.readyState < 2) return;
    busy = true;
    try {
      syncCanvas();
      if (nativeDetector) await nativeScan();
      else if (zxingReader) await zxingScan();
    } catch (_) {
      // Camera remains active; transient decode failures are expected.
    } finally {
      busy = false;
    }
  }

  function loop() {
    if (!running) return;
    scanLoop();
    animationId = requestAnimationFrame(loop);
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('Camera unavailable');
      matchState.textContent = 'Camera not supported';
      return;
    }
    if (!window.isSecureContext && location.hostname !== 'localhost') {
      setStatus('HTTPS required');
      matchValue.textContent = 'Open the GitHub Pages address with https://';
      return;
    }

    stopCamera();
    found.clear(); renderResults(); clearCanvas();
    const engine = await setupEngine();
    if (!engine) {
      setStatus('Decoder unavailable');
      matchState.textContent = 'Scanner library did not load';
      matchValue.textContent = 'Reload the page while online.';
      return;
    }

    setStatus('Requesting camera…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facing },
          width: { ideal: 1920, min: 640 },
          height: { ideal: 1080, min: 480 },
          aspectRatio: { ideal: 16 / 9 }
        },
        audio: false
      });
      track = stream.getVideoTracks()[0];
      video.srcObject = stream;
      await video.play();
      running = true;
      startBtn.textContent = 'Stop camera';
      hint.style.display = 'none';
      setStatus(engine === 'native' ? 'Scanning fast' : 'Scanning');
      updateTorchButton();
      loop();
    } catch (e) {
      setStatus('Camera permission needed');
      matchState.textContent = 'Camera could not start';
      matchValue.textContent = e?.message || 'Allow camera access and try again.';
    }
  }

  function stopCamera() {
    running = false; busy = false;
    cancelAnimationFrame(animationId);
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; track = null; torchOn = false;
    video.srcObject = null;
    startBtn.textContent = 'Start camera';
    if (!nativeDetector) zxingReader?.reset?.();
  }

  async function switchCamera() {
    facing = facing === 'environment' ? 'user' : 'environment';
    if (running) await startCamera();
  }

  function updateTorchButton() {
    const caps = track?.getCapabilities?.() || {};
    torchBtn.hidden = !caps.torch;
    torchBtn.textContent = torchOn ? 'Flashlight off' : 'Flashlight';
  }

  async function toggleTorch() {
    if (!track?.applyConstraints) return;
    const caps = track.getCapabilities?.() || {};
    if (!caps.torch) return;
    torchOn = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: torchOn }] });
      updateTorchButton();
    } catch (_) { torchOn = !torchOn; }
  }

  target.addEventListener('input', () => {
    target.value = digits(target.value).slice(0, 4);
    const t = wanted();
    if (t.length === 4) {
      matchState.textContent = 'Looking for match';
      matchValue.textContent = `Scanning for …${t}`;
    } else {
      matchState.textContent = 'Waiting for scan';
      matchValue.textContent = 'Enter the last 4 UPC data digits (check digit excluded).';
    }
    for (const item of found.values()) item.match = isMatch(item.text);
    renderResults();
  });

  startBtn.addEventListener('click', () => running ? stopCamera() : startCamera());
  switchBtn.addEventListener('click', switchCamera);
  torchBtn.addEventListener('click', toggleTorch);
  clearBtn.addEventListener('click', () => {
    found.clear(); renderResults(); clearCanvas(); lastBoxes = [];
    matchState.textContent = 'Waiting for scan';
    matchValue.textContent = 'Enter the last 4 UPC data digits (check digit excluded), then start the camera.';
  });
  window.addEventListener('pagehide', stopCamera);
})();
