export async function finalizeCloseLifecycle({
  stopBackend,
  shutdownBackend,
  releaseWindow,
  finishCleanly,
  forceExit
}) {
  try {
    await stopBackend();
  } catch {
    // Shutdown is the final bounded backend cleanup attempt.
  }

  let mustForceExit = false;
  try {
    await shutdownBackend();
  } catch {
    mustForceExit = true;
  }

  try {
    await releaseWindow();
  } catch {
    mustForceExit = true;
  }

  if (!mustForceExit) {
    try {
      await finishCleanly();
      return { forced: false };
    } catch {
      mustForceExit = true;
    }
  }

  try {
    await forceExit(1);
  } catch {
    // There is no further recoverable application lifecycle action.
  }
  return { forced: true };
}

export function getWindowCloseAction({ closeBehavior, quitRequested = false } = {}) {
  if (quitRequested) return "quit";
  return closeBehavior === "tray" ? "hide" : "quit";
}

export function getWindowMinimizeAction({ minimizeToTray } = {}) {
  return minimizeToTray === true ? "hide" : "minimize";
}

export function createCloseCoordinator(runClose) {
  let activeClose = null;
  let quitRequested = false;

  return {
    request({ quit = false } = {}) {
      if (quit) quitRequested = true;
      if (activeClose) return activeClose;

      let trackedClose = null;
      trackedClose = Promise.resolve()
        .then(() => runClose({ shouldQuit: () => quitRequested }))
        .then((result) => {
          if (activeClose === trackedClose && result?.forced === false && !quitRequested) {
            activeClose = null;
            quitRequested = false;
          }
          return result;
        });
      activeClose = trackedClose;
      return trackedClose;
    }
  };
}

export function createCloseReadyGate({
  timeoutMs,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("A positive renderer close timeout is required.");
  }
  let readyResolver = null;

  return {
    async wait(signalRenderer) {
      await new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimer(timer);
          resolve();
        };
        readyResolver = finish;
        timer = setTimer(finish, timeoutMs);
        try {
          signalRenderer();
        } catch {
          finish();
        }
      });
      readyResolver = null;
    },
    notify() {
      readyResolver?.();
    }
  };
}
