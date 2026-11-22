import * as API from "@distilled.cloud/core/api";
import type { API_ERRORS, ConfigError, InvalidInput } from "@distilled.cloud/core/errors";
import { makeRestProtocol, unknownErrorProps } from "@distilled.cloud/core/protocol-rest";
import type { SdkError } from "@distilled.cloud/core/sdk-error";
/**
 * UniFi protocols -- hand-written.
 *
 * Every UniFi API speaks API-key-authenticated JSON REST (no response
 * envelope), so each protocol is one `makeRestProtocol` call from
 * `core/protocol-rest`:
 *
 *   request:  the key -> `X-API-KEY: <apiKey>`, and for the console-hosted apps
 *             the console -> base URL, both resolved from the calling fiber
 *             on every request. Paths in the specs start at `/v1`; the base
 *             URL carries everything before it.
 *
 *   response: 2xx JSON is the payload; non-2xx `{ message? }` bodies map to
 *             the shared HTTP-status classes, then {@link UnknownUniFiError}.
 *             A console answers `{ code, message, statusCode, statusName,
 *             requestId, requestPath, timestamp }`; `api.ui.com` answers
 *             `{ code, message, httpStatusCode, traceId }`. Both carry
 *             `message`, which the default envelope reads.
 *
 * The console-hosted apps (Network, Protect, InnerSpace) share a protocol
 * shape that differs only in the `/proxy/<app>/integration` segment of the
 * base URL. Their operations take an optional `console` member that is not
 * sent: it replaces the {@link Console} layer for that call. The cloud-only
 * APIs share {@link UniFiCloudProtocol}.
 */
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import {
  ApiKey,
  CloudBaseUrl,
  Console,
  consoleBaseUrl,
  type CloudConfig,
  type ConsoleApp,
  type ConsoleConfig,
  type ConsoleLocation,
} from "./credentials.ts";
import { UnknownUniFiError, UniFiParseError } from "./errors.ts";

/**
 * Error channel shared by every generated UniFi operation. Generated service
 * files annotate operations with `API.OperationMethod<I, O, UniFiOpError,
 * <context>>` explicitly so the compiler never infers these back out of the
 * schema generics.
 */
export type UniFiOpError =
  | InstanceType<(typeof API_ERRORS)[number]>
  | UnknownUniFiError
  | ConfigError
  | HttpClientError.HttpClientError
  | UniFiParseError
  | InvalidInput
  | SdkError;

/**
 * Context of every Network, Protect and InnerSpace operation. {@link Console}
 * is required by the type; a call whose `console` member is set never reads
 * it.
 */
export type UniFiConsoleOpContext = ApiKey | Console | HttpClient.HttpClient;

/** Context of every Site Manager, Mobility and Carrier Fabric operation. */
export type UniFiCloudOpContext = ApiKey | HttpClient.HttpClient;

/** The input member that picks the console for one call (see scripts/generate.ts). */
const CONSOLE_MEMBER = "console";

/** The call's own console and the input without it, or `undefined` when it has none. */
const splitConsole = (
  input: unknown,
): { readonly location: ConsoleLocation; readonly input: unknown } | undefined => {
  if (input === null || typeof input !== "object") return undefined;
  const { [CONSOLE_MEMBER]: location, ...rest } = input as Record<string, unknown>;
  return location === undefined
    ? undefined
    : { location: location as ConsoleLocation, input: rest };
};

const headers = (creds: { readonly apiKey: Redacted.Redacted<string> }) => ({
  "X-API-KEY": Redacted.value(creds.apiKey),
  Accept: "application/json",
});

const consoleProtocol = (app: ConsoleApp): Layer.Layer<API.Protocol> => {
  const rest = makeRestProtocol<ConsoleConfig>({
    // Each service holds an effect -- resolving them here (per request, on the
    // calling fiber) picks up context-provided layers.
    credentials: Effect.gen(function* () {
      const apiKey = yield* yield* ApiKey;
      const location = yield* yield* Console;
      const cloudBaseUrl = yield* CloudBaseUrl;
      return { apiKey, location, cloudBaseUrl };
    }),
    baseUrl: (creds) => consoleBaseUrl(creds.location, app, creds.cloudBaseUrl),
    headers,
    unknownError: (info) => new UnknownUniFiError(unknownErrorProps(info)),
    parseError: ({ body, cause }) => new UniFiParseError({ body, cause }),
  });
  // The call's `console` member, when set, is the Console for that call.
  return Layer.effect(
    API.Protocol,
    Effect.map(API.Protocol, (inner) => {
      const call = inner.call;
      const stream = inner.stream;
      return API.Protocol.of({
        encode: (args) => {
          const own = splitConsole(args.input);
          return own === undefined
            ? inner.encode(args)
            : Effect.provideService(
                inner.encode({ ...args, input: own.input }),
                Console,
                Effect.succeed(own.location),
              );
        },
        decode: inner.decode,
        ...(call === undefined
          ? {}
          : {
              call: (op, input) => {
                const own = splitConsole(input);
                return own === undefined
                  ? call(op, input)
                  : Effect.provideService(
                      call(op, own.input),
                      Console,
                      Effect.succeed(own.location),
                    );
              },
            }),
        ...(stream === undefined
          ? {}
          : {
              stream: (op, input) => {
                const own = splitConsole(input);
                return own === undefined
                  ? stream(op, input)
                  : Stream.provideService(
                      stream(op, own.input),
                      Console,
                      Effect.succeed(own.location),
                    );
              },
            }),
      });
    }),
  ).pipe(Layer.provide(rest));
};

export const UniFiNetworkProtocol: Layer.Layer<API.Protocol> =
  /*@__PURE__*/ consoleProtocol("network");

export const UniFiProtectProtocol: Layer.Layer<API.Protocol> =
  /*@__PURE__*/ consoleProtocol("protect");

export const UniFiInnerSpaceProtocol: Layer.Layer<API.Protocol> =
  /*@__PURE__*/ consoleProtocol("innerspace");

export const UniFiCloudProtocol: Layer.Layer<API.Protocol> =
  /*@__PURE__*/ makeRestProtocol<CloudConfig>({
    credentials: /*@__PURE__*/ Effect.gen(function* () {
      const apiKey = yield* yield* ApiKey;
      const cloudBaseUrl = yield* CloudBaseUrl;
      return { apiKey, cloudBaseUrl };
    }),
    baseUrl: (creds) => creds.cloudBaseUrl.replace(/\/+$/, ""),
    headers,
    unknownError: (info) => new UnknownUniFiError(unknownErrorProps(info)),
    parseError: ({ body, cause }) => new UniFiParseError({ body, cause }),
  });
