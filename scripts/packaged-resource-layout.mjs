export function packagedResourceRelativePaths({
  platform,
  arch,
  productName,
  executableName
}) {
  requireSafePathSegment(productName, "product name");
  requireSafePathSegment(executableName, "sidecar executable name");

  let resourceRoot;
  if (platform === "win32" && arch === "x64") {
    resourceRoot = "win-unpacked/resources";
  } else if (platform === "darwin" && arch === "arm64") {
    resourceRoot = `mac-arm64/${productName}.app/Contents/Resources`;
  } else if (platform === "darwin" && arch === "x64") {
    resourceRoot = `mac/${productName}.app/Contents/Resources`;
  } else {
    throw new Error(`Packaged verification does not support ${platform}-${arch}.`);
  }

  return Object.freeze({
    resourceRoot,
    sidecar: `${resourceRoot}/sidecar/${executableName}`,
    sbom: `${resourceRoot}/SBOM.cdx.json`
  });
}

function requireSafePathSegment(value, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || value.includes("\0")
  ) {
    throw new Error(`The ${label} is not a safe path segment.`);
  }
}
