import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import express from 'express';
import config from './config.js';

// Создаем Express приложение для вебхука
const app = express();
const PORT = process.env.PORT || 3000;

// Инициализация бота
const bot = new TelegramBot(config.telegramToken, { 
  polling: false // Отключаем polling для вебхука
});
const CRYPTOBOT_API_TOKEN = config.cryptoBotToken;

// Настройки IMAP для iCloud
const imapConfig = {
  user: config.imap.user,
  password: config.imap.password,
  host: config.imap.host,
  port: config.imap.port,
  tls: config.imap.tls,
  tlsOptions: { rejectUnauthorized: false }
};

// Middleware для обработки JSON
app.use(express.json());

// Эндпоинт для вебхука
app.post(`/webhook`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Health check эндпоинт
app.get('/', (req, res) => {
  res.send('UBT TikTok Bot is running!');
});

// Пути к файлам базы данных
const dbPath = path.resolve('./db.json');
const emailsPoolPath = path.resolve('./emailsPool.json');

// Проверка является ли пользователь админом
function isAdmin(userId) {
  return userId === config.adminId;
}

// Функции для работы с базой данных
async function readDB() {
  try {
    const data = await fs.readFile(dbPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Ошибка чтения DB:', error);
    return { users: {}, emailsPool: [] };
  }
}

async function writeDB(data) {
  try {
    await fs.writeFile(dbPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('Ошибка записи DB:', error);
  }
}

async function readEmailsPool() {
  try {
    const data = await fs.readFile(emailsPoolPath, 'utf8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed.emails) ? parsed : { emails: [] };
  } catch (error) {
    console.error('Ошибка чтения пула почт:', error);
    return { emails: [] };
  }
}

async function writeEmailsPool(pool) {
  try {
    const toSave = Array.isArray(pool.emails) ? pool : { emails: [] };
    await fs.writeFile(emailsPoolPath, JSON.stringify(toSave, null, 2), 'utf8');
  } catch (error) {
    console.error('Ошибка записи пула почт:', error);
  }
}

// Улучшенная функция для извлечения кода из текста письма (только TikTok и TikTok Studio)
function getCodeFromText(text, subject) {
  const textLower = text.toLowerCase();
  const subjectLower = subject?.toLowerCase() || '';
  
  // Проверяем, что письмо от TikTok (включая TikTok Studio)
  const isTikTok = textLower.includes('tiktok') || 
                   textLower.includes('тикток') || 
                   textLower.includes('тик-ток') ||
                   subjectLower.includes('tiktok') ||
                   subjectLower.includes('тикток') ||
                   subjectLower.includes('тик-ток') ||
                   textLower.includes('tiktok studio') ||
                   subjectLower.includes('tiktok studio');

  if (!isTikTok) return null;

  // Ищем код в формате 4-8 цифр
  const codeMatch = text.match(/\b\d{4,8}\b/);
  if (!codeMatch) return null;

  return codeMatch[0];
}

// Улучшенная функция для поиска кода в письмах
async function getLatestCode(targetEmail) {
  return new Promise((resolve, reject) => {
    const imap = new Imap(imapConfig);
    let foundCode = null;
    let processedCount = 0;

    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err) => {
        if (err) {
          console.error('Ошибка открытия INBOX:', err);
          imap.end();
          return reject(err);
        }

        // Ищем письма за последние 24 часа (не только непрочитанные)
        const searchCriteria = ['ALL', ['SINCE', new Date(Date.now() - 24 * 60 * 60 * 1000)]];
        
        imap.search(searchCriteria, (err, results) => {
          if (err) {
            console.error('Ошибка поиска писем:', err);
            imap.end();
            return reject(err);
          }

          if (!results || results.length === 0) {
            console.log('Писем не найдено');
            imap.end();
            return resolve(null);
          }

          console.log(`Найдено ${results.length} писем, проверяем...`);
          const fetchOptions = { bodies: ['HEADER.FIELDS (FROM TO SUBJECT)', 'TEXT'] };
          const fetch = imap.fetch(results.slice(-20), fetchOptions); // Проверяем последние 20 писем

          fetch.on('message', (msg) => {
            let headers = '';
            let text = '';
            let subject = '';

            msg.on('body', (stream, info) => {
              let buffer = '';
              stream.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
              });
              stream.on('end', () => {
                if (info.which === 'HEADER.FIELDS (FROM TO SUBJECT)') {
                  headers = buffer;
                  // Извлекаем тему из заголовков
                  const subjectMatch = headers.match(/^Subject:\s*(.*?)\r?\n/im);
                  subject = subjectMatch ? subjectMatch[1] : '';
                } else if (info.which === 'TEXT') {
                  text = buffer;
                }
              });
            });

            msg.once('end', async () => {
              processedCount++;
              try {
                // Проверяем, что письмо адресовано нашему email
                const toMatch = headers.match(/^To:\s*(.*?)\r?\n/im);
                const to = toMatch ? toMatch[1] : '';
                
                if (to.includes(targetEmail)) {
                  console.log(`Проверяем письмо с темой: "${subject}"`);
                  const code = getCodeFromText(text, subject);
                  if (code) {
                    console.log(`Найден код: ${code}`);
                    foundCode = code;
                  }
                }
              } catch (e) {
                console.error('Ошибка обработки письма:', e);
              }

              // Если обработали все письма и код не найден
              if (processedCount === Math.min(results.length, 20)) {
                imap.end();
                resolve(foundCode);
              }
            });
          });

          fetch.once('error', (err) => {
            console.error('Ошибка при получении писем:', err);
            imap.end();
            reject(err);
          });

          fetch.once('end', () => {
            console.log('Проверка писем завершена');
            if (!foundCode) {
              imap.end();
              resolve(null);
            }
          });
        });
      });
    });

    imap.once('error', (err) => {
      console.error('IMAP ошибка:', err);
      reject(err);
    });

    imap.connect();
  });
}

// Главное меню с инлайн-кнопками
async function sendMainMenu(chatId, deletePrevious = false) {
  const pool = await readEmailsPool();
  const count = pool.emails.length;
  
  const welcomeText = `👋 <b>Добро пожаловать, вы находитесь в боте, сделанном под UBT для сп"ма Tik Tok!</b>\n\n` +
    `<b>Тут вы можете:</b>\n` +
    `• Купить почту по выгодной цене\n` +
    `• Получить код почты Tik Tok (ТОЛЬКО ICLOUD, И ТОЛЬКО ТЕ КОТОРЫЕ КУПЛЕННЫЕ У НАС)\n` +
    `• Скоро добвим еще разные почты и аккаунты\n` +
    `• В будущем - получить связку залива за приглашения друзей\n\n` +
    `⚠️ Бот новый, возможны временные перебои\n\n` +
    `🎉 <b>Акция!</b> До 11.06 почты всего по 4 рубля! 😱`;

  const options = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: `⭐️ ПОЧТЫ ICLOUD (${count}шт) ⭐️`, callback_data: 'emails_category' }],
        [{ text: '🛒 МОИ ПОЧТЫ 🛒', callback_data: 'my_purchases' }],
        [{ text: '🆘 ПОДДЕРЖКА 🆘', callback_data: 'support' }]
      ]
    }
  };

  if (deletePrevious) {
    bot.sendMessage(chatId, '⌛ Обновляю меню...').then(msg => {
      setTimeout(() => bot.deleteMessage(chatId, msg.message_id), 300);
    });
  }

  return bot.sendMessage(chatId, welcomeText, options);
}

// Меню почт iCloud с инлайн-кнопками
async function sendEmailsMenu(chatId) {
  const pool = await readEmailsPool();
  const count = pool.emails.length;
  
  const text = `📧 <b>ПОЧТЫ ICLOUD (${count}шт) 📧</b>\n\n` +
  `<b>В данном меню вы можете:</b>\n` +
  `✅ • Покупать почты\n` +
  `✅ • Получать коды от почт\n` +
    `🎉 <b>Акция!</b> До 11.06 почты всего по 4 рубля! 😱`;
    ` <b>Выбирите куда хотите попасть</b>`;

  const options = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '💰 КУПИТЬ ПОЧТУ 💰', callback_data: 'buy_email' }],
        [{ text: '🔑 ПОЛУЧИТЬ КОД 🔑', callback_data: 'get_code' }],
        [{ text: '🔙 Назад 🔙', callback_data: 'back_to_main' }]
      ]
    }
  };

  return bot.sendMessage(chatId, text, options);
}

// Меню выбора количества почт
async function sendQuantityMenu(chatId) {
  const pool = await readEmailsPool();
  const availableCount = Math.min(pool.emails.length, 10);
  
  const quantityButtons = [];
  for (let i = 1; i <= availableCount; i++) {
    quantityButtons.push({ text: `${i}`, callback_data: `quantity_${i}` });
  }
  
  const rows = [];
  for (let i = 0; i < quantityButtons.length; i += 5) {
    rows.push(quantityButtons.slice(i, i + 5));
  }
  
  rows.push([{ text: '🔙 Назад', callback_data: 'back_to_emails_menu' }]);

  const text = `📦 <b>Выберите количество почт, которое хотите приобрести</b>\n\n` +
    `Доступно: <b>${availableCount}</b> почт\n` +
    `Цена: <b>4 Рубля</b> за 1 почту`;

  const options = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: rows
    }
  };

  return bot.sendMessage(chatId, text, options);
}

// Меню оплаты
async function sendPaymentMenu(chatId, invoiceUrl, quantity) {
  const totalAmount = (0.052 * quantity).toFixed(2);
  
  const text = `💳 <b>Оплата ${quantity} почт(ы)</b>\n\n` +
    `Сумма: <b>${totalAmount} USDT</b>\n\n` +
    `Нажмите кнопку для оплаты:`;

  const options = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ ОПЛАТИТЬ ЧЕРЕЗ CRYPTOBOT', url: invoiceUrl }],
        [{ text: '🔙 Назад', callback_data: 'back_to_quantity_menu' }]
      ]
    }
  };

  return bot.sendMessage(chatId, text, options);
}

// Создание инвойса с транзакцией
async function createInvoice(userId, quantity) {
  try {
    const transactionId = `buy_${userId}_${Date.now()}`;
    const amount = 0.052 * quantity;
    
    const response = await axios.post('https://pay.crypt.bot/api/createInvoice', {
      asset: 'USDT',
      amount: amount,
      description: `Покупка ${quantity} почт iCloud`,
      hidden_message: 'Спасибо за покупку!',
      paid_btn_name: 'openBot',
      paid_btn_url: 'https://t.me/ubtshope_bot',
      payload: transactionId
    }, {
      headers: {
        'Crypto-Pay-API-Token': CRYPTOBOT_API_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    const db = await readDB();
    db.users[userId] = db.users[userId] || { paid: false, emails: [], transactions: {} };
    db.users[userId].transactions[transactionId] = {
      invoiceId: response.data.result.invoice_id,
      quantity: quantity,
      status: 'pending',
      timestamp: Date.now()
    };
    await writeDB(db);

    return response.data.result.pay_url;
  } catch (err) {
    console.error('Ошибка при создании инвойса:', err.response?.data || err.message);
    return null;
  }
}

// Проверка оплаты с обработкой транзакции
async function checkPayment(invoiceId) {
  try {
    const response = await axios.get(`https://pay.crypt.bot/api/getInvoices?invoice_ids=${invoiceId}`, {
      headers: {
        'Crypto-Pay-API-Token': CRYPTOBOT_API_TOKEN
      }
    });
    
    return response.data.result.items[0];
  } catch (err) {
    console.error('Ошибка при проверке оплаты:', err);
    return null;
  }
}

// Обработка успешной оплаты с транзакцией
async function handleSuccessfulPayment(userId, transactionId) {
  const db = await readDB();
  const pool = await readEmailsPool();
  
  if (!db.users[userId] || !db.users[userId].transactions[transactionId]) {
    return false;
  }
  
  const transaction = db.users[userId].transactions[transactionId];
  const quantity = transaction.quantity;
  
  if (pool.emails.length >= quantity) {
    const emails = pool.emails.splice(0, quantity);
    db.users[userId].emails.push(...emails);
    transaction.status = 'completed';
    transaction.emails = emails;
    
    await writeDB(db);
    await writeEmailsPool(pool);
    
    await bot.sendMessage(userId, 
      `🎉 <b>Оплата подтверждена!</b>\n\n` +
      `📧 <b>Ваши почты:</b>\n<code>${emails.join('\n')}</code>\n\n` +
      `🔑 Для получения кодов нажмите "🔑 ПОЛУЧИТЬ КОД"`, 
      { parse_mode: 'HTML' });
      
    return true;
  } else {
    transaction.status = 'failed';
    await writeDB(db);
    
    await bot.sendMessage(userId, 
      `❌ <b>Недостаточно почт в пуле</b>\n\n` +
      `Мы вернем ваши средства. Пожалуйста, обратитесь в поддержку @igor_Potekov`, 
      { parse_mode: 'HTML' });
      
    return false;
  }
}

// Периодическая проверка оплаты с защитой от дублирования
setInterval(async () => {
  try {
    const db = await readDB();
    
    for (const [userId, userData] of Object.entries(db.users)) {
      if (userData.transactions) {
        for (const [transactionId, transaction] of Object.entries(userData.transactions)) {
          if (transaction.status === 'pending' && transaction.invoiceId) {
            const invoice = await checkPayment(transaction.invoiceId);
            
            if (invoice?.status === 'paid') {
              await handleSuccessfulPayment(userId, transactionId);
            } else if (invoice?.status === 'expired') {
              transaction.status = 'expired';
              await writeDB(db);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('Ошибка при проверке платежей:', err);
  }
}, 20000); // Проверяем каждые 20 секунд

// Меню моих покупок
async function sendMyPurchasesMenu(chatId) {
  const db = await readDB();
  const user = db.users[chatId] || { emails: [] };
  
  if (!user.emails || user.emails.length === 0) {
    return bot.sendMessage(chatId, 
      '❌ У вас пока нет покупок.\n' +
      'Нажмите "📧 ПОЧТЫ ICLOUD" чтобы сделать покупку', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📧 ПОЧТЫ ICLOUD', callback_data: 'emails_category' }],
          [{ text: '🔙 Назад', callback_data: 'back_to_main' }]
        ]
      }
    });
  }
  
  const buttons = user.emails.map(email => [{ text: email, callback_data: `email_${email}` }]);
  buttons.push([{ text: '🔙 Назад', callback_data: 'back_to_main' }]);
  
  return bot.sendMessage(chatId, '📦 <b>Ваши покупки:</b>', {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: buttons
    }
  });
}

// Меню поддержки
async function sendSupportMenu(chatId) {
  return bot.sendMessage(chatId, 
    '🛠️ <b>Техническая поддержка</b>\n\n' +
    'По всем вопросам обращайтесь к менеджеру:\n' +
    '@igor_Potekov\n\n' +
    'Мы решим любую вашу проблему!', {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔙 Назад', callback_data: 'back_to_main' }]
      ]
    }
  });
}

// Обработка callback-запросов
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  
  try {
    // Главное меню
    if (data === 'back_to_main') {
      await bot.deleteMessage(chatId, callbackQuery.message.message_id);
      return sendMainMenu(chatId);
    }
    
    // Категория почт
    if (data === 'emails_category') {
      await bot.deleteMessage(chatId, callbackQuery.message.message_id);
      return sendEmailsMenu(chatId);
    }
    
    // Назад к меню почт
    if (data === 'back_to_emails_menu') {
      await bot.deleteMessage(chatId, callbackQuery.message.message_id);
      return sendEmailsMenu(chatId);
    }
    
    // Купить почту
    if (data === 'buy_email') {
      const pool = await readEmailsPool();
      if (!Array.isArray(pool.emails) || pool.emails.length === 0) {
        return bot.answerCallbackQuery(callbackQuery.id, {
          text: 'Почты временно закончились. Попробуйте позже.',
          show_alert: true
        });
      }
      
      await bot.deleteMessage(chatId, callbackQuery.message.message_id);
      return sendQuantityMenu(chatId);
    }
    
    // Выбор количества
    if (data.startsWith('quantity_')) {
      const quantity = parseInt(data.split('_')[1]);
      const invoiceUrl = await createInvoice(chatId, quantity);
      
      if (!invoiceUrl) {
        return bot.answerCallbackQuery(callbackQuery.id, {
          text: 'Ошибка при создании платежа. Попробуйте позже.',
          show_alert: true
        });
      }
      
      await bot.deleteMessage(chatId, callbackQuery.message.message_id);
      await sendPaymentMenu(chatId, invoiceUrl, quantity);
      return bot.answerCallbackQuery(callbackQuery.id);
    }
    
    // Назад к выбору количества
    if (data === 'back_to_quantity_menu') {
      await bot.deleteMessage(chatId, callbackQuery.message.message_id);
      return sendQuantityMenu(chatId);
    }
    
    // Получить код
    if (data === 'get_code') {
      const db = await readDB();
      const user = db.users[chatId] || { emails: [] };
      
      if (!user.emails || user.emails.length === 0) {
        return bot.answerCallbackQuery(callbackQuery.id, {
          text: 'У вас нет купленных почт. Сначала купите почту.',
          show_alert: true
        });
      }
      
      await bot.deleteMessage(chatId, callbackQuery.message.message_id);
      return sendMyPurchasesMenu(chatId);
    }
    
    // Выбор почты для получения кода
    if (data.startsWith('email_')) {
      const email = data.replace('email_', '');
      
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: `Ищем код для почты ${email}...`,
        show_alert: false
      });
      
      try {
        // Показываем сообщение о поиске кода
        const searchMsg = await bot.sendMessage(chatId, 
          `🔍 <b>Ищем код TikTok для</b> <code>${email}</code>\n\n` +
          `Это может занять до 30 секунд...`, {
          parse_mode: 'HTML'
        });
        
        const code = await getLatestCode(email);
        
        // Удаляем сообщение о поиске
        await bot.deleteMessage(chatId, searchMsg.message_id);
        
        if (code) {
          await bot.sendMessage(chatId, 
            `✅ <b>Код TikTok для</b> <code>${email}</code>\n\n` +
            `🔑 <b>Ваш код:</b> <code>${code}</code>\n\n` +
            `⚠️ <i>Никому не сообщайте этот код!</i>`, {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔙 Назад', callback_data: 'back_to_main' }]
              ]
            }
          });
        } else {
          await bot.sendMessage(chatId, 
            `❌ <b>Код TikTok не найден</b> для <code>${email}</code>\n\n` +
            `Возможные причины:\n` +
            `1. Письмо с кодом еще не пришло (попробуйте через 1-2 минуты)\n` +
            `2. Письмо попало в спам\n` +
            `3. Код уже был использован`, {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 Попробовать снова', callback_data: `email_${email}` }],
                [{ text: '🔙 Назад', callback_data: 'back_to_main' }]
              ]
            }
          });
        }
      } catch (e) {
        console.error('Ошибка при получении кода:', e);
        await bot.sendMessage(chatId, 
         `❌ <b>Ошибка при получении кода</b>\n\n` +
          `${e.message}\n\n` +
          `Попробуйте позже или напишите в поддержку`, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🆘 Поддержка', callback_data: 'support' }],
              [{ text: '🔙 Назад', callback_data: 'back_to_main' }]
            ]
          }
        });
      }
      return;
    }
    
    // Мои покупки
    if (data === 'my_purchases') {
      await bot.deleteMessage(chatId, callbackQuery.message.message_id);
      return sendMyPurchasesMenu(chatId);
    } 
    
    // Поддержка
    if (data === 'support') {
      await bot.deleteMessage(chatId, callbackQuery.message.message_id);
      return sendSupportMenu(chatId);
    }
    
  } catch (err) {
    console.error('Ошибка в обработчике callback:', err);
    bot.answerCallbackQuery(callbackQuery.id, {
      text: 'Произошла ошибка. Попробуйте еще раз.',
      show_alert: true
    });
  }
});

// Команда /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  sendMainMenu(chatId);
});

// Инициализация базы данных при запуске
async function initDatabase() {
  try {
    await fs.access(emailsPoolPath);
  } catch {
    await writeEmailsPool({ emails: [] });
  }

  try {
    await fs.access(dbPath);
  } catch {
    await writeDB({ users: {}, emailsPool: [] });
  }
}

// Админские команды
bot.onText(/\/add_emails (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, '❌ У вас нет прав для этой команды.');
  }

  const emails = match[1].split(',').map(e => e.trim()).filter(e => e);
  const pool = await readEmailsPool();
  
  if (!Array.isArray(pool.emails)) {
    pool.emails = [];
  }

  let addedCount = 0;
  for (const email of emails) {
    if (!pool.emails.includes(email)) {
      pool.emails.push(email);
      addedCount++;
    }
  }

  await writeEmailsPool(pool);
  bot.sendMessage(msg.chat.id, `✅ Добавлено ${addedCount} почт. Всего в пуле: ${pool.emails.length}`);
});

bot.onText(/\/pool_status/, async (msg) => {
  if (!isAdmin(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, '❌ У вас нет прав для этой команды.');
  }

  const pool = await readEmailsPool();
  bot.sendMessage(msg.chat.id, `📊 В пуле ${pool.emails.length} почт:\n\n${pool.emails.join('\n')}`);
});

bot.onText(/\/reset_user (\d+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  
  const userId = parseInt(match[1]);
  const db = await readDB();
  delete db.users[userId];
  await writeDB(db);
  bot.sendMessage(msg.chat.id, `✅ Пользователь ${userId} сброшен`);
});

bot.onText(/\/check_user (\d+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  
  const userId = parseInt(match[1]);
  const db = await readDB();
  const user = db.users[userId] || {};
  
  let transactionsInfo = 'Транзакции:\n';
  if (user.transactions) {
    for (const [id, t] of Object.entries(user.transactions)) {
      transactionsInfo += `- ${id}: ${t.status}\n`;
    }
  }
  
  bot.sendMessage(msg.chat.id, 
    `👤 Пользователь ${userId}\n` +
    `📧 Почты: ${user.emails?.join(', ') || 'нет'}\n\n` +
    transactionsInfo);
});

// Запуск сервера и бота
(async () => {
  try {
    // Инициализация базы данных
    await initDatabase();
    
    // Установка вебхука при запуске на Render
    if (process.env.RENDER_EXTERNAL_URL) {
      const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/webhook`;
      await bot.setWebHook(webhookUrl);
      console.log(`Webhook установлен: ${webhookUrl}`);
    } else {
      console.log('Running in development mode');
    }

    // Запуск сервера
    app.listen(PORT, () => {
      console.log(`Сервер запущен на порту ${PORT}`);
      console.log('💎 Бот успешно запущен и готов к работе!');
    });
  } catch (err) {
    console.error('Ошибка при запуске:', err);
    process.exit(1);
  }
})();