# Overlay capture acceptance

This protocol tests an overt privacy aid. It does not test or certify stealth, invisibility, anti-detection, or permission to record. Run it only with synthetic visuals, synthetic meeting rooms, and informed test participants.

## What the Windows harness proves

The harness opens three isolated Electron windows:

- a synthetic background card;
- a blue **BASELINE** window with content protection disabled;
- a magenta **PRIVATE** window with Electron content protection enabled.

Both windows contain the same random synthetic canary. On the local desktop, both must be visible. In a supported full-display capture path, the blue baseline must remain visible while the magenta window is absent. This control pair prevents a blank, wrong-display, or stopped capture from being mistaken for successful protection.

The fixture exercises Electron and the operating system directly. Production policy/unit tests separately prove that Meeting Transcriber applies the same `setContentProtection` setting in Private mode. Neither layer alone proves the behavior of every packaged build or third-party capture client.

## Prerequisites

- Windows 11 with the repository bootstrap completed and local Electron installed.
- Current desktop versions of OBS, Zoom, Teams, and Webex, plus a supported Chrome or Edge build for Google Meet.
- A second synthetic meeting participant or separate test device for recipient-view checks.
- A primary monitor and, for a complete gate, a second monitor with a different scale/DPI.
- No work meeting, real transcript, real account context, API key, participant name, or confidential screen content visible.

Use disposable test rooms. Disable cloud recording before starting. The harness never makes a screenshot or recording itself.

## Run the matrix

Review the fixed plan without launching windows:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-overlay-capture.ps1 -PlanOnly
```

Start the interactive run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-overlay-capture.ps1
```

For visual steps, enter only one of these content-free observations:

| Observation | Meaning | Evaluation |
| --- | --- | --- |
| `baseline-only` | Blue baseline visible; magenta private window absent. | Pass where the plan expects protected full-display capture. |
| `both-visible` | Both windows visible in the inspected surface. | Local-desktop baseline pass, or capture-protection failure when exclusion was expected. |
| `neither-visible` | Neither control is visible. | Invalid/failed capture; never evidence of protection. |
| `unexpected` | Any other visual result, including only the private window. | Failure. |
| `not-run` | The step was skipped or hardware/client was unavailable. | Incomplete; no overall pass. |

Free-text notes are intentionally disabled. The script writes only fixed step IDs, enumerated outcomes, timestamps, generic OS/runtime versions, and an aggregate status to:

```text
%TEMP%\meeting-transcriber-overlay-acceptance\<run-id>\manifest.json
```

It writes no pixels, audio, transcript, meeting identifiers, host name, user name, file paths outside the temporary evidence root, or third-party account details. A pass is impossible unless every required step has an explicit passing observation. Any skip yields `incomplete`; any contrary observation yields `failed`.

After review, delete the exact temporary run using the command printed by the harness:

```powershell
.\scripts\verify-overlay-capture.ps1 -CleanupRunId <run-id>
```

The cleanup command validates that the resolved target is one exact child of the dedicated OS-temp evidence directory before deleting it.

## Required capture surfaces

For every meeting client, share the whole fixture display—not a single application window. A single-window share that never included the private window is not a valid content-protection observation.

| Surface | Required view | Pass observation on supported Windows paths |
| --- | --- | --- |
| Windows Snipping Tool / Print Screen | Local screenshot preview including both local window positions. | Baseline only. Delete without saving or immediately delete the file. |
| OBS Display Capture | Local OBS preview of the whole fixture display. | Baseline only. Do not stream; discard any recording. |
| Zoom | Recipient view of full-display share in a synthetic room. | Baseline only. |
| Google Meet | Recipient view of full-display share from the tested browser. | Baseline only. |
| Microsoft Teams | Recipient view of full-display share in a synthetic room. | Baseline only. |
| Webex | Recipient view of full-display share in a synthetic room. | Baseline only. |

Record each client version and OS/GPU/display context outside Git only if release operations require it. Do not put screenshots, recordings, raw manifests, meeting links, account identifiers, or participant details in the repository or Linear. A privacy-safe issue update may contain only aggregate counts such as “5 of 6 capture paths observed; 1 incomplete.”

## Display, focus, and lifecycle checks

The fixed plan also requires:

1. Local visibility of both control windows before capture.
2. Focus movement among the capture client and fixture windows without self-refocusing.
3. Full-display capture on the primary monitor at its normal scale.
4. Full-display capture on a mixed-DPI secondary monitor.
5. Full-screen synthetic presentation with both fixture windows locally visible.
6. Sleep/resume followed by a newly inspected capture preview.
7. Forced fixture termination while a preview is active; both fixture windows must disappear and the capture client must remain controlled.
8. Explicit deletion of every screenshot, local/cloud recording, and test-room artifact.

The forced-exit check validates fixture/window cleanup, not the production transcript recovery path. The packaged application still needs a separate crash/interruption run that confirms visible recording state, capture-track cleanup, sidecar shutdown, autosave truthfulness, and safe restart.

## Production application companion checks

Run these with an empty/synthetic meeting before accepting the packaged app:

- Accessible is the startup default, fully opaque, focusable, and visible to ordinary capture.
- Entering Private requires the exact non-guarantee disclosure acknowledgement.
- Private opacity remains within 60–100%.
- Click-through cannot activate unless the Show/Hide recovery shortcut is registered.
- The recovery shortcut restores a focusable window; restart never restores click-through.
- Show/Hide never starts or stops recording.
- Recording remains visibly indicated in the workspace/tray until native capture cleanup actually completes.
- Display removal, scale changes, and invalid persisted bounds recover to a visible opaque position.
- Sleep, capture-track mute/end, renderer failure, sidecar failure, and forced exit do not leave a false “stopped” state while capture is active.

Automated coverage for these contracts is necessary but does not replace the packaged runtime checks.

## macOS protocol and ScreenCaptureKit limitation

Do not reuse the Windows `baseline-only` expectation as a macOS release gate. Electron documents that current macOS content protection uses the legacy `NSWindowSharingNone` mechanism and that newer capture applications using ScreenCaptureKit can still capture the protected window. Apple describes that flag as legacy and says not to use it to hide or omit captured content.

On supported macOS hardware:

1. Use the packaged/notarized application and synthetic content.
2. Verify Accessible and Private disclosures, opacity, focus, shortcuts, Spaces/full-screen, multiple displays, sleep/resume, and recovery.
3. Observe sender and recipient views in Zoom, Meet, Teams, Webex, OBS-equivalent recording, and macOS screenshots.
4. If the private overlay is visible, record the path as **visible / protection not honored**. Do not relabel it as an expected pass or hide the result.
5. Keep the product overt and assume ScreenCaptureKit can capture the window.

See [PLATFORM-COMPATIBILITY.md](PLATFORM-COMPATIBILITY.md) for the current evidence matrix and authoritative platform caveats.

## One-hour desktop soak

Overlay capture acceptance is separate from the meeting-transcription soak. A platform release requires a real 60-minute desktop run through system/microphone capture, AudioWorklet resampling, Electron IPC, sidecar inference, renderer reconciliation, and autosave. Exercise one display change and one sleep/resume or controlled input interruption during the hour.

The evidence report must remain content-free: duration, selected source types, finalized-segment count, interruption/error-code counts, peak memory, autosave success boolean, clean-shutdown boolean, and platform/build identity. Never include transcript text, participant data, audio, screenshot pixels, transcript paths, provider payloads, credentials, or raw debug logs.
