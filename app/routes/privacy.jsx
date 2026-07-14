/**
 * Public privacy policy draft for App Store listing.
 * URL to set in Partner Dashboard → App listing → Resources → Privacy policy URL:
 *   https://json-inspector-app.terenzzzz.cn/privacy
 *
 * Review with legal counsel before App Store submission; contact details are placeholders.
 */
export const meta = () => [
  { title: "Privacy Policy — JSON Inspector" },
  {
    name: "description",
    content:
      "Privacy policy for the JSON Inspector Shopify app: what data we process and how we handle requests.",
  },
];

export default function PrivacyPolicy() {
  const lastUpdated = "July 14, 2026";
  const appName = "JSON Inspector";
  const contactEmail = "privacy@terenzzzz.cn";

  return (
    <main
      style={{
        maxWidth: "44rem",
        margin: "0 auto",
        padding: "2.5rem 1.25rem 4rem",
        fontFamily:
          "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        lineHeight: 1.6,
        color: "#1a1a1a",
      }}
    >
      <p style={{ margin: 0, fontSize: "0.875rem", color: "#666" }}>
        Draft — replace contact details and have counsel review before submission.
      </p>
      <h1 style={{ marginTop: "0.75rem", fontSize: "1.75rem" }}>
        Privacy Policy
      </h1>
      <p style={{ color: "#555" }}>
        <strong>{appName}</strong> (“we”, “our”, or “the App”) is a Shopify
        application that helps merchants inspect theme template JSON and resolve
        original image sources. Last updated: {lastUpdated}.
      </p>

      <h2 style={{ fontSize: "1.15rem", marginTop: "2rem" }}>
        1. Scope
      </h2>
      <p>
        This policy describes how the App processes data when a merchant
        installs and uses it on a Shopify store. It applies to merchants and
        store staff who authorize the App, not to end customers of those
        stores, except where Shopify sends us mandatory privacy webhooks about
        customer data requests.
      </p>

      <h2 style={{ fontSize: "1.15rem", marginTop: "2rem" }}>
        2. Data we collect and process
      </h2>
      <ul>
        <li>
          <strong>Shop identifiers</strong> — shop domain and related IDs needed
          to authenticate Admin API calls.
        </li>
        <li>
          <strong>OAuth / session data</strong> — access tokens and associated
          staff account fields returned by Shopify during install (for example
          name, email, account ownership flags), used only to keep the App
          signed in and authorized.
        </li>
        <li>
          <strong>Theme and file metadata</strong> — content accessed through the
          granted scopes <code>read_themes</code> and <code>read_files</code>,
          processed to analyze templates and resolve image URLs. We do not use
          this data for advertising or resale.
        </li>
      </ul>
      <p>
        The App does <strong>not</strong> request customer, order, or checkout
        scopes, and does not intentionally store storefront customer personal
        information.
      </p>

      <h2 style={{ fontSize: "1.15rem", marginTop: "2rem" }}>
        3. How we use data
      </h2>
      <ul>
        <li>Authenticate merchants and maintain App sessions</li>
        <li>Call Admin APIs the merchant authorized to perform JSON inspection
          and original-image resolution</li>
        <li>Respond to Shopify mandatory compliance webhooks</li>
        <li>Operate, secure, and troubleshoot the App</li>
      </ul>

      <h2 style={{ fontSize: "1.15rem", marginTop: "2rem" }}>
        4. Sharing
      </h2>
      <p>
        We do not sell personal data. Data may be processed by hosting or
        infrastructure providers solely to run the App, and disclosed if
        required by law or to protect the App and merchants from fraud or abuse.
      </p>

      <h2 style={{ fontSize: "1.15rem", marginTop: "2rem" }}>
        5. Retention and deletion
      </h2>
      <p>
        Session and shop data are retained while the App remains installed.
        When a merchant uninstalls the App, we delete related session records.
        Shopify may also send a <code>shop/redact</code> webhook (typically 48
        hours after uninstall); we erase remaining shop data for that store when
        received. Customer data request (<code>customers/data_request</code>) and
        redaction (<code>customers/redact</code>) webhooks are acknowledged; if
        we hold no customer records, no further export or deletion is required.
      </p>

      <h2 style={{ fontSize: "1.15rem", marginTop: "2rem" }}>
        6. Security
      </h2>
      <p>
        Access tokens and requests are protected using Shopify’s authentication
        model, HTTPS, and webhook HMAC verification. No method of transmission
        or storage is 100% secure; merchants should uninstall the App if they no
        longer need it.
      </p>

      <h2 style={{ fontSize: "1.15rem", marginTop: "2rem" }}>
        7. Your rights and contact
      </h2>
      <p>
        Merchants can uninstall the App at any time from Shopify Admin. For
        privacy questions, data requests, or to update this policy’s contact
        details, email{" "}
        <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.
      </p>

      <h2 style={{ fontSize: "1.15rem", marginTop: "2rem" }}>
        8. Changes
      </h2>
      <p>
        We may update this policy as the App’s features or legal requirements
        change. The “Last updated” date at the top will be revised when we do.
      </p>

      <p style={{ marginTop: "2.5rem", fontSize: "0.875rem", color: "#666" }}>
        This page is a working draft for Shopify App Store distribution
        preparation and is not legal advice.
      </p>
    </main>
  );
}
