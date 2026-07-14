import { authenticate } from "../shopify.server";

/**
 * customers/data_request — merchant/customer asks what personal data we hold.
 * This app only stores Shopify session data (shop + staff auth), not store
 * customer/order PII, so there is nothing customer-scoped to return.
 */
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`, {
    dataRequestId: payload?.data_request?.id,
    customerId: payload?.customer?.id,
  });

  return new Response();
};
