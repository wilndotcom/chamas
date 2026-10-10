require("./config/env");
const mysql = require("mysql2/promise");
(async () => {
  const c = await mysql.createConnection({ host: process.env.DB_HOST||"127.0.0.1", user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  await c.query("UPDATE settings SET setting_value = '' WHERE setting_key IN " +
    "('airtel_api_key','airtel_api_password','airtel_api_username','airtel_merchant_id','airtel_service_provider_id')");
  await c.query("UPDATE settings SET setting_value = 'sandbox' WHERE setting_key = 'airtel_environment'");
  const [r] = await c.query("SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE 'airtel%' OR setting_key = 'mpesa_shortcode' ORDER BY setting_key");
  r.forEach(x => console.log("  " + x.setting_key.padEnd(28) + "'" + x.setting_value + "'"));
  require("./utils/mpesaConfig").invalidate();
  await c.end();
})();
