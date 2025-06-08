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

// Получить коллекцию почт
async function emails() {
  return (await connect()).collection('emails');
}

// Получить коллекцию пользователей
async function users() {
  return (await connect()).collection('users');
}

// Получить все почты
async function readEmailsPool() {
  const emailsList = await (await emails()).find().toArray();
  return { emails: emailsList.map(e => e.email) };
}

// Добавить почты
async function writeEmailsPool(data) {
  const emailsCollection = await emails();
  await emailsCollection.deleteMany({});
  await emailsCollection.insertMany(data.emails.map(email => ({ email })));
}

// Получить данные пользователя
async function readDB() {
  const usersCollection = await users();
  const usersList = await usersCollection.find().toArray();
  
  const result = { users: {} };
  usersList.forEach(user => {
    result.users[user.user_id] = user;
  });
  
  return result;
}

// Обновить данные пользователя
async function writeDB(data) {
  const usersCollection = await users();
  
  for (const [userId, userData] of Object.entries(data.users)) {
    await usersCollection.updateOne(
      { user_id: Number(userId) },
      { $set: userData },
      { upsert: true }
    );
  }
}

export { 
  connect, 
  emails, 
  users, 
  readEmailsPool, 
  writeEmailsPool,
  readDB,
  writeDB
};