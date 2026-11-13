import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/** Compatibility interface only. Workbench never reads or migrates another profile. */
export class DesktopLegacyLocalStorage extends Context.Service<
  DesktopLegacyLocalStorage,
  {
    readonly load: (userDataPath: string) => Effect.Effect<void>;
    readonly take: Effect.Effect<Option.Option<Readonly<Record<string, string>>>>;
    readonly complete: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopLegacyLocalStorage") {}

// No filesystem, profile discovery, Chromium access, migration marker, or mutable state.
const make = Effect.succeed(DesktopLegacyLocalStorage.of({
  load: Effect.fn("desktop.legacyLocalStorage.load")((_userDataPath: string) => Effect.void),
  take: Effect.succeed(Option.none<Readonly<Record<string, string>>>()),
  complete: Effect.void,
}));

export const layer = Layer.effect(DesktopLegacyLocalStorage, make);
