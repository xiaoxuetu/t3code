import { expect, it } from "vite-plus/test";
import {
  DEFAULT_WORKBENCH_VERSION,
  parseWorkbenchPreviewVersion,
  resolveBuiltWorkbenchDmg,
} from "./mac-workbench-build-input.ts";

const version = "0.1.0-workbench.4";
const dmg = `T3-Pstack-Workbench-${version}-arm64.dmg`;
const zip = `T3-Pstack-Workbench-${version}-arm64.zip`;
const dmgHash = "ab".repeat(32);
const zipHash = "cd".repeat(32);
const checksumText = `${dmgHash}  ${dmg}\n${zipHash}  ${zip}`;
const input = { version, filenames: [dmg, zip, "SHA256SUMS", "VALIDATION.json"], checksumText };

it("exposes the intended preview version", () => {
  expect(DEFAULT_WORKBENCH_VERSION).toBe(version);
});

it.each([
  "0.0.0-workbench.0",
  version,
  "10.20.30-workbench.42",
  `${"1".repeat(48)}.1.1-workbench.1`,
])("accepts a strict preview version %j", (value) =>
  expect(parseWorkbenchPreviewVersion(value)).toBe(value),
);

it.each(
  [
    undefined,
    null,
    4,
    true,
    {},
    [],
    "",
    " ",
    "0.1.0",
    "v0.1.0-workbench.4",
    "0.1.0-preview.4",
    "0.1.0-workbench",
    "0.1.0-workbench.-1",
    "0.1.0-workbench.4+build",
    "01.1.0-workbench.4",
    "0.01.0-workbench.4",
    "0.1.00-workbench.4",
    "0.1.0-workbench.04",
    "0.1.0-workbench.4.1",
    "0.1.0-WORKBENCH.4",
    " 0.1.0-workbench.4",
    "0.1.0-workbench.4 ",
    "0.1.0-workbench.4\n",
    "0.1.0-workbench.4\r\n",
    "0.1.0-workbench.4\nother",
    "0.1.0-workbench.4\0",
    "0.1.0-workbench.4; touch /tmp/unwanted",
    "$(false)",
    "../../0.1.0-workbench.4",
    `${"1".repeat(49)}.1.1-workbench.1`,
  ].map((value) => ({ value })),
)("rejects non-preview or unsafe version input %j", ({ value }) => {
  expect(parseWorkbenchPreviewVersion(value)).toBeNull();
});

it.each([checksumText, `${checksumText}\n`, `${zipHash}  ${zip}\n${dmgHash}  ${dmg}\n`])(
  "resolves the exact arm64 DMG from a two-asset checksum manifest",
  (manifest) => {
    expect(resolveBuiltWorkbenchDmg({ ...input, checksumText: manifest })).toEqual({
      fileName: dmg,
      sha256: dmgHash,
    });
  },
);

it.each(
  [
    [],
    [dmg],
    [zip],
    [dmg, dmg, zip],
    [dmg, zip, zip],
    [dmg, zip, "unexpected.dmg"],
    [dmg, zip, "unexpected.DMG"],
    [dmg.replace("arm64", "x64"), zip],
    [dmg.toUpperCase(), zip],
    [dmg.replace(version, "0.1.0-workbench.3"), zip],
    [dmg, zip.replace(version, "0.1.0-workbench.3")],
    [`../${dmg}`, zip],
    [dmg, `subdir/${zip}`],
    [dmg, zip, "bad\nname"],
  ].map((filenames) => ({ filenames })),
)("rejects missing, duplicate, mismatched or unsafe asset names %j", ({ filenames }) => {
  expect(resolveBuiltWorkbenchDmg({ ...input, filenames })).toBeNull();
});

it.each([
  "",
  `${dmgHash}  ${dmg}`,
  `${checksumText}\n\n`,
  `\n${checksumText}`,
  `${checksumText}\nextra`,
  `${dmgHash}  ${dmg}\n${zipHash}  ${zip}\n${dmgHash}  extra.zip`,
  `${dmgHash}  ${dmg}\n${zipHash}  ${dmg}`,
  `${dmgHash}  ${zip}\n${zipHash}  ${zip}`,
  `${dmgHash.toUpperCase()}  ${dmg}\n${zipHash}  ${zip}`,
  `${"a".repeat(63)}  ${dmg}\n${zipHash}  ${zip}`,
  `${"a".repeat(65)}  ${dmg}\n${zipHash}  ${zip}`,
  `${"g".repeat(64)}  ${dmg}\n${zipHash}  ${zip}`,
  `${dmgHash} ${dmg}\n${zipHash}  ${zip}`,
  `${dmgHash}   ${dmg}\n${zipHash}  ${zip}`,
  `${dmgHash}\t${dmg}\n${zipHash}  ${zip}`,
  `${dmgHash} *${dmg}\n${zipHash}  ${zip}`,
  `${dmgHash}  ../${dmg}\n${zipHash}  ${zip}`,
  `${dmgHash}  subdir/${dmg}\n${zipHash}  ${zip}`,
  `${dmgHash}  C:\\${dmg}\n${zipHash}  ${zip}`,
  `${dmgHash}  ${dmg}\n${zipHash}  ../${zip}`,
  `${dmgHash}  ${dmg.replace("arm64", "x64")}\n${zipHash}  ${zip}`,
  `${dmgHash}  ${dmg.replace(version, "0.1.0-workbench.3")}\n${zipHash}  ${zip}`,
  `${dmgHash}  ${dmg}\n${zipHash}  ${zip} `,
  `${dmgHash}  ${dmg}\r\n${zipHash}  ${zip}\r\n`,
  `${dmgHash}  ${dmg}\n${zipHash}  ${zip}\0`,
])("rejects malformed or non-exact checksum manifests %j", (manifest) => {
  expect(resolveBuiltWorkbenchDmg({ ...input, checksumText: manifest })).toBeNull();
});

it("rejects an invalid version even when asset names and hashes appear consistent", () => {
  expect(resolveBuiltWorkbenchDmg({ ...input, version: `${version}\n` })).toBeNull();
});
