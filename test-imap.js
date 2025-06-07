import Imap from 'imap';
import config from './config.js';

const imap = new Imap(config.imap);

imap.once('ready', () => {
  console.log('✅ Успешно подключено к iCloud!');
  imap.end();
});

imap.once('error', (err) => {
  console.error('❌ Ошибка при подключении к iCloud:', err);
});

imap.connect();
