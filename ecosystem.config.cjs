const fs = require("fs");
const path = require("path");

function loadEnvFile(filePath) {
  const env = {};
  const fullPath = path.resolve(__dirname, filePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing ${filePath}. Copy .env.example and fill in secrets.`);
  }
  for (const line of fs.readFileSync(fullPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

module.exports = {
  apps: [
    {
      name: "json-inspector-app",
      cwd: "/var/www/Shopify-json-inspector-app",
      script: "npm",
      args: "run start",
      instances: 1,
      exec_mode: "fork",
      env: loadEnvFile(".env"),
    },
  ],
};
