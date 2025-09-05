import { MongoClient } from 'mongodb';
import { config } from 'dotenv';
config();

const client = new MongoClient(process.env.MONGODB_URI);
let db;

// Подключение к базе
async function connect() {
  if (!db) {
    await client.connect();
    db = client.db(process.env.DB_NAME);
    console.log('✅ Подключено к MongoDB');
  }
  return db;
}

// ----------------- Коллекции -----------------

async function trustSpecials() {
  return (await connect()).collection('trust_specials');
}

async function tuMails() {
  return (await connect()).collection('tu_mails');
}

async function emails() {
  return (await connect()).collection('emails');
}

async function firstmails() {
  return (await connect()).collection('firstmails');
}

async function usaMails() {
  return (await connect()).collection('usa_mails');
}

async function ukrMails() {
  return (await connect()).collection('ukr_mails');
}

async function users() {
  return (await connect()).collection('users');
}

async function gmailKeys() {
  return (await connect()).collection('gmail_keys');
}

// ----------------- Чтение данных -----------------

async function readEmailsPool() {
  const list = await (await emails()).find().toArray();
  return { emails: list.map(e => e.email) };
}

async function readFirstmailsPool() {
  const list = await (await firstmails()).find().toArray();
  return { firstmails: list.map(e => `${e.email}:${e.password}`) };
}

async function readUsaMailsPool() {
  const list = await (await usaMails()).find().toArray();
  return { usa_mails: list.map(e => `${e.email}:${e.password}`) };
}

async function readUkrMailsPool() {
  const list = await (await ukrMails()).find().toArray();
  return { ukr_mails: list.map(e => `${e.email}:${e.password}`) };
}

async function readGmailKeysPool() {
  const list = await (await gmailKeys()).find().toArray();
  return { gmail_keys: list.map(e => e.raw) };
}

async function readDB() {
  const list = await (await users()).find().toArray();
  const result = { users: {} };
  list.forEach(u => result.users[u.user_id] = u);
  return result;
}

// ----------------- Запись данных -----------------

async function writeEmailsPool(data) {
  const col = await emails();
  await col.deleteMany({});
  await col.insertMany(data.emails.map(email => ({ email })));
}

async function writeFirstmailsPool(data) {
  const col = await firstmails();
  await col.deleteMany({});
  await col.insertMany(
    data.firstmails.map(str => {
      const [email, password] = str.split(':');
      return { email: email.trim(), password: (password || '').trim() };
    })
  );
}

async function writeUsaMailsPool(data) {
  const col = await usaMails();
  await col.deleteMany({});
  await col.insertMany(
    data.usa_mails.map(str => {
      const [email, password] = str.split(':');
      return { email: email.trim(), password: (password || '').trim() };
    })
  );
}

async function writeUkrMailsPool(data) {
  const col = await ukrMails();
  await col.deleteMany({});
  await col.insertMany(
    data.ukr_mails.map(str => {
      const [email, password] = str.split(':');
      return { email: email.trim(), password: (password || '').trim() };
    })
  );
}

async function writeGmailKeysPool(data) {
  const col = await gmailKeys();
  await col.deleteMany({});
  await col.insertMany(
    data.gmail_keys.map(str => {
      const [email, login, password, country, key] = str.split('|');
      return {
        email: (email || '').trim(),
        login: (login || '').trim(),
        password: (password || '').trim(),
        country: (country || '').trim(),
        key: (key || '').trim(),
        raw: str.trim()
      };
    })
  );
}

async function writeDB(data) {
  const col = await users();
  for (const [userId, userData] of Object.entries(data.users)) {
    await col.updateOne(
      { user_id: Number(userId) },
      { $set: userData },
      { upsert: true }
    );
  }
}

// ----------------- Экспорт -----------------

export {
  connect,
  trustSpecials,
  tuMails,
  emails,
  firstmails,
  usaMails,
  ukrMails,
  users,
  gmailKeys,
  readEmailsPool,
  writeEmailsPool,
  readFirstmailsPool,
  writeFirstmailsPool,
  readUsaMailsPool,
  writeUsaMailsPool,
  readUkrMailsPool,
  writeUkrMailsPool,
  readGmailKeysPool,
  writeGmailKeysPool,
  readDB,
  writeDB
};