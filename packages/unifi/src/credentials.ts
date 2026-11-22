import { ConfigError, InvalidInput } from "@distilled.cloud/core/errors";
/**
 * UniFi credentials -- hand-written.
 *
 * A call is described by independent layers:
 *
 *   - {@link ApiKey}: who you are. Every UniFi API takes a key in `X-API-KEY`.
 *     A key created in a console's application (Settings > Control Plane >
 *     Integrations) works on that console only; a Site Manager key
 *     (unifi.ui.com/settings/api-keys) works against `api.ui.com`, including
 *     the cloud connector, which also needs console firmware >= 5.0.3.
 *   - {@link Console}: where the console is. Only the console-hosted apps
 *     (Network, Protect, InnerSpace) need it; they run on the console and are
 *     reached either directly on the local network
 *     (`https://<host>/proxy/<app>/integration`) or relayed through the cloud
 *     connector (`/v1/connector/consoles/<consoleId>/proxy/<app>/integration`).
 *     Every console-hosted operation also takes an optional `console` member,
 *     which wins over the layer for that call.
 *   - {@link CloudBaseUrl}: the UniFi cloud origin, `https://api.ui.com`
 *     unless a layer replaces it. Site Manager, Mobility, Carrier Fabric and
 *     the cloud connector all use it.
 *
 * {@link ApiKey} and {@link Console} hold an *effect* that resolves their
 * value on every request (the protocol resolves it per request on the
 * calling fiber), so a layer that is never used is never resolved.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/** Default origin of the UniFi cloud. */
export const DEFAULT_CLOUD_BASE_URL = "https://api.ui.com";

/** The console-hosted applications, as they appear in `/proxy/<app>/integration`. */
export type ConsoleApp = "network" | "protect" | "innerspace";

/** Where a console is reached. */
export type ConsoleLocation =
  /**
   * Directly on the local network: a host (`192.168.0.1`, `udm.lan:8443`) or
   * an origin (`https://192.168.0.1`). The console serves a self-signed
   * certificate; trust it in the runtime's TLS settings.
   */
  | { readonly _tag: "Local"; readonly host: string }
  /** Through the cloud connector, by the console's ID (Site Manager `listHosts`). */
  | { readonly _tag: "Remote"; readonly consoleId: string };

/** What a console-hosted call needs: the key, where the console is, and the cloud origin. */
export interface ConsoleConfig {
  readonly apiKey: Redacted.Redacted<string>;
  readonly location: ConsoleLocation;
  readonly cloudBaseUrl: string;
}

/** What a cloud-only call needs: the key and the cloud origin. */
export interface CloudConfig {
  readonly apiKey: Redacted.Redacted<string>;
  readonly cloudBaseUrl: string;
}

const invalidConsole = (message: string) => new InvalidInput({ member: "console", message });

/**
 * Base URL (everything before `/v1/...`) of one application on a console.
 * Throws {@link InvalidInput} for a location without a host or console ID;
 * the protocol surfaces it on the call's error channel.
 */
export const consoleBaseUrl = (
  location: ConsoleLocation,
  app: ConsoleApp,
  cloudBaseUrl: string,
): string => {
  if (location._tag === "Local") {
    const host = location.host.trim();
    if (host === "") throw invalidConsole("a Local console needs a host");
    const origin = host.includes("://") ? host : `https://${host}`;
    return `${origin.replace(/\/+$/, "")}/proxy/${app}/integration`;
  }
  if (location._tag !== "Remote" || location.consoleId.trim() === "") {
    throw invalidConsole('a console is { _tag: "Local", host } or { _tag: "Remote", consoleId }');
  }
  // `:` is legal in a path segment, and console IDs are `<hex>:<number>`.
  const id = encodeURIComponent(location.consoleId).replace(/%3A/gi, ":");
  return `${cloudBaseUrl.replace(/\/+$/, "")}/v1/connector/consoles/${id}/proxy/${app}/integration`;
};

/** The API key, redacted. */
export class ApiKey
  extends /*@__PURE__*/ Context.Service<
    ApiKey,
    Effect.Effect<Redacted.Redacted<string>, ConfigError>
  >()("UniFiApiKey") {}

/** Where the console is. Needed by Network, Protect and InnerSpace only. */
export class Console
  extends /*@__PURE__*/ Context.Service<Console, Effect.Effect<ConsoleLocation, ConfigError>>()(
    "UniFiConsole",
  ) {}

/** Origin of the UniFi cloud; {@link DEFAULT_CLOUD_BASE_URL} unless a layer replaces it. */
export const CloudBaseUrl = /*@__PURE__*/ Context.Reference<string>("UniFiCloudBaseUrl", {
  defaultValue: () => DEFAULT_CLOUD_BASE_URL,
});

/** Layer providing the key. */
export const apiKey = (key: Redacted.Redacted<string>): Layer.Layer<ApiKey> =>
  Layer.succeed(ApiKey, Effect.succeed(key));

/**
 * Layer for a console on the local network: a host (`192.168.0.1`) or an
 * origin (`https://192.168.0.1`). Use with a key created in the console.
 */
export const localConsole = (host: string): Layer.Layer<Console> =>
  Layer.succeed(Console, Effect.succeed({ _tag: "Local", host }));

/**
 * Layer for a console behind the cloud connector, by its ID (`id` in Site
 * Manager's `listHosts`). Use with a Site Manager key.
 */
export const remoteConsole = (consoleId: string): Layer.Layer<Console> =>
  Layer.succeed(Console, Effect.succeed({ _tag: "Remote", consoleId }));

/** Layer replacing the UniFi cloud origin (`https://api.ui.com`). */
export const cloudBaseUrl = (url: string): Layer.Layer<never> => Layer.succeed(CloudBaseUrl, url);

/** Reads `UNIFI_API_KEY`. */
export const ApiKeyFromEnv: Layer.Layer<ApiKey> = /*@__PURE__*/ Layer.succeed(
  ApiKey,
  /*@__PURE__*/ Effect.gen(function* () {
    const key = process.env.UNIFI_API_KEY;
    if (!key) {
      return yield* new ConfigError({ message: "UNIFI_API_KEY environment variable is required" });
    }
    return Redacted.make(key);
  }),
);

/** Reads where the console is: `UNIFI_CONSOLE_HOST` (local) or, failing that, `UNIFI_CONSOLE_ID` (cloud connector). */
export const ConsoleFromEnv: Layer.Layer<Console> = /*@__PURE__*/ Layer.succeed(
  Console,
  /*@__PURE__*/ Effect.gen(function* () {
    const host = process.env.UNIFI_CONSOLE_HOST;
    if (host) return { _tag: "Local", host } as const;
    const consoleId = process.env.UNIFI_CONSOLE_ID;
    if (!consoleId) {
      return yield* new ConfigError({
        message: "UNIFI_CONSOLE_HOST (local) or UNIFI_CONSOLE_ID (cloud connector) is required",
      });
    }
    return { _tag: "Remote", consoleId } as const;
  }),
);

/** Reads `UNIFI_CLOUD_API_BASE_URL`, falling back to {@link DEFAULT_CLOUD_BASE_URL}. */
export const CloudBaseUrlFromEnv: Layer.Layer<never> = /*@__PURE__*/ Layer.sync(
  CloudBaseUrl,
  () => process.env.UNIFI_CLOUD_API_BASE_URL || DEFAULT_CLOUD_BASE_URL,
);

/** All environment layers; the key and console are only resolved by the calls that need them. */
export const CredentialsFromEnv: Layer.Layer<ApiKey | Console> = /*@__PURE__*/ Layer.mergeAll(
  ApiKeyFromEnv,
  ConsoleFromEnv,
  CloudBaseUrlFromEnv,
);
