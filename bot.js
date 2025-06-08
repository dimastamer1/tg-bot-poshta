import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import express from 'express';
import config from './config.js';
import { connect, emails, users } from './db.js';

// Проверка подключения при старте
connect().then(() => {
  console.log('✅ Проверка подключения к MongoDB успешна');
}).catch(e => {
  console.error('❌ Ошибка подключения к MongoDB:', e);
});

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

// Проверка является ли пользователь админом
function isAdmin(userId) {
  return userId === config.adminId;
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
  const emailsCount = await (await emails()).countDocuments();
  
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
        [{ text: `⭐️ ПОЧТЫ ICLOUD (${emailsCount}шт) ⭐️`, callback_data: 'emails_category' }],
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
  const emailsCount = await (await emails()).countDocuments();
  
  const text = `📧 <b>ПОЧТЫ ICLOUD (${emailsCount}шт) 📧</b>\n\n` +
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
  const availableCount = await (await emails()).countDocuments();
  const maxAvailable = Math.min(availableCount, 10);
  
  const quantityButtons = [];
  for (let i = 1; i <= maxAvailable; i++) {
    quantityButtons.push({ text: `${i}`, callback_data: `quantity_${i}` });
  }
  
  const rows = [];
  for (let i = 0; i < quantityButtons.length; i += 5) {
    rows.push(quantityButtons.slice(i, i + 5));
  }
  
  rows.push([{ text: '🔙 Назад', callback_data: 'back_to_emails_menu' }]);

  const text = `📦 <b>Выберите количество почт, которое хотите приобрести</b>\n\n` +
    `Доступно: <b>${maxAvailable}</b> почт\n` +
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

    const usersCollection = await users();
    await usersCollection.updateOne(
      { user_id: userId },
      { 
        $setOnInsert: { user_id: userId, emails: [] },
        $set: { [`transactions.${transactionId}`]: {
          invoiceId: response.data.result.invoice_id,
          quantity: quantity,
          status: 'pending',
          timestamp: Date.now()
        }}
      },
      { upsert: true }
    );

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
  const usersCollection = await users();
  const emailsCollection = await emails();
  
  const user = await usersCollection.findOne({ user_id: userId });
  if (!user || !user.transactions || !user.transactions[transactionId]) {
    return false;
  }

  const quantity = user.transactions[transactionId].quantity;
  
  // Получаем почты для продажи
  const emailsToSell = await emailsCollection.aggregate([
    { $sample: { size: quantity } }
  ]).toArray();
  
  if (emailsToSell.length < quantity) {
    await usersCollection.updateOne(
      { user_id: userId },
      { $set: { [`transactions.${transactionId}.status`]: 'failed' } }
    );
    
    await bot.sendMessage(userId, 
      `❌ Недостаточно почт в пуле\nОбратитесь в поддержку @igor_Potekov`,
      { parse_mode: 'HTML' });
    return false;
  }

  // Обновляем данные пользователя
  await usersCollection.updateOne(
    { user_id: userId },
    {
      $push: { emails: { $each: emailsToSell.map(e => e.email) } },
      $set: { 
        [`transactions.${transactionId}.status`]: 'completed',
        [`transactions.${transactionId}.emails`]: emailsToSell.map(e => e.email)
      }
    }
  );

  // Удаляем проданные почты
  await emailsCollection.deleteMany({
    email: { $in: emailsToSell.map(e => e.email) }
  });

  await bot.sendMessage(userId,
    `🎉 Оплата подтверждена!\nВаши почты:\n${emailsToSell.map(e => e.email).join('\n')}`,
    { parse_mode: 'HTML' });

  return true;
}

// Периодическая проверка оплаты с защитой от дублирования
setInterval(async () => {
  try {
    const usersCollection = await users();
    const usersWithTransactions = await usersCollection.find({
      "transactions": { $exists: true }
    }).toArray();

    for (const user of usersWithTransactions) {
      for (const [transactionId, transaction] of Object.entries(user.transactions)) {
        if (transaction.status === 'pending' && transaction.invoiceId) {
          const invoice = await checkPayment(transaction.invoiceId);
          
          if (invoice?.status === 'paid') {
            await handleSuccessfulPayment(user.user_id, transactionId);
          } else if (invoice?.status === 'expired') {
            await usersCollection.updateOne(
              { user_id: user.user_id },
              { $set: { [`transactions.${transactionId}.status`]: 'expired' } }
            );
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
  const usersCollection = await users();
  const user = await usersCollection.findOne({ user_id: chatId });
  
  if (!user || !user.emails || user.emails.length === 0) {
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
      const emailsCount = await (await emails()).countDocuments();
      if (emailsCount === 0) {
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
      const usersCollection = await users();
      const user = await usersCollection.findOne({ user_id: chatId });
      
      if (!user || !user.emails || user.emails.length === 0) {
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

// Админские команды
// Добавление почт
bot.onText(/\/add_emails (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;

  const emailsCollection = await emails();
  const newEmails = match[1].split(',').map(e => e.trim()).filter(e => e);
  
  const result = await emailsCollection.insertMany(
    newEmails.map(email => ({ email })),
    { ordered: false }
  );
  
  const count = await emailsCollection.countDocuments();
  bot.sendMessage(msg.chat.id, 
    `✅ Добавлено: ${result.insertedCount}\n📊 Всего почт: ${count}`);
});

// Статус пула
bot.onText(/\/pool_status/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;

  const emailsCollection = await emails();
  const count = await emailsCollection.countDocuments();
  const first50 = await emailsCollection.find().limit(50).toArray();
  
  let message = `📊 Всего почт: ${count}\n\n`;
  message += first50.map(e => e.email).join('\n');
  
  if (count > 50) message += '\n\n...и другие (показаны первые 50)';
  
  bot.sendMessage(msg.chat.id, message);
});

// Проверка подключения к базе
bot.onText(/\/db_status/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  
  try {
    const db = await connect();
    const stats = await db.command({ dbStats: 1 });
    const emailCount = await (await emails()).countDocuments();
    
    bot.sendMessage(msg.chat.id, 
      `🛠️ <b>Статус базы данных</b>\n\n` +
      `✅ Подключение активно\n` +
      `📊 Размер базы: ${(stats.dataSize / 1024).toFixed(2)} KB\n` +
      `📧 Почтов в пуле: ${emailCount}\n` +
      `👥 Пользователей: ${await (await users()).countDocuments()}`,
      { parse_mode: 'HTML' });
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Ошибка подключения: ${e.message}`);
  }
});

// Запуск сервера и бота
(async () => {
  try {
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