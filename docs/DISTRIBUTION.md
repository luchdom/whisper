# Standalone distribution

Meeting Transcriber has two deliberately separate setup paths.

- Contributors use `scripts/bootstrap.ps1` or `scripts/bootstrap.sh` and run the Python sidecar from `backend/.venv`.
- End users install an Electron distribution containing a platform-native PyInstaller `onedir` sidecar. They do not install Python, native Python packages, or repository scripts.

Models are not inside the installer. The existing immutable manifest provisions only the selected ASR, speaker, or translation artifact on first use and verifies its exact size and SHA-256 before load.

## Build commands

Run from the repository root after the source bootstrap:

```text
pnpm run pack
pnpm run dist
```

Both commands install the directly pinned distribution-only tools in `backend/packaging/requirements-build.txt` into the project virtual environment, build the sidecar for the current OS/architecture, write `build/compliance/runtime-inventory.json`, generate `build/compliance/SBOM.cdx.json`, package Electron, and verify the runtime from the packaged resources. `pack` produces an unpacked application; `dist` also produces the configured NSIS/ZIP or DMG/ZIP artifacts.

The native build cannot be cross-compiled. Windows x64 and macOS ARM must each build on that platform. Release automation pins CPython 3.12.10; local developer builds accept the supported 3.12 series and record the actual embedded interpreter version in both inventory and SBOM.

The packaging-time inventory is derived only after the sidecar passes its component probe and JSONL shutdown smoke. It separates Python distributions observed in PyInstaller's analysis records from build-environment tooling and records the embedded CPython library as direct file evidence. The SBOM consumes the observed runtime list and records tools such as PyInstaller under CycloneDX build metadata, not as required application dependencies. Transitive Python versions remain platform-resolved build inputs; neither file claims that they form an immutable cross-platform dependency lock.

## Signed release boundary

`pnpm run dist:signed` runs a platform-specific credential preflight before building, uses `electron-builder.release.cjs` with `forceCodeSigning: true`, and verifies every resulting signature plus macOS notarization after packaging. It fails instead of silently producing an unsigned or unstapled release. The preflight reads only credential names relevant to the host OS and never prints credential values.

- Windows needs `WIN_CSC_LINK` plus `WIN_CSC_KEY_PASSWORD` (preferred), or the cross-platform `CSC_LINK` plus `CSC_KEY_PASSWORD`. The configured signing extensions include `.exe`, `.dll`, and `.pyd`; the post-build verifier requires every such file under `dist` to have a valid Authenticode signature.
- macOS needs `CSC_LINK` plus `CSC_KEY_PASSWORD` for the Developer ID Application identity. Configure exactly one notarization method: `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`, `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER`, or `APPLE_KEYCHAIN`/`APPLE_KEYCHAIN_PROFILE`. The post-build verifier requires each packaged app to pass strict code-signature and stapled-ticket validation before its DMG and ZIP are accepted as release artifacts.

`.github/workflows/signed-release.yml` is manual-only. It never creates or publishes a GitHub release; it builds and uploads workflow artifacts after signature verification. Repository pushes and pull requests use `.github/workflows/validate.yml`, which builds unsigned native packages on Windows x64 and macOS ARM without accessing signing secrets.

## Required acceptance evidence

An artifact is standalone when its packaged sidecar passes `--setup-probe` and the JSONL shutdown smoke with Python injection variables present and with no global Python fallback. That automated boundary is necessary but not sufficient for a public signed release.

Before marking the installer milestone Done, retain privacy-safe evidence for each supported platform:

1. Valid Authenticode, or valid Developer ID signature plus accepted/stapled notarization.
2. Clean install on a machine without Python or repository tools.
3. First launch, engine doctor, model provisioning progress, real transcription start/stop, and transcript autosave.
4. Same-version reinstall restoring a missing/corrupt program runtime (the NSIS definition of repair for this app).
5. Upgrade from the previous signed standalone release while preserving app-owned settings/models/credentials.
6. Uninstall removing program files, processes, and shortcuts. App-owned user data is preserved unless a separately designed, explicit deletion option is chosen.
7. SmartScreen or Gatekeeper behavior, permissions, tray/menu-bar behavior, and one real 60-minute desktop soak.

## Current v0.8.0 evidence

The Windows x64 sidecar built locally as 273 files totaling about 262.5 MiB. Its content-free component probe reported all required modules ready, and its production JSONL shutdown lifecycle passed. The observed runtime inventory, generated SBOM, and notices passed the repository verifier. This establishes a real bundled runtime on Windows; it does not establish Authenticode, clean-machine install/upgrade/repair/uninstall, macOS behavior, or a real desktop 60-minute soak. Those gates keep LUCH-151 in review.
