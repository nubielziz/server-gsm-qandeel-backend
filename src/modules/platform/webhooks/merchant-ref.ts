// The part of the signed-in merchant the webhook routes need. Platform imports no other module, so it names the shape it reads
// instead of importing identity's MerchantPrincipal; that principal has these fields and is passed as it is.

/** The signed-in merchant, as the webhook use cases see it: only its id matters. */
export interface MerchantRef {
  readonly clientId: number;
}
