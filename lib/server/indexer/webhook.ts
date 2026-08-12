import { HttpError } from "../auth/http";

export const MAX_WEBHOOK_BYTES = 256 * 1024;

/** Reads a chunked webhook with a hard ceiling before allocating the full body. */
export async function readBoundedWebhookBody(
  request: Request,
  maxBytes = MAX_WEBHOOK_BYTES,
) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new HttpError(415, "CONTENT_TYPE", "Send an application/json webhook.");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, "BODY_TOO_LARGE", "Webhook body is too large.");
  }
  if (!request.body) {
    return { bytes: new Uint8Array(), text: "" };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(413, "BODY_TOO_LARGE", "Webhook body is too large.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "INVALID_WEBHOOK", "Webhook body could not be read.");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, "INVALID_WEBHOOK", "Webhook body is not valid UTF-8.");
  }
  return { bytes, text };
}
