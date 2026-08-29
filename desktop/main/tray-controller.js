import { deflateSync } from "node:zlib";

const TRAY_STATE_VALUES = Object.freeze([
  "idle",
  "preparing",
  "transcribing",
  "error",
  "stopped"
]);

const TRAY_STATE_SET = new Set(TRAY_STATE_VALUES);

const PRESENTATIONS = Object.freeze({
  idle: Object.freeze({ label: "Ready to start", symbol: "play", color: "#526071" }),
  preparing: Object.freeze({ label: "Preparing local model — not recording", symbol: "hourglass", color: "#a15c00" }),
  transcribing: Object.freeze({ label: "Recording", symbol: "wave", color: "#c3262e" }),
  error: Object.freeze({ label: "Needs attention", symbol: "alert", color: "#c3262e" }),
  stopped: Object.freeze({ label: "Stopped — recording stopped", symbol: "stop", color: "#526071" })
});

export const TRAY_STATES = TRAY_STATE_VALUES;

export function validateTrayStateDto(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).length !== 1 || !TRAY_STATE_SET.has(value.state)) return null;
  return Object.freeze({ state: value.state });
}

export function createTrayController({
  Tray,
  Menu,
  nativeImage,
  platform,
  showWindow,
  requestStop,
  requestQuit,
  now = Date.now,
  setTimer = setInterval,
  clearTimer = clearInterval
} = {}) {
  assertDependency(Tray, "Tray");
  assertDependency(Menu?.buildFromTemplate, "Menu.buildFromTemplate");
  assertDependency(nativeImage?.createFromDataURL, "nativeImage.createFromDataURL");
  assertDependency(showWindow, "showWindow");
  assertDependency(requestStop, "requestStop");
  assertDependency(requestQuit, "requestQuit");

  let state = "idle";
  let transcribingStartedAt = null;
  let elapsedTimer = null;
  let destroyed = false;
  const tray = new Tray(createStateImage(nativeImage, state, platform));

  tray.on("click", () => showWindow({ focusStart: false }));
  tray.on("double-click", () => showWindow({ focusStart: false }));
  render();

  function setState(nextState) {
    if (!TRAY_STATE_SET.has(nextState)) throw new TypeError("Unsupported tray state.");
    if (destroyed) return;

    if (nextState === "transcribing" && state !== "transcribing") {
      transcribingStartedAt = now();
      elapsedTimer = setTimer(render, 1_000);
    } else if (nextState !== "transcribing" && state === "transcribing") {
      if (elapsedTimer !== null) clearTimer(elapsedTimer);
      elapsedTimer = null;
      transcribingStartedAt = null;
    }
    state = nextState;
    render();
  }

  function render() {
    if (destroyed) return;
    const presentation = PRESENTATIONS[state];
    const elapsed = state === "transcribing"
      ? formatElapsed(Math.max(0, now() - (transcribingStartedAt ?? now())))
      : null;
    const statusLabel = elapsed ? `${presentation.label} ${elapsed}` : presentation.label;

    tray.setImage(createStateImage(nativeImage, state, platform));
    tray.setToolTip(`Meeting Transcriber — ${statusLabel}`);
    if (platform === "darwin" && typeof tray.setTitle === "function") {
      tray.setTitle(elapsed ? ` REC ${elapsed}` : "");
    }
    tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate({
      state,
      statusLabel,
      showWindow,
      requestStop,
      requestQuit
    })));
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (elapsedTimer !== null) clearTimer(elapsedTimer);
    elapsedTimer = null;
    tray.destroy();
  }

  return Object.freeze({
    get state() {
      return state;
    },
    setState,
    destroy
  });
}

export function buildMenuTemplate({ state, statusLabel, showWindow, requestStop, requestQuit }) {
  if (!TRAY_STATE_SET.has(state)) throw new TypeError("Unsupported tray state.");
  return [
    { label: statusLabel, enabled: false },
    { type: "separator" },
    state === "preparing"
      ? { label: "Cancel preparation", click: requestStop }
      : state === "transcribing"
        ? { label: "Stop transcription", click: requestStop }
        : { label: "Start transcription…", click: () => showWindow({ focusStart: true }) },
    { label: "Show Meeting Transcriber", click: () => showWindow({ focusStart: false }) },
    { type: "separator" },
    { label: "Quit Meeting Transcriber", click: requestQuit }
  ];
}

export function createTrayIconDataUrl(state) {
  if (!TRAY_STATE_SET.has(state)) throw new TypeError("Unsupported tray state.");
  const presentation = PRESENTATIONS[state];
  const png = createTrayIconPng({
    color: hexToRgba(presentation.color),
    symbol: presentation.symbol
  });
  return `data:image/png;base64,${png.toString("base64")}`;
}

function createStateImage(nativeImage, state, platform) {
  const image = nativeImage.createFromDataURL(createTrayIconDataUrl(state));
  if (image?.isEmpty?.()) throw new Error("The tray status image could not be created.");
  if (platform === "darwin" && typeof image.setTemplateImage === "function") {
    image.setTemplateImage(true);
  }
  return image;
}

function createTrayIconPng({ color, symbol }) {
  const width = 22;
  const height = 22;
  const pixels = Buffer.alloc(width * height * 4);

  const paint = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 4;
    pixels[offset] = color[0];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[2];
    pixels[offset + 3] = color[3];
  };
  const paintRect = (x, y, rectWidth, rectHeight) => {
    for (let row = y; row < y + rectHeight; row += 1) {
      for (let column = x; column < x + rectWidth; column += 1) paint(column, row);
    }
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const distance = Math.hypot(x - 10.5, y - 10.5);
      if (distance >= 8.2 && distance <= 10) paint(x, y);
    }
  }

  if (symbol === "play") {
    for (let column = 0; column < 7; column += 1) {
      const halfHeight = Math.floor(column / 2);
      paintRect(8 + column, 10 - halfHeight, 1, halfHeight * 2 + 2);
    }
  } else if (symbol === "hourglass") {
    paintRect(7, 6, 8, 2);
    paintRect(7, 14, 8, 2);
    for (let step = 0; step < 4; step += 1) {
      paint(8 + step, 8 + step);
      paint(13 - step, 8 + step);
      paint(8 + step, 13 - step);
      paint(13 - step, 13 - step);
    }
  } else if (symbol === "wave") {
    paintRect(6, 9, 2, 4);
    paintRect(9, 6, 2, 10);
    paintRect(12, 8, 2, 6);
    paintRect(15, 9, 2, 4);
  } else if (symbol === "alert") {
    paintRect(10, 6, 2, 7);
    paintRect(10, 15, 2, 2);
  } else {
    paintRect(7, 7, 8, 8);
  }

  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const destination = y * (width * 4 + 1);
    scanlines[destination] = 0;
    pixels.copy(scanlines, destination + 1, y * width * 4, (y + 1) * width * 4);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    createPngChunk("IHDR", header),
    createPngChunk("IDAT", deflateSync(scanlines)),
    createPngChunk("IEND", Buffer.alloc(0))
  ]);
}

function createPngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function crc32(value) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function hexToRgba(value) {
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
    255
  ];
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function assertDependency(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required.`);
}
