import { vi } from "vitest";

type MockResponse = Response | (() => Response);

/**
 * A tiny fetch stub keyed on `METHOD url`. Each key holds a queue of
 * responses consumed in order; the last one repeats once the queue is
 * empty, so a happy-path test only needs to list a response once even if
 * the same endpoint is polled more than expected.
 */
export function createMockFetch(responses: Record<string, MockResponse[]>) {
  const queues = new Map(Object.entries(responses).map(([key, list]) => [key, [...list]]));

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${url}`;

    const queue = queues.get(key);
    if (!queue || queue.length === 0) {
      throw new Error(`No mock response queued for ${key}`);
    }
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (!next) {
      throw new Error(`No mock response queued for ${key}`);
    }
    return typeof next === "function" ? next() : next.clone();
  });
}

export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}
