export const WORKBENCH_IDENTITY = {
  name: "T3 Pstack Workbench",
  appId: "org.t3pstack.workbench",
  executableName: "t3-pstack-workbench",
  homeDirectoryName: ".t3-pstack-workbench",
  homeEnvironmentVariable: "T3_PSTACK_WORKBENCH_HOME",
  scheme: "t3-pstack-workbench",
  developmentScheme: "t3-pstack-workbench-dev",
  automaticUpdatesEnabled: false,
  desktopCliInstallationEnabled: false,
} as const;

export const WORKBENCH_UPDATE_DISABLED_REASON =
  "Automatic updates are disabled for T3 Pstack Workbench. Install a verified Workbench release manually.";

export const workbenchDesktopScheme = (development: boolean): string =>
  development ? WORKBENCH_IDENTITY.developmentScheme : WORKBENCH_IDENTITY.scheme;

export const isWorkbenchDesktopProtocol = (protocol: string): boolean =>
  protocol === `${WORKBENCH_IDENTITY.scheme}:` ||
  protocol === `${WORKBENCH_IDENTITY.developmentScheme}:`;

export const workbenchProfileDirectory = (development: boolean): string =>
  `${WORKBENCH_IDENTITY.executableName}${development ? "-dev" : ""}`;

export const workbenchDesktopEntryName = (development: boolean): string =>
  `${WORKBENCH_IDENTITY.appId}${development ? ".dev" : ""}.desktop`;

export const resolveWorkbenchDevelopmentHome = (
  explicitHome: string | undefined,
  worktreeHome: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined =>
  explicitHome?.trim() ||
  worktreeHome ||
  environment[WORKBENCH_IDENTITY.homeEnvironmentVariable]?.trim() ||
  undefined;

export function workbenchDevelopmentEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  resolvedHome: string | undefined,
): Record<string, string | undefined> {
  const output = { ...environment };
  delete output.T3CODE_HOME;
  delete output[WORKBENCH_IDENTITY.homeEnvironmentVariable];
  if (resolvedHome !== undefined) output[WORKBENCH_IDENTITY.homeEnvironmentVariable] = resolvedHome;
  return output;
}
