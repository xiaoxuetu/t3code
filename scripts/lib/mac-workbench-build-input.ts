export const DEFAULT_WORKBENCH_VERSION = "0.1.0-workbench.4";

const PREVIEW_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-workbench\.(?:0|[1-9]\d*)$/u;

export function parseWorkbenchPreviewVersion(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = PREVIEW_VERSION.exec(value);
  return match?.[0] === value ? value : null;
}

export function resolveBuiltWorkbenchDmg({
  version,
  filenames,
  checksumText,
}: {
  readonly version: unknown;
  readonly filenames: readonly string[];
  readonly checksumText: string;
}): { fileName: string; sha256: string } | null {
  const parsedVersion = parseWorkbenchPreviewVersion(version);
  if (parsedVersion === null || !Array.isArray(filenames) || typeof checksumText !== "string")
    return null;
  if (filenames.some((name) => typeof name !== "string" || /[/\\\r\n\0]/u.test(name))) return null;
  const fileName = `T3-Pstack-Workbench-${parsedVersion}-arm64.dmg`;
  const zipName = `T3-Pstack-Workbench-${parsedVersion}-arm64.zip`;
  const dmgs = filenames.filter((name) => name.toLowerCase().endsWith(".dmg"));
  if (
    dmgs.length !== 1 ||
    dmgs[0] !== fileName ||
    filenames.filter((name) => name === zipName).length !== 1
  )
    return null;
  const lines = (checksumText.endsWith("\n") ? checksumText.slice(0, -1) : checksumText).split(
    "\n",
  );
  if (lines.length !== 2) return null;
  const sums = new Map<string, string>();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(line);
    if (match === null || match[0] !== line) return null;
    const [, digest, name] = match;
    if (
      digest === undefined ||
      name === undefined ||
      (name !== fileName && name !== zipName) ||
      sums.has(name)
    )
      return null;
    sums.set(name, digest);
  }
  const sha256 = sums.get(fileName);
  return sha256 === undefined || !sums.has(zipName) ? null : { fileName, sha256 };
}
