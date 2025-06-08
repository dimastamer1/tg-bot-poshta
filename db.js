// db.js
import { MongoClient } from 'mongodb';
import { config } from 'dotenv';
config();

const client = new MongoClient(process.env.MONGODB_URI);
let db;

// Подключение к базе
async function connect() {
  if (!db) {
    try {
      await client.connect();
      db = client.db(process.env.DB_NAME);
      console.log('✅ Подключено к MongoDB');
      
      // Создаем индексы при первом подключении
      await db.collection('emails').createIndex({ email: 1 }, { unique: true });
      await db.collection('users').createIndex({ user_id: 1 }, { unique: true });
    } catch (e) {
      console.error('❌ Ошибка подключения к MongoDB:', e);
      throw e;
    }
  }
  return db;
}

// Функции для работы с коллекциями
async function emails() {
  return (await connect()).collection('emails');
}

async function users() {
  return (await connect()).collection('users');
}

// Чтение пула почт
async function readEmailsPool() {
  const emailsList = await (await emails()).find().toArray();
  return { emails: emailsList.map(e => e.email) };
}

// Запись в пул почт
async function writeEmailsPool(data) {
  const emailsCollection = await emails();
  await emailsCollection.deleteMany({});
  await emailsCollection.insertMany(data.emails.map(email => ({ email })));
}

export { connect, emails, users, readEmailsPool, writeEmailsPool };