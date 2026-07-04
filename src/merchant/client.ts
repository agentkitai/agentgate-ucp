/**
 * REST client to the merchant's UCP checkout endpoints. Sets the mandatory
 * Idempotency-Key + UCP-Agent headers and returns the merchant Checkout (which
 * is authoritative for totals).
 *
 * The sample merchant (ucp-samples/rest/nodejs) exposes:
 *   POST   /checkout-sessions              → create   (201, body = create request)
 *   GET    /checkout-sessions/:id          → get      (200)
 *   PUT    /checkout-sessions/:id          → update   (200, body = update request)
 *   POST   /checkout-sessions/:id/complete → complete (200, body = payment data)
 *   POST   /checkout-sessions/:id/cancel   → cancel   (200, empty body)
 *
 * Every route returns the checkout JSON directly and reads the `Idempotency-Key`
 * and `UCP-Agent` request headers. No RFC-9421 signing (local demo; the merchant
 * does not verify signatures).
 */
import type { Checkout } from '../types.js';

/** Extra headers the merchant reads off each request. */
export interface MerchantHeaders {
  /** Maps to the `UCP-Agent` request header (required by UCP on every op). */
  ucpAgent?: string | undefined;
  /** Maps to the `Idempotency-Key` request header (required for complete/cancel). */
  idempotencyKey?: string | undefined;
}

/**
 * Thrown when the merchant returns a non-2xx status. Carries the HTTP status and
 * the raw response body so the tool layer can surface a readable error to the
 * buying agent instead of crashing the MCP handler.
 */
export class MerchantError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, operation: string) {
    super(`merchant ${operation} failed (${status}): ${MerchantError.detail(body)}`);
    this.name = 'MerchantError';
    this.status = status;
    this.body = body;
  }

  private static detail(body: unknown): string {
    if (body && typeof body === 'object' && 'detail' in body) {
      return String((body as { detail: unknown }).detail);
    }
    if (typeof body === 'string') return body;
    return JSON.stringify(body);
  }
}

export class MerchantClient {
  constructor(private readonly baseUrl: string) {}

  get base(): string {
    return this.baseUrl;
  }

  /** POST /checkout-sessions — create a checkout session. */
  async createCheckout(body: unknown, headers?: MerchantHeaders): Promise<Checkout> {
    return this.request('create_checkout', 'POST', '/checkout-sessions', { body, headers });
  }

  /** GET /checkout-sessions/:id — fetch a checkout session. */
  async getCheckout(id: string, headers?: MerchantHeaders): Promise<Checkout> {
    return this.request(
      'get_checkout',
      'GET',
      `/checkout-sessions/${encodeURIComponent(id)}`,
      { headers }
    );
  }

  /** PUT /checkout-sessions/:id — update a checkout session. */
  async updateCheckout(
    id: string,
    body: unknown,
    headers?: MerchantHeaders
  ): Promise<Checkout> {
    return this.request(
      'update_checkout',
      'PUT',
      `/checkout-sessions/${encodeURIComponent(id)}`,
      { body, headers }
    );
  }

  /** POST /checkout-sessions/:id/complete — place the order (body = payment data). */
  async completeCheckout(
    id: string,
    body: unknown,
    headers?: MerchantHeaders
  ): Promise<Checkout> {
    return this.request(
      'complete_checkout',
      'POST',
      `/checkout-sessions/${encodeURIComponent(id)}/complete`,
      { body, headers }
    );
  }

  /** POST /checkout-sessions/:id/cancel — cancel a checkout session. */
  async cancelCheckout(id: string, headers?: MerchantHeaders): Promise<Checkout> {
    // The sample merchant ignores the cancel body but still parses JSON, so send {}.
    return this.request(
      'cancel_checkout',
      'POST',
      `/checkout-sessions/${encodeURIComponent(id)}/cancel`,
      { body: {}, headers }
    );
  }

  private async request(
    operation: string,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    opts: { body?: unknown; headers?: MerchantHeaders }
  ): Promise<Checkout> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (opts.headers?.ucpAgent) headers['UCP-Agent'] = opts.headers.ucpAgent;
    if (opts.headers?.idempotencyKey) {
      headers['Idempotency-Key'] = opts.headers.idempotencyKey;
    }

    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

    const res = await fetch(url, init);
    const raw = await res.text();
    let parsed: unknown = undefined;
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }

    if (!res.ok) {
      throw new MerchantError(res.status, parsed, operation);
    }
    return parsed as Checkout;
  }
}
