import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rendererUrl = new URL("../renderer/", import.meta.url);

test("settings leads with a polite local-engine doctor and fixed remediation actions", async () => {
  const html = await readFile(new URL("index.html", rendererUrl), "utf8");
  const localEngine = html.indexOf('id="engine-settings-heading">Local engine');
  const speakerLabels = html.indexOf('id="speaker-settings-heading">Speaker labels');
  const doctor = html.slice(html.indexOf('id="engine-setup-card"'), speakerLabels);

  assert.match(html, /Configure the local engine, translation, speaker labels, and transcript saving\./);
  assert.equal(localEngine > 0 && localEngine < speakerLabels, true);
  assert.match(doctor, /aria-live="polite"/);
  assert.doesNotMatch(doctor, /role="alert"/);
  assert.match(doctor, />Open Python download page</);
  assert.match(doctor, />Copy setup command</);
  assert.match(doctor, />Check again</);
});

test("setup readiness fails closed and remediation stays state-specific", async () => {
  const app = await readFile(new URL("app.js", rendererUrl), "utf8");

  for (const state of [
    "ready",
    "python_missing",
    "python_unsupported",
    "components_missing",
    "components_broken",
    "resource_missing",
    "check_failed"
  ]) {
    assert.match(app, new RegExp(`"${state}"`));
  }
  assert.match(app, /bridge\.getEnginePrerequisites\(\)/);
  assert.match(app, /else if \(!state\.active && !isEngineSetupReady\(\)\) openSettings\(\)/);
  assert.match(app, /action: "Open setup"/);
  assert.match(app, /\["python_missing", "python_unsupported"\]\.includes\(engineSetup\.state\)/);
  assert.match(app, /\["components_missing", "components_broken"\]\.includes\(engineSetup\.state\)[^]*?engineSetup\.sourceSetupAvailable/);
  assert.match(app, /bridge\.openPythonDownloadPage\(\)/);
  assert.match(app, /bridge\.copyBootstrapCommand\(\)/);
  assert.doesNotMatch(app, /https?:\/\//);
});

test("ordinary Settings opening keeps keyboard focus in the first Local engine section", async () => {
  const app = await readFile(new URL("../renderer/app.js", import.meta.url), "utf8");
  const openSettings = app.slice(app.indexOf("function openSettings"), app.indexOf("function closeSettings"));

  assert.match(openSettings, /focusEngineSetupRemediation\(\)/);
  assert.doesNotMatch(openSettings, /chooseFolder\.focus\(\)/);
});

test("setup actions wrap at the dialog minimum width", async () => {
  const styles = await readFile(new URL("styles.css", rendererUrl), "utf8");
  assert.match(styles, /\.setup-actions,\s*\.folder-actions\s*\{[^}]*flex-wrap:\s*wrap;/s);
  assert.match(styles, /\.setup-actions \.secondary-action\s*\{[^}]*flex:\s*1 1 150px;/s);
});
