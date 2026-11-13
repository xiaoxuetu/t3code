import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { derive, deriveProviderThread } from "./IdAllocator.ts";

const input = {
  driver: ProviderDriverKind.make("acp-test"),
  nativeThreadId: "mock-session-1",
};

describe("provider thread identity scopes", () => {
  it.each([
    {
      input,
      expected: "provider-thread:provider:acp-test:native-thread:mock-session-1",
    },
    {
      input: { ...input, providerInstanceId: ProviderInstanceId.make("acp-local") },
      expected:
        "provider-thread:provider:acp-test:provider-instance:acp-local:native-thread:mock-session-1",
    },
    {
      input: {
        driver: ProviderDriverKind.make("acp-test"),
        providerInstanceId: ProviderInstanceId.make("acp-local"),
        nativeThreadId: "session:one/%",
      },
      expected:
        "provider-thread:provider:acp-test:provider-instance:acp-local:native-thread:session%3Aone%2F%25",
    },
  ])("preserves the exact unscoped identity $expected", ({ input, expected }) => {
    assert.equal(derive.providerThread(input), expected);
    assert.equal(deriveProviderThread(input), expected);
  });

  it("derives a stable scoped identity through both public entry points", () => {
    const scoped = {
      ...input,
      providerInstanceId: ProviderInstanceId.make("acp-local"),
      identityScope: "incarnation-a",
    };
    const expected =
      "provider-thread:provider:acp-test:provider-instance:acp-local:identity-scope-v3:incarnation-a:native-thread:mock-session-1";
    assert.equal(derive.providerThread(scoped), expected);
    assert.equal(derive.providerThread({ ...scoped }), expected);
    assert.equal(deriveProviderThread(scoped), expected);
  });

  it("separates reused native identities across incarnations and legacy identities", () => {
    const first = { ...input, identityScope: "incarnation-a" };
    const second = { ...input, identityScope: "incarnation-b" };
    assert.equal(
      new Set([
        derive.providerThread(input),
        derive.providerThread(first),
        derive.providerThread(second),
      ]).size,
      3,
    );
  });

  it("encodes scope delimiters, percent signs and Unicode without merging distinct inputs", () => {
    const scoped = {
      driver: ProviderDriverKind.make("acp-test"),
      providerInstanceId: ProviderInstanceId.make("acp-local"),
      identityScope: "scope:%/雪",
      nativeThreadId: "s:identity-scope-v1:%/雪",
    };
    assert.equal(
      derive.providerThread(scoped),
      "provider-thread:provider:acp-test:provider-instance:acp-local:identity-scope-v3:scope%3A%25%2F%E9%9B%AA:native-thread:s%3Aidentity-scope-v1%3A%25%2F%E9%9B%AA",
    );
    assert.notEqual(
      derive.providerThread({ ...input, identityScope: "a:b" }),
      derive.providerThread({ ...input, identityScope: "a%3Ab" }),
    );
  });
});

describe("outer provider item identity scopes", () => {
  const cases = [
    {
      name: "turn",
      make: (nativeId: string, identityScope?: string) =>
        derive.providerTurn({
          driver: input.driver,
          nativeTurnId: nativeId,
          ...(identityScope === undefined ? {} : { identityScope }),
        }),
      golden: "provider-turn:provider:acp-test:native-turn:item",
    },
    {
      name: "node",
      make: (nativeId: string, identityScope?: string) =>
        derive.nodeFromProviderItem({
          driver: input.driver,
          nativeItemId: nativeId,
          ...(identityScope === undefined ? {} : { identityScope }),
        }),
      golden: "node:provider:acp-test:native-item:item",
    },
    {
      name: "message",
      make: (nativeId: string, identityScope?: string) =>
        derive.messageFromProviderItem({
          driver: input.driver,
          nativeItemId: nativeId,
          ...(identityScope === undefined ? {} : { identityScope }),
        }),
      golden: "message:provider:acp-test:native-item:item",
    },
    {
      name: "turn item",
      make: (nativeId: string, identityScope?: string) =>
        derive.turnItemFromProviderItem({
          driver: input.driver,
          nativeItemId: nativeId,
          ...(identityScope === undefined ? {} : { identityScope }),
        }),
      golden: "turn-item:provider:acp-test:native-item:item",
    },
  ];
  it.each(cases)(
    "preserves the legacy $name and prevents raw IDs from impersonating a scope",
    ({ make, golden }) => {
      assert.equal(make("item"), golden);
      const scoped = make("provider-instance:local:item", "scope:one");
      assert.equal(scoped, make("provider-instance:local:item", "scope:one"));
      assert.notEqual(scoped, make("provider-instance:local:item", "scope:two"));
      for (const spoof of [
        "provider-instance:local:identity-scope-v3:scope%3Aone:item",
        "identity-scope-v3:scope:one:native-item:provider-instance:local:item",
        scoped,
      ])
        assert.notEqual(scoped, make(spoof));
    },
  );
  it("separates native children whose raw session and task IDs overlap", () => {
    const child = {
      ...input,
      nativeThreadId: "mock-session-1:task:tool-call-1",
      providerInstanceId: ProviderInstanceId.make("acp-local"),
    };
    assert.notEqual(
      derive.subagentThread({ ...child, identityScope: "a" }),
      derive.subagentThread({ ...child, identityScope: "b" }),
    );
    assert.equal(
      derive.subagentThread({ ...child, identityScope: "a" }),
      derive.subagentThread({ ...child, identityScope: "a" }),
    );
    assert.equal(
      derive.threadFromProviderThread(child),
      "thread:provider:acp-test:provider-instance:acp-local:native-thread:mock-session-1%3Atask%3Atool-call-1",
    );
  });
});
