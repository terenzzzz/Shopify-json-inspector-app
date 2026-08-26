import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

/**
 * App Store apps must start install from Shopify-owned surfaces (Admin / App Store).
 * Do not collect a shop domain from merchants here.
 *
 * If Shopify redirects here with ?shop=..., login() continues the OAuth handshake.
 */
export const loader = async ({ request }) => {
  const errors = loginErrorMessage(await login(request));
  return { errors };
};

export default function Auth() {
  return (
    <AppProvider embedded={false}>
      <s-page>
        <s-section heading="Install from Shopify">
          <s-paragraph>
            JSON Inspector can only be installed and opened from the Shopify App
            Store or Shopify Admin. Entering a shop domain manually is not
            supported.
          </s-paragraph>
          <s-paragraph>
            Open your store admin, go to Apps, and install or launch JSON
            Inspector from there.
          </s-paragraph>
        </s-section>
      </s-page>
    </AppProvider>
  );
}
