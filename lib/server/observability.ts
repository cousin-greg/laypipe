function requestId(request: Request) {
  const value = request.headers.get("x-vercel-id")?.trim();
  return value && value.length <= 128 ? value : null;
}

function emit(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
) {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

type OperationalField = string | number | boolean | null;

export function emitOperationalSummary(
  event: string,
  fields: Record<string, OperationalField>,
  level: "info" | "warn" | "error" = "info",
) {
  if (!/^laypipe\.[a-z0-9.-]{1,96}$/.test(event)) {
    throw new Error("Operational event name is invalid.");
  }
  const bounded = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      typeof value === "string" ? value.slice(0, 128) : value,
    ]),
  );
  emit(level, event, bounded);
}

/**
 * Emits only failures for low-volume operational routes. Vercel already logs
 * successful request metadata; domain-specific success summaries are emitted
 * explicitly by indexer and cleanup handlers.
 */
export async function observeOperationalRequest(
  request: Request,
  route: string,
  handler: () => Promise<Response>,
) {
  const startedAt = Date.now();
  const context = { route, requestId: requestId(request) };
  try {
    const response = await handler();
    if (response.status >= 400) {
      emit(response.status >= 500 ? "error" : "warn", "laypipe.operation.completed", {
        ...context,
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
    }
    return response;
  } catch (error) {
    emit("error", "laypipe.operation.failed", {
      ...context,
      errorClass: error instanceof Error ? error.name : "UnknownError",
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}
