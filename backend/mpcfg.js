require("./config/env");
const { getMpesaConfig } = require("./utils/mpesaConfig");
const mysql = require("mysql2/promise");

const mask = (v) => {
  if (!v) return "(empty)";
  const s = String(v);
  if (s.length <= 4) return "*".repeat(s.length);
  return s.slice(0, 3) + "*".repeat(Math.max(0, s.length - 5)) + s.slice(-2) + "  (len " + s.length + ")";
};

(async () => {
  const c = await mysql.createConnection({ host: process.env.DB_HOST||"127.0.0.1", user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  const [rows] = await c.query(
    "SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE 'mpesa_%' ORDER BY setting_key"
  );
  const db = {};
  rows.forEach(r => { db[r.setting_key] = r.setting_value; });
  await c.end();

  const envKeys = Object.keys(process.env).filter(k => k.startsWith("MPESA_"));

  console.log("=== values in the settings table (masked) ===");
  ["mpesa_consumer_key","mpesa_consumer_secret","mpesa_passkey","mpesa_shortcode","mpesa_paybill","mpesa_callback_url"]
    .forEach(k => console.log("  " + k.padEnd(22) + mask(db[k])));

  console.log("\n=== environment variables present (names only) ===");
  console.log("  " + (envKeys.length ? envKeys.join(", ") : "(none)"));

  const cfg = await getMpesaConfig();
  console.log("\n=== what the app actually resolves to (source of truth) ===");
  console.log("  consumerKey    " + mask(cfg.consumerKey));
  console.log("  consumerSecret " + mask(cfg.consumerSecret));
  console.log("  passkey        " + mask(cfg.passkey));
  console.log("  shortcode      " + mask(cfg.shortcode));
  console.log("  callbackUrl    " + (cfg.callbackUrl || "(empty)"));
  console.log("  baseUrl        " + require("./utils/mpesaConfig").baseUrl(cfg));
  console.log("  isConfigured   " + require("./utils/mpesaConfig").isConfigured(cfg));
})();
