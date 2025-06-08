import { emails, users } from './db.js';

async function init() {
  try {
    // Создаем индекс для быстрого поиска
    await (await emails()).createIndex({ email: 1 }, { unique: true });
    await (await users()).createIndex({ user_id: 1 }, { unique: true });
    console.log('✅ База данных инициализирована');
  } catch (e) {
    console.error('❌ Ошибка инициализации:', e);
  } finally {
    process.exit();
  }
}

