import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * shop/redact — 48h after uninstall, erase all shop data from our database.
 */
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  await db.session.deleteMany({ where: { shop } });

  return new Response();
};
