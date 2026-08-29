[CmdletBinding()]
param(
    [switch]$Start
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$backendRoot = Join-Path $repoRoot "backend"
$venvRoot = Join-Path $backendRoot ".venv"
$venvPython = Join-Path $venvRoot "Scripts\python.exe"
$constraints = Join-Path $backendRoot "constraints.txt"
$pyproject = Join-Path $backendRoot "pyproject.toml"
$pnpmLock = Join-Path $repoRoot "pnpm-lock.yaml"

function Stop-Bootstrap {
    param(
        [Parameter(Mandatory)][string]$Message,
        [Parameter(Mandatory)][int]$ExitCode
    )
    [Console]::Error.WriteLine("Bootstrap failed: $Message")
    exit $ExitCode
}

function Get-VersionNumber {
    param([Parameter(Mandatory)][string]$Value)
    if ($Value -notmatch '(\d+)\.(\d+)(?:\.(\d+))?') {
        throw "Could not read version from '$Value'."
    }
    $patch = if ($Matches[3]) { $Matches[3] } else { "0" }
    return [Version]::new([int]$Matches[1], [int]$Matches[2], [int]$patch)
}

function Require-CommandVersion {
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter(Mandatory)][string]$VersionArgument,
        [Parameter(Mandatory)][Version]$Minimum,
        [Parameter(Mandatory)][string]$InstallHelp
    )
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        Stop-Bootstrap -Message "$Command is required. $InstallHelp" -ExitCode 2
    }
    $versionOutput = & $Command $VersionArgument 2>$null
    if ($LASTEXITCODE -ne 0) {
        Stop-Bootstrap -Message "Could not run '$Command $VersionArgument'. $InstallHelp" -ExitCode 2
    }
    try {
        $actual = Get-VersionNumber ([string]$versionOutput)
    }
    catch {
        Stop-Bootstrap -Message "Could not parse the $Command version '$versionOutput'. $InstallHelp" -ExitCode 2
    }
    if ($actual -lt $Minimum) {
        Stop-Bootstrap -Message "$Command $Minimum or newer is required; found $actual. $InstallHelp" -ExitCode 2
    }
    Write-Host "Using $Command $actual."
}

function Find-Python312 {
    $pyCommand = Get-Command "py" -CommandType Application -ErrorAction SilentlyContinue
    if ($pyCommand) {
        # Inventory first. The modern Python Install Manager may provision a
        # runtime on its first launch, while its inventory command is read-only.
        $pyInventory = & $pyCommand.Source -0p 2>$null
        $pyInventoryExitCode = $LASTEXITCODE
        if ($pyInventoryExitCode -eq 0 -and ($pyInventory | Out-String) -match '(?<!\d)3\.12(?:\D|$)') {
            $version = & $pyCommand.Source -3.12 -c "import sys; print('.'.join(map(str, sys.version_info[:3]))); raise SystemExit(0 if sys.implementation.name == 'cpython' and sys.version_info[:2] == (3, 12) else 1)" 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Host "Using Python $version."
                return [pscustomobject]@{ Command = $pyCommand.Source; Prefix = @("-3.12") }
            }
        }
    }

    $candidates = @("python3.12", "python", "python3")
    foreach ($candidate in $candidates) {
        $resolved = Get-Command $candidate -CommandType Application -ErrorAction SilentlyContinue
        if (-not $resolved) { continue }
        if ([string]$resolved.Source -match '[\\/]WindowsApps[\\/]') { continue }
        $version = & $resolved.Source -c "import sys; print('.'.join(map(str, sys.version_info[:3]))); raise SystemExit(0 if sys.implementation.name == 'cpython' and sys.version_info[:2] == (3, 12) else 1)" 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Using Python $version."
            return [pscustomobject]@{ Command = $resolved.Source; Prefix = @() }
        }
    }
    Stop-Bootstrap -Message "Official CPython 3.12.x is required; other Python series are not supported. This script never downloads or installs Python. Use the signed Python 3.12.10 installer from https://www.python.org/downloads/release/python-31210/, then open a new terminal and rerun this command." -ExitCode 2
}

foreach ($requiredFile in @($constraints, $pyproject, $pnpmLock, (Join-Path $repoRoot "package.json"))) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        Stop-Bootstrap -Message "The source checkout is incomplete: '$requiredFile' is missing." -ExitCode 1
    }
}

Require-CommandVersion -Command "node" -VersionArgument "--version" -Minimum ([Version]"22.0.0") -InstallHelp "Install Node.js 22+ from https://nodejs.org/en/download/."
Require-CommandVersion -Command "pnpm" -VersionArgument "--version" -Minimum ([Version]"10.0.0") -InstallHelp "Install pnpm 10+ using the official instructions at https://pnpm.io/installation."
$python = Find-Python312

Push-Location $repoRoot
try {
    if ((Test-Path -LiteralPath $venvRoot) -and -not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
        Stop-Bootstrap -Message "'$venvRoot' exists but is not a usable Windows virtual environment. Move or remove only that directory, then rerun the bootstrap." -ExitCode 4
    }

    if (Test-Path -LiteralPath $venvPython -PathType Leaf) {
        $venvVersion = & $venvPython -c "import sys; print('.'.join(map(str, sys.version_info[:3]))); raise SystemExit(0 if sys.implementation.name == 'cpython' and sys.version_info[:2] == (3, 12) else 1)" 2>$null
        if ($LASTEXITCODE -ne 0) {
            Stop-Bootstrap -Message "The existing backend\.venv uses unsupported Python '$venvVersion' or is broken. Move or remove only '$venvRoot', then rerun the bootstrap with Python 3.12.x." -ExitCode 4
        }
        Write-Host "Reusing backend\.venv with Python $venvVersion."
    }

    if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
        Write-Host "Creating the project-local Python environment..."
        & $python.Command @($python.Prefix) -m venv $venvRoot
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
            Stop-Bootstrap -Message "Python could not create backend\.venv. Confirm that the official Python installation includes venv and that the checkout is writable." -ExitCode 3
        }
    }

    Write-Host "Installing the pinned local transcription engine..."
    & $venvPython -m pip install --disable-pip-version-check --no-input --constraint $constraints -e $backendRoot
    if ($LASTEXITCODE -ne 0) {
        Stop-Bootstrap -Message "The local transcription engine dependencies could not be installed. Check the preceding pip error, network access, and free disk space, then rerun; the project virtual environment can be reused safely." -ExitCode 3
    }
    & $venvPython -m pip check
    if ($LASTEXITCODE -ne 0) {
        Stop-Bootstrap -Message "The Python environment has incompatible dependencies. Review the pip check output; if needed, move or remove only '$venvRoot' and rerun." -ExitCode 4
    }
    & $venvPython -I -B -c "from importlib.metadata import version; from pathlib import Path; import sys; expected=dict(line.split('==', 1) for raw in Path(sys.argv[1]).read_text(encoding='utf-8').splitlines() if (line := raw.strip()) and not line.startswith('#')); actual={name:version(name) for name in expected}; mismatches={name:(expected[name],actual[name]) for name in expected if actual[name] != expected[name]}; print('Pinned Python dependencies verified.' if not mismatches else f'Pinned dependency mismatch: {mismatches}'); raise SystemExit(1 if mismatches else 0)" $constraints
    if ($LASTEXITCODE -ne 0) {
        Stop-Bootstrap -Message "The installed direct dependency versions do not match backend\constraints.txt." -ExitCode 4
    }
    & $venvPython -I -B -c "import ctranslate2, faster_whisper, huggingface_hub, sentencepiece, sherpa_onnx, meeting_transcriber"
    if ($LASTEXITCODE -ne 0) {
        Stop-Bootstrap -Message "The local engine import check failed. No model was loaded or downloaded." -ExitCode 4
    }

    Write-Host "Installing desktop dependencies..."
    & pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) {
        Stop-Bootstrap -Message "Desktop dependencies could not be installed from pnpm-lock.yaml. Check the preceding pnpm error, network access, and free disk space, then rerun." -ExitCode 3
    }
    & pnpm run check
    if ($LASTEXITCODE -ne 0) {
        Stop-Bootstrap -Message "Desktop source checks failed. Fix the reported source error before starting the app." -ExitCode 4
    }

    Write-Host "Meeting Transcriber is ready. Run 'pnpm start' from $repoRoot."
    if ($Start) {
        & pnpm start
        if ($LASTEXITCODE -ne 0) {
            Stop-Bootstrap -Message "The app exited with status $LASTEXITCODE." -ExitCode 5
        }
    }
}
finally {
    Pop-Location
}
