import { expect, it } from "vite-plus/test";
import { isDesktopTeamPlanMetadataButton } from "./desktop-team-plan-ui.ts";

it("refuses execution controls and names outside the exact metadata allowlist", () => {
  expect(isDesktopTeamPlanMetadataButton("Save goal")).toBe(true);
  expect(isDesktopTeamPlanMetadataButton("Pause new tasks")).toBe(true);
  for (const name of [
    "Prepare team",
    "Refine team",
    "Continue team",
    "Resume new tasks",
    "Resume team",
    "Pause new tasks ",
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
