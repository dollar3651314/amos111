import { loadConfig } from './config.js';
import { createFileStore } from './store.js';
import { createSmtpSender } from './mailer.js';
import { createServer } from './server.js';

const config = loadConfig();
const missing = ['SMTP_HOST', 'MAIL_FROM', 'MAIL_TO'].filter((k) => !process.env[k]);
if (missing.length) {
  console.warn(`[lead-api] WARNING: missing ${missing.join(', ')} - leads will be stored but emails will fail`);
}

const store = createFileStore(config.dataDir);
const server = createServer({ config, store, sendMail: createSmtpSender(config) });
server.listen(config.port, config.host, () => {
  console.log(`[lead-api] listening on ${config.host}:${config.port}, data at ${store.file}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
