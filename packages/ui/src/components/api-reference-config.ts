import type { ComponentProps } from "react";
import type SwaggerUI from "swagger-ui-react";

type SwaggerUIProps = ComponentProps<typeof SwaggerUI>;

/**
 * Locked-down Swagger UI configuration (openapi-reference, design decision 6).
 *
 * The widget only ever receives the stored spec as data (`spec`). It is configured with no `url`,
 * `urls` or `configUrl`, and with `queryConfigEnabled: false`, so nothing in the address bar
 * (`?url=`, `?configUrl=`) can make it load a document or a configuration. "Try it out" is off,
 * and the request interceptor rejects every request, so a relative or external `$ref` cannot
 * cause a fetch (of our own pages or APIs, with the viewer's cookies, or of anything else).
 *
 * Pure module: no React, no widget import, so tests can assert the exact options.
 */

/** Message of the error every intercepted request is rejected with. */
export const REQUEST_BLOCKED_MESSAGE = "API reference: requests are disabled.";

/** Aborts every request the widget tries to make. Returning a rejected promise cancels it. */
export function blockAllRequests(request?: unknown): Promise<never> {
  void request;
  return Promise.reject(new Error(REQUEST_BLOCKED_MESSAGE));
}

export type ApiReferenceOptions = Omit<SwaggerUIProps, "spec">;

export const API_REFERENCE_OPTIONS: Readonly<ApiReferenceOptions> = Object.freeze({
  supportedSubmitMethods: Object.freeze([]) as unknown as [],
  tryItOutEnabled: false,
  queryConfigEnabled: false,
  deepLinking: true,
  docExpansion: "list",
  defaultModelsExpandDepth: 1,
  persistAuthorization: false,
  requestInterceptor: blockAllRequests,
});

/** The props for the widget: the stored spec plus the fixed options. Nothing else is accepted. */
export function apiReferenceProps(spec: object): SwaggerUIProps {
  return { ...API_REFERENCE_OPTIONS, spec };
}
