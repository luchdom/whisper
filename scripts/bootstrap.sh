#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
BACKEND_ROOT="$REPO_ROOT/backend"
VENV_ROOT="$BACKEND_ROOT/.venv"
VENV_PYTHON="$VENV_ROOT/bin/python"
CONSTRAINTS="$BACKEND_ROOT/constraints.txt"

fail() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

case "${1:-}" in
  ""|--start) ;;
  -h|--help)
    printf '%s\n' "Usage: bash scripts/bootstrap.sh [--start]"
    exit 0
    ;;
  *) fail "Unknown option '$1'. Usage: bash scripts/bootstrap.sh [--start]" 1 ;;
esac

for required_file in "$CONSTRAINTS" "$BACKEND_ROOT/pyproject.toml" "$REPO_ROOT/package.json" "$REPO_ROOT/pnpm-lock.yaml"; do
  [[ -f "$required_file" ]] || fail "The source checkout is incomplete: '$required_file' is missing." 1
done

command -v node >/dev/null 2>&1 \
  || fail "Node.js 22+ is required. Install it from https://nodejs.org/en/download/." 2
NODE_VERSION="$(node --version 2>/dev/null)" \
  || fail "Could not run 'node --version'. Reinstall Node.js from https://nodejs.org/en/download/." 2
node -e 'const [major] = process.versions.node.split(".").map(Number); process.exit(major >= 22 ? 0 : 1)' \
  || fail "Node.js 22 or newer is required; found $NODE_VERSION." 2
printf '%s\n' "Using Node.js $NODE_VERSION."

command -v pnpm >/dev/null 2>&1 \
  || fail "pnpm 10+ is required. Install it using the official instructions at https://pnpm.io/installation." 2
PNPM_VERSION="$(pnpm --version 2>/dev/null)" \
  || fail "Could not run 'pnpm --version'. Reinstall pnpm using https://pnpm.io/installation." 2
PNPM_MAJOR="${PNPM_VERSION%%.*}"
[[ "$PNPM_MAJOR" =~ ^[0-9]+$ ]] && (( PNPM_MAJOR >= 10 )) \
  || fail "pnpm 10 or newer is required; found $PNPM_VERSION." 2
printf '%s\n' "Using pnpm $PNPM_VERSION."

PYTHON_COMMAND=""
PYTHON_VERSION=""
for candidate in python3.12 python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 \
    && version="$($candidate -c 'import sys; print(".".join(map(str, sys.version_info[:3]))); raise SystemExit(0 if sys.implementation.name == "cpython" and sys.version_info[:2] == (3, 12) else 1)' 2>/dev/null)"; then
    PYTHON_COMMAND="$candidate"
    PYTHON_VERSION="$version"
    break
  fi
done
[[ -n "$PYTHON_COMMAND" ]] \
  || fail "Official CPython 3.12.x is required; other Python series are not supported. This script never downloads or installs Python. Use the signed Python 3.12.10 installer from https://www.python.org/downloads/release/python-31210/, then open a new terminal and rerun this command." 2
printf '%s\n' "Using Python $PYTHON_VERSION."

cd "$REPO_ROOT"
if [[ -e "$VENV_ROOT" && ! -x "$VENV_PYTHON" ]]; then
  fail "'$VENV_ROOT' exists but is not a usable macOS virtual environment. Move or remove only that directory, then rerun the bootstrap." 4
fi

if [[ -x "$VENV_PYTHON" ]]; then
  VENV_VERSION="$($VENV_PYTHON -c 'import sys; print(".".join(map(str, sys.version_info[:3]))); raise SystemExit(0 if sys.implementation.name == "cpython" and sys.version_info[:2] == (3, 12) else 1)' 2>/dev/null)" \
    || fail "The existing backend/.venv uses unsupported Python '${VENV_VERSION:-unknown}' or is broken. Move or remove only '$VENV_ROOT', then rerun the bootstrap with Python 3.12.x." 4
  printf '%s\n' "Reusing backend/.venv with Python $VENV_VERSION."
fi

if [[ ! -x "$VENV_PYTHON" ]]; then
  printf '%s\n' "Creating the project-local Python environment..."
  "$PYTHON_COMMAND" -m venv "$VENV_ROOT" \
    || fail "Python could not create backend/.venv. Confirm that the official Python installation includes venv and that the checkout is writable." 3
  [[ -x "$VENV_PYTHON" ]] \
    || fail "Python reported success but backend/.venv/bin/python is missing." 3
fi

printf '%s\n' "Installing the pinned local transcription engine..."
"$VENV_PYTHON" -m pip install \
  --disable-pip-version-check \
  --no-input \
  --constraint "$CONSTRAINTS" \
  -e "$BACKEND_ROOT" \
  || fail "The local transcription engine dependencies could not be installed. Check the preceding pip error, network access, and free disk space, then rerun; the project virtual environment can be reused safely." 3
"$VENV_PYTHON" -m pip check \
  || fail "The Python environment has incompatible dependencies. Review the pip check output; if needed, move or remove only '$VENV_ROOT' and rerun." 4
"$VENV_PYTHON" -I -B -c 'from importlib.metadata import version; from pathlib import Path; import sys; expected=dict(line.split("==", 1) for raw in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines() if (line := raw.strip()) and not line.startswith("#")); actual={name:version(name) for name in expected}; mismatches={name:(expected[name],actual[name]) for name in expected if actual[name] != expected[name]}; print("Pinned Python dependencies verified." if not mismatches else f"Pinned dependency mismatch: {mismatches}"); raise SystemExit(1 if mismatches else 0)' "$CONSTRAINTS" \
  || fail "The installed direct dependency versions do not match backend/constraints.txt." 4
"$VENV_PYTHON" -I -B -c 'import ctranslate2, faster_whisper, huggingface_hub, sentencepiece, sherpa_onnx, meeting_transcriber' \
  || fail "The local engine import check failed. No model was loaded or downloaded." 4

printf '%s\n' "Installing desktop dependencies..."
pnpm install --frozen-lockfile \
  || fail "Desktop dependencies could not be installed from pnpm-lock.yaml. Check the preceding pnpm error, network access, and free disk space, then rerun." 3
pnpm run check \
  || fail "Desktop source checks failed. Fix the reported source error before starting the app." 4

printf '%s\n' "Meeting Transcriber is ready. Run 'pnpm start' from $REPO_ROOT."
if [[ "${1:-}" == "--start" ]]; then
  pnpm start || fail "The app exited with a failure status." 5
fi
