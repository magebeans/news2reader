/**
 * An error that carries the HTTP status code the server should return
 * to the client. Thrown by articleToEpub when upstream fetches fail or
 * the fetched content cannot be processed.
 */
export class UpstreamError extends Error {
  /** HTTP status code to send back to the caller */
  statusCode: number;
  /** Optional Retry-After header value from upstream */
  retryAfter?: string;

  constructor(message: string, statusCode: number, retryAfter?: string) {
    super(message);
    this.name = "UpstreamError";
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
  }
}
