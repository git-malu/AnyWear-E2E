export interface ServiceJsonResponseLike {
  url(): string;
  headers(): Record<string, string>;
  json(): Promise<unknown>;
}

// A browser `Response` additionally exposes its `Request`, which the predicate
// needs to exclude document navigations. An `APIResponse` from `page.request`
// has no associated request, so it is only ever read, never matched.
export interface ServiceJsonBrowserResponseLike extends ServiceJsonResponseLike {
  request(): { resourceType(): string; method(): string };
}

export function serviceOriginOf(serviceUrl: string): string;

export function isJsonContentType(contentType: string | undefined): boolean;

export function isServiceJsonResponse(response: ServiceJsonBrowserResponseLike, serviceOrigin: string): boolean;

export function serviceResponseMatcher(
  serviceOrigin: string,
  criteria?: { method?: string; path?: string },
): (response: ServiceJsonBrowserResponseLike) => boolean;

export function readServiceJson<T = unknown>(response: ServiceJsonResponseLike): Promise<T>;
