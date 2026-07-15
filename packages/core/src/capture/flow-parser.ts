import type { CapturedCall } from '../types.ts';
import type { ProxyCaptureEvent } from './proxy.ts';
import { stableId } from '../utils.ts';

export function proxyEventToCapturedCall(event: ProxyCaptureEvent, sessionId: string): CapturedCall {
  const url = event.url;
  let host = event.host;
  let path = event.path;
  let queryString = event.queryString;

  if (url.startsWith('http')) {
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      path = parsed.pathname;
      queryString = parsed.search;
    } catch {
    }
  }

  return {
    id: stableId('call'),
    sessionId,
    method: event.method,
    url,
    host,
    path,
    queryString,
    requestHeaders: event.requestHeaders,
    requestBody: event.requestBody,
    responseStatus: event.responseStatus,
    responseHeaders: event.responseHeaders,
    responseBody: event.responseBody,
    contentType: event.contentType,
    durationMs: event.durationMs,
    timestamp: event.timestamp
  };
}
