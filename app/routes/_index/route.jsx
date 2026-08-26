import { redirect } from "react-router";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  // Install / open from Shopify Admin always includes shop — continue into the app.
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export default function App() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>JSON Inspector</h1>
        <p className={styles.text}>
          Inspect theme template JSON and resolve original image sources for your
          Shopify store.
        </p>
        <p className={styles.text}>
          Install and open this app from the Shopify App Store or your Shopify
          Admin. Manual shop-domain login is not supported.
        </p>
        <ul className={styles.list}>
          <li>
            <strong>Theme JSON</strong>. Load templates from your themes or paste
            JSON to inspect sections and media.
          </li>
          <li>
            <strong>Original sources</strong>. Resolve CDN filenames back to Files
            library originals.
          </li>
          <li>
            <strong>Batch download</strong>. Export selected images and videos as
            a ZIP.
          </li>
        </ul>
        <p className={styles.text}>
          <a href="/privacy">Privacy Policy</a>
        </p>
      </div>
    </div>
  );
}
