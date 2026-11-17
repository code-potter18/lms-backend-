const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

const envPath = path.resolve(__dirname, "..", ".env.test.local");
if (!fs.existsSync(envPath)) {
  throw new Error("Missing .env.test.local. Run scripts/setup-local-test-db.ps1 first.");
}

const testConfig = dotenv.parse(fs.readFileSync(envPath));
const databaseUrl = new URL(testConfig.DATABASE_URL || "");
const databaseName = databaseUrl.pathname.replace(/^\/+/, "");

if (
  !["127.0.0.1", "localhost", "::1"].includes(databaseUrl.hostname) ||
  databaseUrl.port !== "55432" ||
  databaseName !== "hms_new_lab_walkin_test"
) {
  throw new Error("Refusing to start: DATABASE_URL is not the isolated local walk-in test database.");
}
if (!testConfig.JWT_SECRET || testConfig.JWT_SECRET.length < 32) {
  throw new Error("The isolated test environment must contain a test-only JWT_SECRET.");
}

process.env.DATABASE_URL = testConfig.DATABASE_URL;
process.env.JWT_SECRET = testConfig.JWT_SECRET;
process.env.PORT = "5011";
process.env.BCRYPT_SALT_ROUNDS = testConfig.BCRYPT_SALT_ROUNDS || "4";
process.env.NODE_ENV = "test";

console.log(`Test database: postgresql://${databaseUrl.hostname}:${databaseUrl.port}/${databaseName}`);
console.log("Test API: http://127.0.0.1:5011/api");

require("ts-node/register");
require("../src/server.ts");
