import Imap from 'imap';
import { simpleParser } from 'mailparser';
import config from './config.js';

const imapConfig = {
  user: config.imap.user,
  password: config.imap.password,
  host: config.imap.host,
  port: config.imap.port,
  tls: config.imap.tls,
};

const targetEmail = 'skates.ocarina_0n@icloud.com'; // <- именно этот адрес ищем в поле "To:"

function getCodeFromText(text) {
  const match = text.match(/\b\d{4,8}\b/); // ищем код: 4–8 цифр
  return match ? match[0] : null;
}

function searchLatestCode() {
  const imap = new Imap(imapConfig);

  imap.once('ready', () => {
    imap.openBox('INBOX', false, () => {
      imap.search([ 'UNSEEN', ['SINCE', new Date()] ], (err, results) => {
        if (err || !results || results.length === 0) {
          console.log('❌ Новых писем нет.');
          imap.end();
          return;
        }

        const f = imap.fetch(results.slice(-10), { bodies: '' });

        f.on('message', (msg) => {
          msg.on('body', async (stream) => {
            const parsed = await simpleParser(stream);

            const to = parsed.to?.text || '';
            const subject = parsed.subject || '';
            const text = parsed.text || '';

            if (to.includes(targetEmail)) {
              const code = getCodeFromText(text);
              if (code) {
                console.log(`✅ Код найден: ${code}`);
              } else {
                console.log('⚠️ Письмо пришло, но код не найден.');
              }
            } else {
              console.log(`⏩ Пропускаем письмо, адресовано не тому (${to})`);
            }
          });
        });

        f.once('end', () => imap.end());
      });
    });
  });

  imap.once('error', (err) => {
    console.error('❌ Ошибка подключения к iCloud:', err);
  });

  imap.connect();
}

searchLatestCode();
