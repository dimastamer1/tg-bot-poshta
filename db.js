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

// Получить коллекцию почт iCloud
async function emails() {
  return (await connect()).collection('emails');
}

// Получить коллекцию почт FIRSTMAIL
async function firstmails() {
  return (await connect()).collection('firstmails');
}

// Получить коллекцию почт USA FIRSTMAIL
async function usaMails() {
    return (await connect()).collection('usa_mails');
}

// Получить коллекцию почт UKR FIRSTMAIL
async function ukrMails() {
    return (await connect()).collection('ukr_mails');
}

// Получить коллекцию пользователей
async function users() {
  return (await connect()).collection('users');
}

// Получить все почты iCloud
async function readEmailsPool() {
  const emailsList = await (await emails()).find().toArray();
  return { emails: emailsList.map(e => e.email) };
}

// Получить все почты FIRSTMAIL (email:password)
async function readFirstmailsPool() {
  const firstmailsList = await (await firstmails()).find().toArray();
  return { firstmails: firstmailsList.map(e => `${e.email}:${e.password}`) };
}

// Получить все почты USA FIRSTMAIL (email:password)
async function readUsaMailsPool() {
    const usaMailsList = await (await usaMails()).find().toArray();
    return { usa_mails: usaMailsList.map(e => `${e.email}:${e.password}`) };
}

// Получить все почты UKR FIRSTMAIL (email:password)
async function readUkrMailsPool() {
    const ukrMailsList = await (await ukrMails()).find().toArray();
    return { ukr_mails: ukrMailsList.map(e => `${e.email}:${e.password}`) };
}

// Добавить почты iCloud (перезаписывает пул)
async function writeEmailsPool(data) {
  const emailsCollection = await emails();
  await emailsCollection.deleteMany({});
  await emailsCollection.insertMany(data.emails.map(email => ({ email })));
}

// Добавить почты FIRSTMAIL (перезаписывает пул)
async function writeFirstmailsPool(data) {
  const firstmailsCollection = await firstmails();
  await firstmailsCollection.deleteMany({});
  await firstmailsCollection.insertMany(
    data.firstmails.map(str => {
      const [email, password] = str.split(':');
      return { email: email.trim(), password: (password || '').trim() };
    })
  );
}

// Добавить почты USA FIRSTMAIL (перезаписывает пул)
async function writeUsaMailsPool(data) {
    const usaMailsCollection = await usaMails();
    await usaMailsCollection.deleteMany({});
    await usaMailsCollection.insertMany(
        data.usa_mails.map(str => {
            const [email, password] = str.split(':');
            return { email: email.trim(), password: (password || '').trim() };
        })
    );
}

// Добавить почты UKR FIRSTMAIL (перезаписывает пул)
async function writeUkrMailsPool(data) {
    const ukrMailsCollection = await ukrMails();
    await ukrMailsCollection.deleteMany({});
    await ukrMailsCollection.insertMany(
        data.ukr_mails.map(str => {
            const [email, password] = str.split(':');
            return { email: email.trim(), password: (password || '').trim() };
        })
    );
}

// Получить данные пользователей
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
    firstmails,
    usaMails,
    ukrMails,
    readEmailsPool,
    writeEmailsPool,
    readFirstmailsPool,
    writeFirstmailsPool,
    readUsaMailsPool,
    writeUsaMailsPool,
    readUkrMailsPool,
    writeUkrMailsPool,
    readDB,
    writeDB
};