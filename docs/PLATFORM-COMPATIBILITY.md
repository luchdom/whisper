# Platform, audio, and overlay compatibility

This document separates source behavior from evidence collected on real operating systems. A policy being implemented or unit-tested does not prove that every meeting client, recorder, screenshot tool, OS release, GPU path, or display topology honors it.

Status language is deliberately strict:

- **Implemented** means the production source contains the policy.
- **Automated** means a deterministic test exercises the application contract without a real capture client.
- **Observed** means a named behavior was seen on local hardware. It applies only to that environment and path.
- **Unverified** means no runtime pass may be claimed yet.

## Current matrix

| Platform / surface | Implemented production policy | Automated evidence | Observed runtime evidence | Remaining external gate |
| --- | --- | --- | --- | --- |
| Windows 11 microphone + system audio | Explicit per-start permission; microphone and system audio remain separate; capture interruption fails visibly; system audio uses Chromium/Electron endpoint loopback. | Capture lifecycle, source separation, interruption, renderer permission, and stop-order tests. | Microphone and live meeting-audio capture have been exercised on one Windows 11 development machine. The strict one-hour backend soak did not use desktop capture. | A 60-minute run through Electron capture, IPC, UI reconciliation, and autosave with real devices. |
| Windows endpoint-audio privacy | The system source is endpoint-wide loopback, not application-scoped capture. | Source selection is allowlisted; no arbitrary renderer capture controls. | No app-by-app audio isolation is claimed. | Confirm notifications and unrelated app sounds are either intentionally included or suppressed at the OS before every work meeting. Process-scoped capture remains future work. |
| Windows overlay default | Accessible mode is fully opaque, focusable, and intentionally capturable. | Policy, persistence, hardened window, shortcut, IPC, and display-recovery tests. | A Windows source-app acceptance observed Accessible/Private transitions, opacity, taskbar policy, and the content-protection flag. | Repeat against the packaged application and supported Windows releases. |
| Windows protected overlay | Private mode calls Electron `setContentProtection(true)`; click-through is transient and recovery-shortcut-gated. Electron maps this to `WDA_EXCLUDEFROMCAPTURE` on supported Windows versions. | Main/controller tests verify the call and ensure disclosure never promises invisibility. | The app-side policy flag was observed. Actual exclusion has not been recorded for Snipping Tool, OBS, Zoom, Meet, Teams, or Webex. | Run the synthetic matrix in [OVERLAY_CAPTURE_ACCEPTANCE.md](OVERLAY_CAPTURE_ACCEPTANCE.md). Every capture path must have its own observation. |
| Windows multi-display / DPI / full screen | Bounds are stored in display-independent pixels, clamped to an available work area, and recovered when a display disappears. | Negative coordinates, missing displays, unsafe bounds, and debounced display recovery are covered. | Responsive source-app layouts were observed at several viewport widths; this is not mixed-DPI or full-screen capture evidence. | Primary and mixed-DPI secondary displays, full-screen presentation, focus, sleep/resume, and forced-exit cleanup. |
| macOS microphone | Microphone-only capture remains available where system audio is unavailable, subject to OS permission. | Platform gates and renderer capture contracts. | **Unverified on macOS hardware.** | Permission denial/recovery, 60-minute capture, sleep/resume, autosave, and packaged/signature behavior on both supported Apple Silicon environments. |
| macOS 15+ system audio | The app opts into Electron's native system picker on macOS and exposes system audio only on macOS 15 or newer. | Version gating and exact renderer permission contracts. | **Unverified on macOS hardware.** | Native picker scope, selected-surface audio, microphone coexistence, interruptions, performance, and a 60-minute end-to-end meeting. |
| macOS protected overlay | Private mode calls `setContentProtection(true)` and keeps the non-guarantee disclosure. | The same deterministic mode, persistence, click-through, shortcut, and IPC contracts as Windows. | **Unverified on macOS hardware.** | Do not use capture exclusion as a macOS release promise. Validate overt behavior and the disclosure in each supported meeting client. |
| Zoom / Google Meet / Teams / Webex | No client-specific hook, injection, evasion, meeting detection, or hidden mode exists. The app is an overt companion window. | Capture and overlay boundaries are client-agnostic. | No complete cross-client capture matrix is recorded. | Separate sender and recipient observations on each supported client/version, with synthetic content only. |
| OBS and screenshots | No recorder-specific bypass exists. Private mode only requests the OS protection available through Electron. | Synthetic dual-window fixture and fail-closed manifest evaluator. | No complete runtime matrix is recorded. | Observe OBS Display Capture and Windows screenshot paths; record failures as failures, never as an unsupported claim of stealth. |

Electron documents that `setContentProtection(true)` calls `WDA_EXCLUDEFROMCAPTURE` on Windows 10 version 2004 and newer. It also documents a critical macOS limitation: the API sets the legacy `NSWindowSharingNone` flag, but newer applications using ScreenCaptureKit can still capture the window. Apple now describes `NSWindowSharingNone` as a legacy constant that should not be used to hide or omit captured content. See the [Electron BrowserWindow API](https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable-macos-windows) and [Apple's NSWindowSharingNone documentation](https://developer.apple.com/documentation/appkit/nswindow/sharingtype-swift.enum/none).

Therefore:

- Private mode is a best-effort local privacy aid, not an anti-detection feature.
- The overlay may appear in a meeting, recording, screenshot, camera view, or OS preview.
- A successful observation applies only to the tested OS build, GPU/display path, capture mode, and client version.
- A failed or skipped observation keeps the relevant gate open.
- The product must never be described as hidden, invisible, undetectable, or safe for covert recording.

## Release evidence boundary

A cross-platform release claim requires all of the following to be reported separately:

1. Deterministic repository tests.
2. Packaged Windows runtime results.
3. Packaged macOS runtime results on hardware.
4. One-hour desktop capture/autosave soaks on each platform.
5. Capture-client observations for Zoom, Meet, Teams, Webex, OBS, and screenshots.
6. Focus, primary/secondary monitor, mixed-DPI, full-screen, sleep/resume, interruption, and crash/forced-exit recovery.
7. Privacy cleanup confirmation with no screenshot, recording, transcript, credential, participant data, or raw provider payload stored in Git or Linear.

Backend JSONL-sidecar soak evidence does not satisfy desktop capture, Electron UI, autosave, capture-exclusion, or macOS gates.
