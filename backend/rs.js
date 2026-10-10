require("./config/env");
const mysql = require("mysql2/promise");
(async () => {
  const c = await mysql.createConnection({ host: process.env.DB_HOST||"127.0.0.1", user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  await c.query("UPDATE settings SET setting_value='sandbox' WHERE setting_key='mpesa_environment'");
  require("./utils/mpesaConfig").invalidate();
  const [r] = await c.query("SELECT setting_value FROM settings WHERE setting_key='mpesa_environment'");
  console.log("  mpesa_environment = " + r[0].setting_value);
  const [t] = await c.query("SELECT COUNT(*) c FROM mpesa_transactions");
  console.log("  mpesa_transactions rows = " + t[0].c);
  await c.end();
})();
