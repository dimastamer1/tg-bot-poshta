import 'dotenv/config';

export default {
  telegramToken: process.env.TELEGRAM_TOKEN,
  cryptoBotToken: process.env.CRYPTO_BOT_TOKEN,
  adminId: Number(process.env.ADMIN_ID),
  imap: {
    user: process.env.IMAP_USER,
    password: process.env.IMAP_PASSWORD,
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT),
    tls: process.env.IMAP_TLS === 'true'
  }
};