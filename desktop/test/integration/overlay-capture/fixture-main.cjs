const { app, BrowserWindow, screen } = require("electron");

const CANARY_PATTERN = /^MT-[A-F0-9]{8}$/u;
const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[a-f0-9]{8}$/u;

function readArgument(prefix, pattern) {
  const raw = process.argv.find((value) => value.startsWith(prefix));
  const value = raw?.slice(prefix.length) ?? "";
  if (!pattern.test(value)) {
    throw new Error(`Missing or invalid ${prefix.slice(2, -1)} argument.`);
  }
  return value;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function page({ role, title, canary, runId }) {
  const isCard = role === "card";
  const palette = role === "private"
    ? { background: "#5b123f", accent: "#ff70c7", text: "#fff5fb" }
    : role === "baseline"
      ? { background: "#103f70", accent: "#75c7ff", text: "#f4fbff" }
      : { background: "#10151e", accent: "#93f6c9", text: "#f6fbff" };
  const body = isCard
    ? `<main>
        <p class="eyebrow">Synthetic capture surface</p>
        <h1>Overlay privacy acceptance</h1>
        <p>No meeting, transcript, account, or participant data is shown by this fixture.</p>
        <div class="grid" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <p class="run">Run ${escapeHtml(runId)}</p>
      </main>`
    : `<main>
        <p class="eyebrow">${escapeHtml(title)}</p>
        <h1>${escapeHtml(canary)}</h1>
        <p>${role === "private" ? "Content protection requested" : "Capture control window"}</p>
      </main>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: dark; font-family: "Segoe UI", system-ui, sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: ${palette.background}; color: ${palette.text}; }
      main { width: min(92%, 760px); text-align: center; padding: 28px; border: 3px solid ${palette.accent}; border-radius: 18px; }
      .eyebrow { margin: 0 0 12px; color: ${palette.accent}; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
      h1 { margin: 0; font-size: clamp(28px, 7vw, 64px); letter-spacing: .04em; }
      p { line-height: 1.5; }
      .run { font-family: ui-monospace, "Cascadia Mono", monospace; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 30px auto; max-width: 420px; }
      .grid i { display: block; aspect-ratio: 2; border-radius: 10px; background: ${palette.accent}; }
      .grid i:nth-child(2), .grid i:nth-child(3) { opacity: .42; }
    </style>
  </head>
  <body>${body}</body>
</html>`;
}

function hardenWindow(window, exactUrl) {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== exactUrl) event.preventDefault();
  });
}

async function loadSyntheticPage(window, options) {
  const url = `data:text/html;charset=UTF-8,${encodeURIComponent(page(options))}`;
  hardenWindow(window, url);
  await window.loadURL(url);
}

async function createFixture() {
  const canary = readArgument("--canary=", CANARY_PATTERN);
  const runId = readArgument("--run-id=", RUN_ID_PATTERN);
  const { workArea } = screen.getPrimaryDisplay();
  const cardWidth = Math.min(960, Math.max(700, workArea.width - 120));
  const cardHeight = Math.min(680, Math.max(520, workArea.height - 140));
  const cardX = Math.round(workArea.x + (workArea.width - cardWidth) / 2);
  const cardY = Math.round(workArea.y + (workArea.height - cardHeight) / 2);

  const commonWebPreferences = {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    devTools: false,
    webSecurity: true
  };

  const card = new BrowserWindow({
    title: "Synthetic overlay capture test card",
    show: false,
    x: cardX,
    y: cardY,
    width: cardWidth,
    height: cardHeight,
    backgroundColor: "#10151e",
    autoHideMenuBar: true,
    webPreferences: commonWebPreferences
  });
  await loadSyntheticPage(card, {
    role: "card",
    title: "Synthetic overlay capture test card",
    canary,
    runId
  });

  const overlayWidth = Math.min(460, Math.max(380, Math.floor(workArea.width * 0.34)));
  const overlayHeight = 220;
  const baseline = new BrowserWindow({
    title: "BASELINE - must be visible in capture",
    show: false,
    x: workArea.x + 28,
    y: workArea.y + 28,
    width: overlayWidth,
    height: overlayHeight,
    alwaysOnTop: true,
    fullScreenable: false,
    backgroundColor: "#103f70",
    autoHideMenuBar: true,
    webPreferences: commonWebPreferences
  });
  baseline.setContentProtection(false);
  baseline.setAlwaysOnTop(true, "floating");
  await loadSyntheticPage(baseline, {
    role: "baseline",
    title: "BASELINE - visible in capture",
    canary,
    runId
  });

  const privateWindow = new BrowserWindow({
    title: "PRIVATE - content protection requested",
    show: false,
    x: workArea.x + workArea.width - overlayWidth - 28,
    y: workArea.y + workArea.height - overlayHeight - 28,
    width: overlayWidth,
    height: overlayHeight,
    alwaysOnTop: true,
    fullScreenable: false,
    backgroundColor: "#5b123f",
    autoHideMenuBar: true,
    webPreferences: commonWebPreferences
  });
  privateWindow.setContentProtection(true);
  privateWindow.setAlwaysOnTop(true, "floating");
  await loadSyntheticPage(privateWindow, {
    role: "private",
    title: "PRIVATE - should be excluded on supported Windows capture paths",
    canary,
    runId
  });

  card.show();
  baseline.showInactive();
  privateWindow.showInactive();
}

app.whenReady().then(createFixture).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  app.exit(1);
});

app.on("window-all-closed", () => app.quit());
