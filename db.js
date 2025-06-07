import mongoose from 'mongoose';

// Подключение к MongoDB (замени строку на свою!)
const MONGODB_URI = 'mongodb+srv://dima52538:LxSoTL6FGbIJx3AS@cluster0.qpdfzhi.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';

// Модель пользователя (кто покупал почты)
const userSchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true },
  emails: [String], // купленные почты
  transactions: Object, // транзакции
});

// Модель пула почт (все доступные почты)
const emailPoolSchema = new mongoose.Schema({
  emails: [String],
});

// Создаём модели
const User = mongoose.model('User', userSchema);
const EmailPool = mongoose.model('EmailPool', emailPoolSchema);

// Подключение к БД (вызываем в начале приложения)
await mongoose.connect(MONGODB_URI).catch(err => console.error('❌ MongoDB error:', err));

// 🔥 Те же функции, что и раньше, но работают с MongoDB!
export async function readDB() {
  const users = await User.find({});
  const db = { users: {} };
  users.forEach(user => {
    db.users[user.userId] = {
      emails: user.emails,
      transactions: user.transactions,
    };
  });
  return db;
}

export async function writeDB(db) {
  for (const [userId, data] of Object.entries(db.users)) {
    await User.updateOne(
      { userId: Number(userId) },
      { $set: { emails: data.emails, transactions: data.transactions } },
      { upsert: true } // если пользователя нет – создаст
    );
  }
}

// 🔥 Функции для emailsPool (если они у тебя есть)
export async function readEmailsPool() {
  const pool = await EmailPool.findOne() || { emails: [] };
  return pool;
}

export async function writeEmailsPool(pool) {
  await EmailPool.updateOne({}, { $set: { emails: pool.emails } }, { upsert: true });
}

// Вывести список всех коллекций
const collections = await mongoose.connection.db.listCollections().toArray();
console.log("Коллекции в базе:", collections.map(c => c.name));


