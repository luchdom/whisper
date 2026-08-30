"""Describe Python distributions observed in PyInstaller analysis records.

This build helper deliberately distinguishes distributions whose files were
traced into the frozen application from tools that only participate in the
build. It does not claim that the source environment is a reproducible lock:
transitive dependency versions remain platform-resolved by pip.
"""

from __future__ import annotations

import argparse
import ast
from importlib import metadata
import json
import os
from pathlib import Path
import re
from typing import Any, Iterable


BUILD_ENVIRONMENT_TOOLS = {
    "altgraph",
    "pefile",
    "pip",
    "pyinstaller",
    "pyinstaller-hooks-contrib",
    "pywin32-ctypes",
    "setuptools",
}


def canonicalize_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def iter_strings(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.keys():
            yield from iter_strings(item)
        for item in value.values():
            yield from iter_strings(item)
    elif isinstance(value, (list, tuple, set)):
        for item in value:
            yield from iter_strings(item)


def read_observed_sources(toc_paths: list[Path]) -> set[str]:
    observed: set[str] = set()
    for toc_path in toc_paths:
        parsed = ast.literal_eval(toc_path.read_text(encoding="utf-8"))
        for value in iter_strings(parsed):
            if os.path.isabs(value):
                observed.add(os.path.normcase(os.path.abspath(value)))
    return observed


def describe_distribution(
    distribution: metadata.Distribution,
    observed_sources: set[str],
    project_distributions: set[str],
) -> dict[str, Any]:
    name = distribution.metadata.get("Name")
    if not name:
        raise ValueError("An installed distribution has no Name metadata.")
    canonical_name = canonicalize_name(name)
    observed_files: list[str] = []
    for relative_file in distribution.files or ():
        located_file = distribution.locate_file(relative_file)
        normalized_file = os.path.normcase(os.path.abspath(located_file))
        if normalized_file in observed_sources:
            observed_files.append(str(relative_file).replace("\\", "/"))

    # Editable installs can point PyInstaller at the project source tree while
    # their wheel RECORD points at the environment. The project distribution is
    # known to be packaged because it is the entry point passed to PyInstaller.
    project_entry_point = canonical_name in project_distributions
    return {
        "name": name,
        "canonicalName": canonical_name,
        "version": distribution.version,
        "sourceKind": "local-project" if project_entry_point else "pypi",
        "observedFileCount": len(observed_files),
        "evidence": (
            "pyinstaller-entry-point"
            if project_entry_point and not observed_files
            else "pyinstaller-analysis"
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--toc", action="append", required=True, type=Path)
    parser.add_argument("--project-distribution", action="append", default=[])
    args = parser.parse_args()

    observed_sources = read_observed_sources(args.toc)
    project_distributions = {
        canonicalize_name(name) for name in args.project_distribution
    }
    runtime_packages: list[dict[str, Any]] = []
    build_environment_tools: list[dict[str, Any]] = []
    installed_but_not_observed: list[dict[str, str]] = []

    distributions = sorted(
        metadata.distributions(),
        key=lambda distribution: canonicalize_name(
            distribution.metadata.get("Name") or ""
        ),
    )
    for distribution in distributions:
        described = describe_distribution(
            distribution,
            observed_sources,
            project_distributions,
        )
        package_identity = {
            "name": described["name"],
            "canonicalName": described["canonicalName"],
            "version": described["version"],
        }
        if described["canonicalName"] in BUILD_ENVIRONMENT_TOOLS:
            build_environment_tools.append(
                {
                    **package_identity,
                    "observedRuntimeSupportFiles": described["observedFileCount"],
                }
            )
        elif described["observedFileCount"] > 0 or described["canonicalName"] in project_distributions:
            runtime_packages.append(described)
        else:
            installed_but_not_observed.append(package_identity)

    print(
        json.dumps(
            {
                "runtimePackages": runtime_packages,
                "buildEnvironmentTools": build_environment_tools,
                "installedButNotObserved": installed_but_not_observed,
            },
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
