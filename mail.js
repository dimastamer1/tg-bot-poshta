import Imap from 'imap';
import { simpleParser } from 'mailparser';
import config from './config.js';

const imapConfigBase = {
  user: config.imap.user,
  password: config.imap.password,
  host: config.imap.host,
  port: config.imap.port,
  tls: config.imap.tls,
};

function getCodeFromText(text) {
  const match = text.match(/\b\d{4,8}\b/); // код: 4-8 цифр
  return match ? match[0] : null;
}

export function getLatestCode(targetEmail) {
  return new Promise((resolve, reject) => {
    const imap = new Imap(imapConfigBase);

    imap.once('ready', () => {
      imap.openBox('INBOX', false, () => {
        imap.search(['UNSEEN', ['SINCE', new Date()]], (err, results) => {
          if (err) {
            imap.end();
            return reject(err);
          }
          if (!results || results.length === 0) {
            imap.end();
            return resolve(null);
          }

          const f = imap.fetch(results.slice(-10), { bodies: '' });
          let codeFound = null;

          f.on('message', (msg) => {
            msg.on('body', async (stream) => {
              try {
                const parsed = await simpleParser(stream);
                const to = parsed.to?.text || '';
                const text = parsed.text || '';

                if (to.includes(targetEmail)) {
                  const code = getCodeFromText(text);
                  if (code) codeFound = code;
                }
              } catch (e) {
                // ignore parse errors
              }
            });
          });

          f.once('end', () => {
            imap.end();
            resolve(codeFound);
          });
        });
      });
    });

    imap.once('error', (err) => reject(err));

    imap.connect();
  });
}
