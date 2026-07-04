/**
 * REST client to the merchant's UCP checkout endpoints. Sets the mandatory
 * Idempotency-Key + UCP-Agent headers and returns the merchant Checkout (which
 * is authoritative for totals).
 *
 * TODO(#8): implement create/get/update/complete/cancel against the merchant REST API
 * (sample merchant: POST/GET/PUT /checkout-sessions[/:id], POST /:id/{complete,cancel}).
 */
export class MerchantClient {
  constructor(private readonly baseUrl: string) {}

  get base(): string {
    return this.baseUrl;
  }
}
