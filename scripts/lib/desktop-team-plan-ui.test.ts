import { expect, it } from "vite-plus/test";
import { isDesktopTeamPlanMetadataButton } from "./desktop-team-plan-ui.ts";

it("refuses execution controls and names outside the exact metadata allowlist", () => {
  expect(isDesktopTeamPlanMetadataButton("Save goal")).toBe(true);
  for (const name of [
    "Prepare team",
    "Continue team",
    "Send",
    "Run",
    "Start",
    "Record review",
    "Confirm plan and continue",
    "Save goal ",
    "",
  ]) {
    expect(isDesktopTeamPlanMetadataButton(name), name).toBe(false);
  }
});
