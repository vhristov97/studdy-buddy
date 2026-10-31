import os from "node:os";

// Mozaik's cloud SDK uploads agent events (incl. study materials) when it finds a key or paired
// credentials. Tests must never do that, even when the real `.env` opts in with
// `MOZAIK_CLOUD_ENABLED=true`. Empty strings count as "no key" and, being already set, are not
// overridden by `process.loadEnvFile` or the SDK's own `.env` fallback
// (`process.env[name] ?? <.env>[name]`).
process.env.MOZAIK_API_KEY = "";
process.env.MOZAIK_PROJECT_KEY = "";
process.env.MOZAIK_CREDENTIALS_FILE = os.devNull;
