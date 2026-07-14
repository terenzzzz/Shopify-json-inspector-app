import { authenticate } from "../shopify.server";

/**
 * customers/redact — delete customer personal data we hold for this shop.
 * JSON Inspector does not store storefront customer or order records.
 */
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`, {
    customerId: payload?.customer?.id,
    ordersToRedact: payload?.orders_to_redact,
  });

  return new Response();
};
