import type { ElectronApplication, Page } from "playwright-core";
import { expect, it, vi } from "vite-plus/test";
import {
  renameFixtureThread,
  SIMPLE_FIXTURE_MESSAGE,
  SIMPLE_FIXTURE_TITLE,
  verifyFixtureWindow,
} from "./desktop-fixture-ui.ts";

function fixture(failure?: string, unexpectedCount = 0) {
  const calls: string[] = [];
  const step = (name: string) => {
    calls.push(name);
    if (name === failure) throw new Error(`Synthetic ${name} failure`);
  };
  const waitFor = (name: string) => vi.fn(async (_options: unknown) => step(name));
  const row = {
    focus: vi.fn(async (_options: unknown) => step("focus")),
    press: vi.fn(async (_key: string, _options: unknown) => step("F2")),
  };
  const oldTitle = { text: SIMPLE_FIXTURE_TITLE };
  const oldThread = {
    waitFor: vi.fn(async (options: { state: string }) =>
      step(options.state === "detached" ? "old-title-gone" : "old-title-visible"),
    ),
    locator: vi.fn((_selector: string) => row),
  };
  const sidebar = { filter: vi.fn((_options: unknown) => oldThread) };
  const thread = {
    waitFor: waitFor("fixture-title"),
    click: vi.fn(async (_options: unknown) => step("open-thread")),
  };
  const message = { waitFor: waitFor("fixture-message") };
  const unexpected = {
    count: vi.fn(async () => {
      step("unexpected-title");
      return unexpectedCount;
    }),
  };
  const newThread = { waitFor: waitFor("new-title-visible") };
  const header = { waitFor: waitFor("new-header-visible") };
  const input = {
    fill: vi.fn(async (_value: string, _options: unknown) => step("fill-title")),
    press: vi.fn(async (_key: string, _options: unknown) => step("commit-title")),
  };
  const page = {
    locator: vi.fn((selector: string, options?: { hasText: string }) => {
      if (selector !== "li[data-thread-item]") throw new Error("Unexpected selector");
      if (options === undefined) return sidebar;
      if (options.hasText === SIMPLE_FIXTURE_TITLE) return thread;
      if (options.hasText === "Other app fixture") return unexpected;
      return newThread;
    }),
    getByText: vi.fn((text: string, options?: { exact: boolean }) => {
      if (options?.exact === true && text === SIMPLE_FIXTURE_TITLE) return oldTitle;
      if (text === SIMPLE_FIXTURE_MESSAGE) return message;
      throw new Error("Unexpected fixture text");
    }),
    getByRole: vi.fn((role: string, _options: unknown) => (role === "textbox" ? input : header)),
  };
  const app = {
    firstWindow: vi.fn(async (_options: unknown) => {
      step("first-window");
      return page;
    }),
  };
  return {
    app: app as unknown as ElectronApplication,
    page: page as unknown as Page,
    mocks: {
      app,
      page,
      thread,
      message,
      unexpected,
      sidebar,
      oldThread,
      oldTitle,
      row,
      input,
      newThread,
      header,
    },
    calls,
  };
}

it("requires a visible fixture thread and its visible message after the first window", async () => {
  const { app, page, mocks, calls } = fixture();
  expect(
    await verifyFixtureWindow(app, {
      title: SIMPLE_FIXTURE_TITLE,
      message: SIMPLE_FIXTURE_MESSAGE,
      unexpectedTitle: "Other app fixture",
    }),
  ).toBe(page);
  expect(calls).toEqual([
    "first-window",
    "fixture-title",
    "open-thread",
    "fixture-message",
    "unexpected-title",
  ]);
  expect(mocks.app.firstWindow).toHaveBeenCalledWith({ timeout: 60_000 });
  expect(mocks.thread.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 60_000 });
  expect(mocks.thread.click).toHaveBeenCalledWith({ timeout: 60_000 });
  expect(mocks.message.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 60_000 });
});

it.each(["first-window", "fixture-title", "open-thread", "fixture-message"])(
  "rejects an incomplete GUI check at %s",
  async (failure) => {
    const { app, calls } = fixture(failure);
    await expect(
      verifyFixtureWindow(app, {
        title: SIMPLE_FIXTURE_TITLE,
        message: SIMPLE_FIXTURE_MESSAGE,
      }),
    ).rejects.toThrow(`Synthetic ${failure} failure`);
    expect(calls.at(-1)).toBe(failure);
  },
);

it("rejects a window that also displays the other app's unique fixture title", async () => {
  const { app } = fixture(undefined, 1);
  await expect(
    verifyFixtureWindow(app, {
      title: SIMPLE_FIXTURE_TITLE,
      message: SIMPLE_FIXTURE_MESSAGE,
      unexpectedTitle: "Other app fixture",
    }),
  ).rejects.toThrow("Another app's fixture title is visible");
});

it("renames through F2 and the page-level input, then requires both new labels and removal of the exact old title", async () => {
  const { page, mocks, calls } = fixture();
  const newTitle = `${SIMPLE_FIXTURE_TITLE} renamed`;
  await renameFixtureThread(page, SIMPLE_FIXTURE_TITLE, newTitle);
  expect(calls).toEqual([
    "old-title-visible",
    "focus",
    "F2",
    "fill-title",
    "commit-title",
    "new-title-visible",
    "new-header-visible",
    "old-title-gone",
  ]);
  expect(mocks.page.getByText).toHaveBeenCalledWith(SIMPLE_FIXTURE_TITLE, { exact: true });
  expect(mocks.sidebar.filter).toHaveBeenCalledWith({ has: mocks.oldTitle });
  expect(mocks.oldThread.locator).toHaveBeenCalledWith("[data-sidebar-row]");
  expect(mocks.row.focus).toHaveBeenCalledWith({ timeout: 60_000 });
  expect(mocks.row.press).toHaveBeenCalledWith("F2", { timeout: 60_000 });
  expect(mocks.page.getByRole).toHaveBeenCalledWith("textbox", {
    name: "Thread title",
    exact: true,
  });
  expect(mocks.input.fill).toHaveBeenCalledWith(newTitle, { timeout: 60_000 });
  expect(mocks.input.press).toHaveBeenCalledWith("Enter", { timeout: 60_000 });
  expect(mocks.newThread.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 60_000 });
  expect(mocks.page.getByRole).toHaveBeenCalledWith("button", {
    name: `Thread actions for ${newTitle}`,
    exact: true,
  });
  expect(mocks.header.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 60_000 });
  expect(mocks.oldThread.waitFor).toHaveBeenLastCalledWith({ state: "detached", timeout: 60_000 });
});

it.each(["F2", "commit-title", "new-title-visible", "new-header-visible", "old-title-gone"])(
  "does not accept a rename that fails at %s",
  async (failure) => {
    const { page, calls } = fixture(failure);
    await expect(
      renameFixtureThread(page, SIMPLE_FIXTURE_TITLE, "Workbench unique fixture"),
    ).rejects.toThrow(`Synthetic ${failure} failure`);
    expect(calls.at(-1)).toBe(failure);
  },
);
