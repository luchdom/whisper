[CmdletBinding()]
param(
    [switch]$PlanOnly,

    [ValidatePattern('^\d{8}T\d{6}Z-[a-f0-9]{8}$')]
    [string]$CleanupRunId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [IO.Path]::GetFullPath((Join-Path $scriptRoot '..'))
$planPath = Join-Path $repoRoot 'desktop\test\integration\overlay-capture\acceptance-plan.json'
$fixturePath = Join-Path $repoRoot 'desktop\test\integration\overlay-capture\fixture-main.cjs'
$evidenceBase = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) 'meeting-transcriber-overlay-acceptance'))

function Get-OptionalProperty {
    param(
        [Parameter(Mandatory = $true)] [object]$InputObject,
        [Parameter(Mandatory = $true)] [string]$Name
    )

    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Assert-Plan {
    param([Parameter(Mandatory = $true)] [object]$Plan)

    if ($Plan.schemaVersion -ne 1) { throw 'Unsupported overlay acceptance plan schema.' }
    if ($Plan.fixtureVersion -ne 'synthetic-overlay-pair-v1') { throw 'Unexpected overlay fixture version.' }
    if ($null -eq $Plan.steps -or $Plan.steps.Count -lt 1) { throw 'The overlay acceptance plan has no steps.' }

    $seen = @{}
    $expectedByType = @{
        'visual-pair' = @('baseline-only', 'both-visible')
        'binary' = @('pass')
        'cleanup' = @('confirmed')
    }
    foreach ($step in $Plan.steps) {
        if ($step.id -notmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') { throw 'An overlay acceptance step has an invalid ID.' }
        if ($seen.ContainsKey($step.id)) { throw 'The overlay acceptance plan contains a duplicate step ID.' }
        $seen[$step.id] = $true
        if (-not $expectedByType.ContainsKey($step.responseType)) { throw "Step $($step.id) has an invalid response type." }
        if ($expectedByType[$step.responseType] -notcontains $step.expected) { throw "Step $($step.id) has an invalid expected result." }
        if ($step.required -ne $true) { throw "Step $($step.id) must explicitly remain required." }
        if ([string]::IsNullOrWhiteSpace($step.instruction) -or $step.instruction.Length -gt 600) {
            throw "Step $($step.id) has an invalid instruction."
        }
        $action = Get-OptionalProperty -InputObject $step -Name 'action'
        if ($null -ne $action -and $action -ne 'stop-fixture') { throw "Step $($step.id) has an invalid action." }
    }
}

function Remove-EvidenceRun {
    param([Parameter(Mandatory = $true)] [string]$RunId)

    $candidate = [IO.Path]::GetFullPath((Join-Path $evidenceBase $RunId))
    $candidateParent = [IO.Directory]::GetParent($candidate).FullName
    if (-not [string]::Equals($candidateParent, $evidenceBase, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to clean an evidence path outside the dedicated OS-temp directory.'
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
        throw "No temporary evidence exists for run $RunId."
    }

    Remove-Item -LiteralPath $candidate -Recurse -Force
    Write-Host "Removed temporary overlay acceptance evidence for run $RunId."
}

function Read-ClosedChoice {
    param(
        [Parameter(Mandatory = $true)] [string]$Prompt,
        [Parameter(Mandatory = $true)] [string[]]$Allowed
    )

    while ($true) {
        $answer = (Read-Host "$Prompt [$($Allowed -join '/')]").Trim().ToLowerInvariant()
        if ($Allowed -contains $answer) { return $answer }
        Write-Host 'Use one of the listed content-free outcomes. Free-text notes are intentionally disabled.' -ForegroundColor Yellow
    }
}

function Get-AllowedResponses {
    param([Parameter(Mandatory = $true)] [string]$ResponseType)

    switch ($ResponseType) {
        'visual-pair' { return @('baseline-only', 'both-visible', 'neither-visible', 'unexpected', 'not-run') }
        'binary' { return @('pass', 'fail', 'not-run') }
        'cleanup' { return @('confirmed', 'not-confirmed') }
        default { throw 'Unsupported response type.' }
    }
}

function Get-Evaluation {
    param(
        [Parameter(Mandatory = $true)] [string]$Response,
        [Parameter(Mandatory = $true)] [string]$Expected
    )

    if ($Response -eq $Expected) { return 'pass' }
    if ($Response -eq 'not-run') { return 'incomplete' }
    return 'fail'
}

function Stop-FixtureProcess {
    param([Diagnostics.Process]$Process)

    if ($null -eq $Process) { return }
    $Process.Refresh()
    if (-not $Process.HasExited) {
        Stop-Process -Id $Process.Id -Force
        $Process.WaitForExit(5000) | Out-Null
    }
}

function Write-Manifest {
    param(
        [Parameter(Mandatory = $true)] [System.Collections.IDictionary]$Manifest,
        [Parameter(Mandatory = $true)] [string]$Path
    )

    $json = $Manifest | ConvertTo-Json -Depth 8
    Set-Content -LiteralPath $Path -Value $json -Encoding UTF8
}

if ($PlanOnly -and -not [string]::IsNullOrWhiteSpace($CleanupRunId)) {
    throw 'Use either -PlanOnly or -CleanupRunId, not both.'
}

if (-not [string]::IsNullOrWhiteSpace($CleanupRunId)) {
    Remove-EvidenceRun -RunId $CleanupRunId
    exit 0
}

if (-not (Test-Path -LiteralPath $planPath -PathType Leaf)) { throw "Acceptance plan not found: $planPath" }
$plan = Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json
Assert-Plan -Plan $plan

if ($PlanOnly) {
    $plan.steps | Select-Object id, category, required, expected | Format-Table -AutoSize
    Write-Host 'Plan validated. No fixture was launched and no evidence was written.'
    exit 0
}

if ($env:OS -ne 'Windows_NT') {
    throw 'This interactive harness is Windows-only. Use docs/OVERLAY_CAPTURE_ACCEPTANCE.md for the separate macOS protocol and ScreenCaptureKit limitation.'
}

$electronPath = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronPath -PathType Leaf)) {
    throw 'Electron is not installed locally. Run the repository bootstrap before this acceptance harness.'
}
if (-not (Test-Path -LiteralPath $fixturePath -PathType Leaf)) { throw "Fixture not found: $fixturePath" }

$runId = '{0}-{1}' -f [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'), ([Guid]::NewGuid().ToString('N').Substring(0, 8))
$canary = 'MT-{0}' -f ([Guid]::NewGuid().ToString('N').Substring(0, 8).ToUpperInvariant())
$runDirectory = [IO.Path]::GetFullPath((Join-Path $evidenceBase $runId))
$runParent = [IO.Directory]::GetParent($runDirectory).FullName
if (-not [string]::Equals($runParent, $evidenceBase, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to write evidence outside the dedicated OS-temp directory.'
}
New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
$manifestPath = Join-Path $runDirectory 'manifest.json'

$manifest = [ordered]@{
    schemaVersion = 1
    fixtureVersion = $plan.fixtureVersion
    runId = $runId
    platform = 'windows'
    osVersion = [Environment]::OSVersion.Version.ToString()
    powershellVersion = $PSVersionTable.PSVersion.ToString()
    startedAt = [DateTime]::UtcNow.ToString('o')
    completedAt = $null
    status = 'running'
    observations = @()
}
Write-Manifest -Manifest $manifest -Path $manifestPath

$fixtureProcess = $null
$exitCode = 1
$summary = 'The harness failed before completing the matrix.'

try {
    Write-Host ''
    Write-Host 'Synthetic overlay capture acceptance' -ForegroundColor Cyan
    Write-Host "Run: $runId"
    Write-Host 'The fixture contains synthetic visuals only. Do not introduce meeting, participant, account, or transcript data.'
    Write-Host 'The blue BASELINE window is intentionally capturable. The magenta PRIVATE window requests Windows content protection.'
    Write-Host 'This is an observed-path test, not a promise that the overlay is undetectable.' -ForegroundColor Yellow
    Write-Host ''

    $quotedFixturePath = '"' + $fixturePath.Replace('"', '\"') + '"'
    $fixtureProcess = Start-Process -FilePath $electronPath -ArgumentList @(
        $quotedFixturePath,
        "--canary=$canary",
        "--run-id=$runId"
    ) -PassThru
    Start-Sleep -Milliseconds 1800
    $fixtureProcess.Refresh()
    if ($fixtureProcess.HasExited) { throw 'The synthetic Electron fixture exited before acceptance began.' }

    foreach ($step in $plan.steps) {
        Write-Host ''
        Write-Host "[$($step.id)]" -ForegroundColor Cyan
        Write-Host $step.instruction

        $action = Get-OptionalProperty -InputObject $step -Name 'action'
        if ($action -eq 'stop-fixture') {
            Read-Host 'Press Enter when the capture preview is ready for forced fixture termination' | Out-Null
            $fixtureProcess.Refresh()
            if ($fixtureProcess.HasExited) { throw 'The fixture exited before the controlled forced-exit step.' }
            Stop-FixtureProcess -Process $fixtureProcess
            Start-Sleep -Milliseconds 500
        } elseif ($step.category -ne 'privacy') {
            $fixtureProcess.Refresh()
            if ($fixtureProcess.HasExited) { throw "The fixture exited before step $($step.id)." }
        }

        if ($step.responseType -eq 'visual-pair') {
            Write-Host 'baseline-only = blue visible, magenta absent; both-visible = both visible; neither-visible = invalid baseline.'
        }
        $allowed = Get-AllowedResponses -ResponseType $step.responseType
        $response = Read-ClosedChoice -Prompt 'Observed outcome' -Allowed $allowed
        $evaluation = Get-Evaluation -Response $response -Expected $step.expected

        $manifest.observations += [ordered]@{
            stepId = $step.id
            category = $step.category
            required = $true
            expected = $step.expected
            observed = $response
            evaluation = $evaluation
            observedAt = [DateTime]::UtcNow.ToString('o')
        }
        Write-Manifest -Manifest $manifest -Path $manifestPath
    }

    $failed = @($manifest.observations | Where-Object { $_.required -and $_.evaluation -eq 'fail' }).Count
    $incomplete = @($manifest.observations | Where-Object { $_.required -and $_.evaluation -eq 'incomplete' }).Count
    $requiredCount = @($plan.steps | Where-Object { $_.required }).Count
    $observedRequiredCount = @($manifest.observations | Where-Object { $_.required }).Count

    if ($failed -gt 0) {
        $manifest.status = 'failed'
        $exitCode = 1
        $summary = "$failed required observation(s) failed."
    } elseif ($incomplete -gt 0 -or $observedRequiredCount -ne $requiredCount) {
        $manifest.status = 'incomplete'
        $exitCode = 2
        $summary = 'At least one required observation was not run; no pass is claimed.'
    } else {
        $manifest.status = 'passed'
        $exitCode = 0
        $summary = 'Every required Windows observation was explicitly recorded as passing.'
    }
} catch {
    $manifest.status = 'failed'
    $manifest.failureCode = 'harness_error'
    $summary = $_.Exception.Message
    $exitCode = 1
} finally {
    Stop-FixtureProcess -Process $fixtureProcess
    $manifest.completedAt = [DateTime]::UtcNow.ToString('o')
    Write-Manifest -Manifest $manifest -Path $manifestPath
}

Write-Host ''
Write-Host "Status: $($manifest.status)" -ForegroundColor $(if ($manifest.status -eq 'passed') { 'Green' } else { 'Yellow' })
Write-Host $summary
Write-Host "Content-free manifest: $manifestPath"
Write-Host "Delete it after review with: .\scripts\verify-overlay-capture.ps1 -CleanupRunId $runId"
Write-Host 'Do not commit screenshots, recordings, manifests, or capture evidence, and do not attach them to Linear.'
exit $exitCode
