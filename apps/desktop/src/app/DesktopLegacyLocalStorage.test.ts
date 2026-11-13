import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { DesktopLegacyLocalStorage, layer } from "./DesktopLegacyLocalStorage.ts";

it.effect("provides an empty legacy lifecycle without filesystem or desktop services", () =>
  Effect.gen(function* () {
    const legacy = yield* DesktopLegacyLocalStorage;
    for (let attempt = 0; attempt < 2; attempt++) {
      yield* legacy.load("/not-a-real-profile");
      assert.isTrue(Option.isNone(yield* legacy.take));
      yield* legacy.complete;
      assert.isTrue(Option.isNone(yield* legacy.take));
    }
  }).pipe(Effect.provide(layer)),
);
