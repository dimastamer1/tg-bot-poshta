import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import express from 'express';
import config from './config.js';
import { connect, emails, users, firstmails } from './db.js';

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

// Генерация реферальной ссылки
function generateReferralLink(userId) {
    return `https://t.me/${config.botUsername}?start=ref_${userId}`;
}

// /start с рефералкой, без конфликтов по referrals и last_seen, бонусы и скидка
bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const startPayload = match[1];

    const usersCollection = await users();

    // 1. Гарантируем, что у пользователя всегда массив referrals (и прочие поля)
    await usersCollection.updateOne(
        { user_id: chatId },
        {
            $setOnInsert: {
                user_id: chatId,
                username: msg.from.username || '',
                first_name: msg.from.first_name || '',
                last_name: msg.from.last_name || '',
                first_seen: new Date(),
                emails: [],
                firstmails: [],
                referrals: [],
                invitedBy: null,
                hasDiscount: false,
                hasUkBundle: false,
                canGetUkBundle: false
            }
        },
        { upsert: true }
    );
    // last_seen обновляем отдельным запросом!
    await usersCollection.updateOne(
        { user_id: chatId },
        { $set: { last_seen: new Date() } }
    );

    // 2. Проверяем, что если был startPayload — это рефералка, и он не сам себя приглашает
    if (startPayload && startPayload.startsWith('ref_')) {
        const referrerId = parseInt(startPayload.replace('ref_', ''));
        if (referrerId && referrerId !== chatId) {
            // Проверяем, что пользователь реально новый (нет других полей)
            const currentUser = await usersCollection.findOne({ user_id: chatId });
            if (currentUser && !currentUser.invitedBy) {
                // Добавляем chatId в массив referrals реферера, только если его нет
                await usersCollection.updateOne(
                    { user_id: referrerId },
                    { $addToSet: { referrals: chatId } }
                );
                // Помечаем кто пригласил (чтобы не засчитать повторно)
                await usersCollection.updateOne(
                    { user_id: chatId },
                    { $set: { invitedBy: referrerId } }
                );

                // Проверяем сколько рефералов теперь у этого пользователя
                const referrer = await usersCollection.findOne({ user_id: referrerId });
                const referralsCount = (referrer.referrals || []).length;

                // Если стало >= 5 — ставим флаг скидки
                if (referralsCount >= 5 && !referrer.hasDiscount) {
                    await usersCollection.updateOne(
                        { user_id: referrerId },
                        { $set: { hasDiscount: true } }
                    );
                }
                // Если стало >= 10 — ставим флаг для связки
                if (referralsCount >= 10 && !referrer.canGetUkBundle) {
                    await usersCollection.updateOne(
                        { user_id: referrerId },
                        { $set: { canGetUkBundle: true } }
                    );
                }

                // Уведомляем реферера
                try {
                    await bot.sendMessage(referrerId,
                        `🎉 У вас новый реферал!\n` +
                        `👤 @${msg.from.username || 'без username'}\n` +
                        `🆔 ID: ${chatId}\n` +
                        `Теперь у вас: ${referralsCount} рефералов`
                    );
                } catch (e) {}
            }
        }
    }

    // ... далее вызов главного меню ...
    sendMainMenu(chatId);
});

// --- продолжение ---

// Главное меню с инлайн-кнопками
async function sendMainMenu(chatId, deletePrevious = false) {
    const emailsCount = await (await emails()).countDocuments();
    const firstmailCount = await (await firstmails()).countDocuments();

    const usersCollection = await users();
    await usersCollection.updateOne(
        { user_id: chatId },
        { $setOnInsert: { user_id: chatId, emails: [], firstmails: [], first_seen: new Date(), referrals: [], hasDiscount: false, hasUkBundle: false, canGetUkBundle: false } },
        { upsert: true }
    );

    const user = await usersCollection.findOne({ user_id: chatId });
    const hasDiscount = user && user.hasDiscount;
    const discountText = hasDiscount ? '\n\n🎉 У вас есть скидка 10%!' : '';

    const welcomeText = `👋 <b>Добро пожаловать, вы находитесь в боте, сделанном под UBT для спама TikTok!</b>\n\n` +
        `<b>Тут вы можете:</b>\n` +
        `• Купить почту по выгодной цене\n` +
        `• Получить код почты TikTok (ТОЛЬКО ICLOUD, и только те, которые куплены у нас)\n` +
        `• Купить почту FIRSTMAIL для спама (выдается как email:password)\n` +
        `• Скоро добавим еще разные почты и аккаунты\n` +
        `⚠️ Бот новый, возможны временные перебои\n\n` +
        `🎉 <b>СКОРО АКЦИЯ</b> 10.06 почты всего по 6 рублей будут! 😱` + discountText;

    const options = {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: `📂 КАТЕГОРИИ 📂`, callback_data: 'categories' }],
                [{ text: '🛒 МОИ ПОКУПКИ 🛒', callback_data: 'my_purchases' }],
                [{ text: '🔗 РЕФЕРАЛКА 🔗', callback_data: 'referral' }],
                [{ text: '🎁 СВЯЗКА 🇺🇦 🎁', callback_data: 'get_uk_bundle' }],
                [{ text: '🆘 ПОДДЕРЖКА 🆘', callback_data: 'support' }]
            ]
        }
    };

    if (deletePrevious) {
        bot.sendMessage(chatId, '⌛ Обновляю меню...').then(msg => {
            setTimeout(() => bot.deleteMessage(chatId, msg.message_id), 300);
        });
    }

    return bot.sendPhoto(chatId, 'https://i.ibb.co/spcnyqTy/image-3.png', {
        caption: welcomeText,
        parse_mode: 'HTML',
        reply_markup: options.reply_markup
    });
}

// Меню рефералки
async function sendReferralMenu(chatId) {
    const referralLink = generateReferralLink(chatId);
    const usersCollection = await users();
    const user = await usersCollection.findOne({ user_id: chatId });
    const referralsCount = user.referrals ? user.referrals.length : 0;
    const invitedBy = user.invitedBy ? user.invitedBy : 'никто не приглашал';

    const text = `🔗 <b>Ваша реферальная ссылка:</b>\n<code>${referralLink}</code>\n\n` +
        `👥 <b>Количество ваших рефералов:</b> ${referralsCount}\n` +
        `🎁 <b>Вас пригласил:</b> ${invitedBy}\n\n` +
        `Поделитесь ссылкой с друзьями и получайте бонусы!`;

    const options = {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '💰 Cкопировать ссылку', callback_data: 'copy_referral' }],
                [{ text: '🔙 Назад', callback_data: 'back_to_main' }]
            ]
        }
    };

    return bot.sendMessage(chatId, text, options);
}

// Обработка связки УКР
async function handleUkBundle(chatId, user) {
    const usersCollection = await users();
    if (!user.canGetUkBundle) {
        return bot.sendMessage(chatId, '❌ Чтобы получить связку, нужно пригласить 10 друзей, может быть баг если вы пригласили, но не можете открыть меню пишем сюда для выдачи связки - https://t.me/igor_Potekov', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔙 Назад', callback_data: 'back_to_main' }]
                ]
            }
        });
    }

    // Выдача связки (заглушка)
    await usersCollection.updateOne(
        { user_id: chatId },
        { $set: { hasUkBundle: true, canGetUkBundle: false } }
    );
    return bot.sendMessage(chatId, '🎉 Поздравляем! Вот ваша связка: ПОКА ЧТО НЕ РОСПИСАЛ ПИШЕМ СЮДА С СКРИНШОТОМ ПРИГЛАШЕНИЙ - https://t.me/igor_Potekov', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔙 Назад', callback_data: 'back_to_main' }]
            ]
        }
    });
}

// Меню категорий
async function sendCategoriesMenu(chatId) {
    const emailsCount = await (await emails()).countDocuments();
    const firstmailCount = await (await firstmails()).countDocuments();

    const text = `📂 <b>КАТЕГОРИИ</b>\n\n` +
        `Выберите нужную категорию:`;

    const options = {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: `📧 ПОЧТЫ ICLOUD (${emailsCount}шт)`, callback_data: 'emails_category' }],
                [{ text: `🔥 FIRSTMAIL (${firstmailCount}шт)`, callback_data: 'firstmail_category' }],
                [{ text: '🔙 Назад', callback_data: 'back_to_main' }]
            ]
        }
    };

    return bot.sendMessage(chatId, text, options);
}

// Меню почт iCloud с инлайн-кнопками
async function sendEmailsMenu(chatId) {
    const emailsCount = await (await emails()).countDocuments();

    const text = `📧 <b>ПОЧТЫ ICLOUD (${emailsCount}шт) 📧</b>\n\n` +
        `<b>В данном меню вы можете:</b>\n` +
        `✅ • Покупать почты\n` +
        `✅ • Получать коды от почт\n` +
        `🎉 <b>Акция!</b> До 11.06 почты всего по 7 рубля! 😱\n` +
        `<b>Выберите куда хотите попасть</b>`;

    const options = {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '💰 КУПИТЬ ПОЧТУ 💰', callback_data: 'buy_email' }],
                [{ text: '🔑 ПОЛУЧИТЬ КОД 🔑', callback_data: 'get_code' }],
                [{ text: '🔙 Назад 🔙', callback_data: 'back_to_categories' }]
            ]
        }
    };

    return bot.sendMessage(chatId, text, options);
}

// Меню FIRSTMAIL с инлайн-кнопками
async function sendFirstmailMenu(chatId) {
    const firstmailCount = await (await firstmails()).countDocuments();

    const text = `🔥 <b>ПОЧТЫ FIRSTMAIL (${firstmailCount}шт)</b>\n\n` +
        `<b>В данном меню вы можете:</b>\n` +
        `✅ • Купить почты FIRSTMAIL для спама\n\n` +
        `Цена: <b>6 рублей</b> или <b>0.08 USDT</b> за 1 почту\n\n` +
        `Выберите действие:`;

    const options = {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '💰 КУПИТЬ ПОЧТУ FIRSTMAIL 💰', callback_data: 'buy_firstmail' }],
                [{ text: '🔙 Назад', callback_data: 'back_to_categories' }]
            ]
        }
    };

    return bot.sendMessage(chatId, text, options);
}

// Меню выбора количества почт iCloud
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
        `Цена: <b>7 Рублей</b> за 1 почту`;

    const options = {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: rows
        }
    };

    return bot.sendMessage(chatId, text, options);
}

// Меню выбора количества почт FIRSTMAIL
async function sendFirstmailQuantityMenu(chatId) {
    const availableCount = await (await firstmails()).countDocuments();
    const maxAvailable = Math.min(availableCount, 10);

    const quantityButtons = [];
    for (let i = 1; i <= maxAvailable; i++) {
        quantityButtons.push({ text: `${i}`, callback_data: `firstmail_quantity_${i}` });
    }

    const rows = [];
    for (let i = 0; i < quantityButtons.length; i += 5) {
        rows.push(quantityButtons.slice(i, i + 5));
    }
    rows.push([{ text: '🔙 Назад', callback_data: 'firstmail_category' }]);

    const text = `📦 <b>Выберите количество почт FIRSTMAIL, которое хотите приобрести</b>\n\n` +
        `Доступно: <b>${maxAvailable}</b> почт\n` +
        `Цена: <b>6 Рублей</b> или <b>0.08 USDT</b> за 1 почту`;

    const options = {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: rows
        }
    };

    return bot.sendMessage(chatId, text, options);
}

// Меню оплаты iCloud
async function sendPaymentMenu(chatId, invoiceUrl, quantity) {
    const totalAmount = (0.09 * quantity).toFixed(2);

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

// Меню оплаты FIRSTMAIL
async function sendFirstmailPaymentMenu(chatId, invoiceUrl, quantity) {
    const totalAmount = (0.082 * quantity).toFixed(2);

    const text = `💳 <b>Оплата ${quantity} почт(ы) FIRSTMAIL</b>\n\n` +
        `Сумма: <b>${totalAmount} USDT</b>\n\n` +
        `Нажмите кнопку для оплаты:`;

    const options = {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '✅ ОПЛАТИТЬ ЧЕРЕЗ CRYPTOBOT', url: invoiceUrl }],
                [{ text: '🔙 Назад', callback_data: 'back_to_firstmail_quantity_menu' }]
            ]
        }
    };

    return bot.sendMessage(chatId, text, options);
}

// Создание инвойса с транзакцией iCloud
async function createInvoice(userId, quantity) {
    try {
        const transactionId = `buy_${userId}_${Date.now()}`;
        const amount = 0.09 * quantity;

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
                $set: {
                    [`transactions.${transactionId}`]: {
                        invoiceId: response.data.result.invoice_id,
                        quantity: quantity,
                        status: 'pending',
                        timestamp: Date.now()
                    }
                }
            },
            { upsert: true }
        );

        return response.data.result.pay_url;
    } catch (err) {
        console.error('Ошибка при создании инвойса:', err.response?.data || err.message);
        return null;
    }
}

// Создание инвойса для FIRSTMAIL
async function createFirstmailInvoice(userId, quantity) {
    try {
        const transactionId = `buy_firstmail_${userId}_${Date.now()}`;
        const amount = 0.082 * quantity;

        const response = await axios.post('https://pay.crypt.bot/api/createInvoice', {
            asset: 'USDT',
            amount: amount,
            description: `Покупка ${quantity} почт FIRSTMAIL`,
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
                $setOnInsert: { user_id: userId, firstmails: [] },
                $set: {
                    [`firstmail_transactions.${transactionId}`]: {
                        invoiceId: response.data.result.invoice_id,
                        quantity: quantity,
                        status: 'pending',
                        timestamp: Date.now()
                    }
                }
            },
            { upsert: true }
        );

        return response.data.result.pay_url;
    } catch (err) {
        console.error('Ошибка при создании инвойса FIRSTMAIL:', err.response?.data || err.message);
        return null;
    }
}

// Проверка оплаты iCloud
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

// Проверка оплаты firstmail
async function checkFirstmailPayment(invoiceId) {
    try {
        const response = await axios.get(`https://pay.crypt.bot/api/getInvoices?invoice_ids=${invoiceId}`, {
            headers: {
                'Crypto-Pay-API-Token': CRYPTOBOT_API_TOKEN
            }
        });

        return response.data.result.items[0];
    } catch (err) {
        console.error('Ошибка при проверке оплаты FIRSTMAIL:', err);
        return null;
    }
}

// Обработка успешной оплаты с транзакцией iCloud
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

    // Отправляем сообщение о покупке
    await bot.sendMessage(userId,
        `🎉 <b>Спасибо за покупку почты!</b>\n\n` +
        `Ваши почты указаны ниже:`,
        { parse_mode: 'HTML' });

    // Отправляем каждую почту отдельным сообщением
    for (const email of emailsToSell) {
        await bot.sendMessage(userId, email.email);
    }

    // Перенаправляем в меню получения кодов
    await sendMyIcloudsMenu(userId);

    return true;
}
// Обработка успешной оплаты firstmail
async function handleSuccessfulFirstmailPayment(userId, transactionId) {
  const usersCollection = await users();
  const firstmailsCollection = await firstmails();

  const user = await usersCollection.findOne({ user_id: userId });
  if (!user || !user.firstmail_transactions || !user.firstmail_transactions[transactionId]) {
      return false;
  }

  const quantity = user.firstmail_transactions[transactionId].quantity;

  // Получаем firstmail для продажи
  const firstmailsToSell = await firstmailsCollection.aggregate([
      { $sample: { size: quantity } }
  ]).toArray();

  if (firstmailsToSell.length < quantity) {
      await usersCollection.updateOne(
          { user_id: userId },
          { $set: { [`firstmail_transactions.${transactionId}.status`]: 'failed' } }
      );

      await bot.sendMessage(userId,
          `❌ Недостаточно почт FIRSTMAIL в пуле\nОбратитесь в поддержку @igor_Potekov`,
          { parse_mode: 'HTML' });
      return false;
  }

  // Обновляем данные пользователя
  await usersCollection.updateOne(
      { user_id: userId },
      {
          $push: { firstmails: { $each: firstmailsToSell.map(e => `${e.email}:${e.password}`) } },
          $set: {
              [`firstmail_transactions.${transactionId}.status`]: 'completed',
              [`firstmail_transactions.${transactionId}.emails`]: firstmailsToSell.map(e => `${e.email}:${e.password}`)
          }
      }
  );

  // Удаляем проданные почты
  await firstmailsCollection.deleteMany({
      email: { $in: firstmailsToSell.map(e => e.email) }
  });

  await bot.sendMessage(userId,
      `🎉 Оплата подтверждена!\nВаши почты FIRSTMAIL:\n${firstmailsToSell.map(e => `${e.email}:${e.password}`).join('\n')}`,
      { parse_mode: 'HTML' });

  return true;
}

// Периодическая проверка оплаты с защитой от дублирования iCloud/FIRSTMAIL
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

      // FIRSTMAIL
      const usersWithFirstmail = await usersCollection.find({
          "firstmail_transactions": { $exists: true }
      }).toArray();

      for (const user of usersWithFirstmail) {
          for (const [transactionId, transaction] of Object.entries(user.firstmail_transactions)) {
              if (transaction.status === 'pending' && transaction.invoiceId) {
                  const invoice = await checkFirstmailPayment(transaction.invoiceId);

                  if (invoice?.status === 'paid') {
                      await handleSuccessfulFirstmailPayment(user.user_id, transactionId);
                  } else if (invoice?.status === 'expired') {
                      await usersCollection.updateOne(
                          { user_id: user.user_id },
                          { $set: { [`firstmail_transactions.${transactionId}.status`]: 'expired' } }
                      );
                  }
              }
          }
      }
  } catch (err) {
      console.error('Ошибка при проверке платежей:', err);
  }
}, 10000); // Проверяем каждые 10 секунд (было 20)

// Мои покупки (iCloud + FIRSTMAIL)
async function sendMyPurchasesMenu(chatId) {
  const usersCollection = await users();
  const user = await usersCollection.findOne({ user_id: chatId });

  const hasIcloud = user && user.emails && user.emails.length > 0;
  const hasFirstmail = user && user.firstmails && user.firstmails.length > 0;

  const buttons = [];
  if (hasIcloud) buttons.push([{ text:'📧 Мои ICLOUD 📧', callback_data: 'my_iclouds' }]);
    if (hasFirstmail) buttons.push([{ text: '🔥 Мои FIRSTMAIL 📧', callback_data: 'my_firstmails' }]);
    buttons.push([{ text: '🔙 Назад', callback_data: 'back_to_main' }]);

    if (!hasIcloud && !hasFirstmail) {
        return bot.sendMessage(chatId,
            '❌ У вас пока нет покупок.\n' +
            'Нажмите "КАТЕГОРИИ" чтобы сделать покупку', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📂 КАТЕГОРИИ 📂', callback_data: 'categories' }],
                        [{ text: '🔙 Назад', callback_data: 'back_to_main' }]
                    ]
                }
            });
    }

    return bot.sendMessage(chatId, '📦 <b>Ваши покупки:</b> 📦', {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: buttons
        }
    });
}

// Мои ICLOUD почты (и возможность получить код)
async function sendMyIcloudsMenu(chatId) {
    const usersCollection = await users();
    const user = await usersCollection.findOne({ user_id: chatId });

    if (!user || !user.emails || user.emails.length === 0) {
        return bot.sendMessage(chatId,
            '❌ У вас пока нет купленных ICLOUD.\n' +
            'Купите их в разделе ICLOUD!', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📂 КАТЕГОРИИ 📂', callback_data: 'categories' }],
                        [{ text: '🔙 Назад', callback_data: 'back_to_main' }]
                    ]
                }
            });
    }

    const buttons = user.emails.map(email => [{ text: email, callback_data: `email_${email}` }]);
    buttons.push([{ text: '🔙 Назад', callback_data: 'back_to_main' }]);

    return bot.sendMessage(chatId, '📧 <b>Ваши ICLOUD почты:</b>📧', {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: buttons
        }
    });
}

// Мои FIRSTMAIL почты
async function sendMyFirstmailsMenu(chatId) {
    const usersCollection = await users();
    const user = await usersCollection.findOne({ user_id: chatId });

    if (!user || !user.firstmails || user.firstmails.length === 0) {
        return bot.sendMessage(chatId,
            '❌ У вас пока нет фирстмаилов.\n' +
            'Купите их в разделе FIRSTMAIL!', {
                reply_markup: {inline_keyboard: [
                            [{ text: '📂 КАТЕГОРИИ 📂', callback_data: 'categories' }],
                            [{ text: '🔙 Назад', callback_data: 'back_to_main' }]
                        ]
                }
            });
    }

    const buttons = user.firstmails.map(emailpass => [{ text: emailpass, callback_data: `firstmail_show_${emailpass}` }]);
    buttons.push([{ text: '🔙 Назад', callback_data: 'back_to_main' }]);

    return bot.sendMessage(chatId, '🔥 <b>Ваши FIRSTMAIL почты:</b> 🔥', {
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
        const usersCollection = await users();
        await usersCollection.updateOne(
            { user_id: chatId },
            { $set: { last_seen: new Date() } }
        );

        // Обработка реферальной системы
        if (data === 'referral') {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendReferralMenu(chatId);
        }

        if (data === 'copy_referral') {
            const referralLink = generateReferralLink(chatId);
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: 'Ссылка скопирована в буфер обмена!',
                show_alert: false
            });
            return bot.sendMessage(chatId, `🔗 <b>Ваша реферальная ссылка:</b>\n<code>${referralLink}</code>\n\nПоделитесь ей с друзьями!`, {
                parse_mode: 'HTML'
            });
        }

        if (data === 'get_uk_bundle') {
            const user = await usersCollection.findOne({ user_id: chatId });
            await handleUkBundle(chatId, user);
            return;
        }

        if (data === 'back_to_main') {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendMainMenu(chatId);
        }

        // Категории
        if (data === 'categories') {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendCategoriesMenu(chatId);
        }

        // Назад к категориям
        if (data === 'back_to_categories') {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendCategoriesMenu(chatId);
        }

        // Категория iCloud
        if (data === 'emails_category') {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendEmailsMenu(chatId);
        }

        // Категория FIRSTMAIL
        if (data === 'firstmail_category') {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendFirstmailMenu(chatId);
        }

        // Назад к меню почт
        if (data === 'back_to_emails_menu') {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendEmailsMenu(chatId);
        }

        // Назад к меню firstmail
        if (data === 'back_to_firstmail_menu') {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendFirstmailMenu(chatId);
        }

        // Купить почту iCloud
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

        // Купить firstmail
        if (data === 'buy_firstmail') {
            const firstmailCount = await (await firstmails()).countDocuments();
            if (firstmailCount === 0) {
                return bot.answerCallbackQuery(callbackQuery.id, {
                    text: 'FIRSTMAIL почты временно закончились. Попробуйте позже.',
                    show_alert: true
                });
            }
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendFirstmailQuantityMenu(chatId);
        }

        // Выбор количества iCloud
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

        // Выбор количества firstmail
        if (data.startsWith('firstmail_quantity_')) {
            const quantity = parseInt(data.split('_')[2]);
            const invoiceUrl = await createFirstmailInvoice(chatId, quantity);

            if (!invoiceUrl) {
                return bot.answerCallbackQuery(callbackQuery.id, {
                    text: 'Ошибка при создании платежа. Попробуйте позже.',
                    show_alert: true
                });
            }

            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            await sendFirstmailPaymentMenu(chatId, invoiceUrl, quantity);
            return bot.answerCallbackQuery(callbackQuery.id);
        }

        // Назад к выбору количества iCloud
        if (data === 'back_to_quantity_menu') {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendQuantityMenu(chatId);
        }

        // Назад к выбору количества firstmail
        if (data === 'back_to_firstmail_quantity_menu') {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendFirstmailQuantityMenu(chatId);
        }

        // Получить код ICLOUD
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
            return sendMyIcloudsMenu(chatId);
        }

        // Мои firstmail
        if (data === 'my_firstmails') {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendMyFirstmailsMenu(chatId);
        }

        // Мои icloud
        if (data === 'my_iclouds') {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendMyIcloudsMenu(chatId);
        }

        // Показываем выбранную firstmail
        if (data.startsWith('firstmail_show_')) {
            const emailpass = data.replace('firstmail_show_', '');
            await bot.sendMessage(chatId,
                `📧 <b>Ваша почта FIRSTMAIL:</b> <code>${emailpass}</code>\n\n` +
                `Используйте для ваших целей!`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔙 Назад', callback_data: 'my_firstmails' }]
                        ]
                    }
                }
            );
            return;
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
                        `1. Письмо с кодом еще не пришло (попробуйте через 10-15 секунд)\n` +
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
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;

    // Логируем нового пользователя
    console.log(`Новый пользователь: ${chatId}`, msg.from);

    // Сохраняем в базу
    const usersCollection = await users();
    await usersCollection.updateOne(
        { user_id: chatId },
        {
            $setOnInsert: {
                user_id: chatId,
                username: msg.from.username || '',
                first_name: msg.from.first_name || '',
                last_name: msg.from.last_name || '',
                first_seen: new Date(),
                last_seen: new Date(),
                emails: [],
                firstmails: []
            }
        },
        { upsert: true }
    );

    sendMainMenu(chatId);
});

// Админские команды
// Добавление почт iCloud
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

// Добавление почт FIRSTMAIL
bot.onText(/\/add_first (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;

    const firstmailsCollection = await firstmails();
    const newFirstmails = match[1].split(',').map(e => e.trim()).filter(e => e);

    // Для фирстмаил почт необходим формат типа "email:password"
    const toInsert = newFirstmails.map(str => {
        const [email, password] = str.split(':');
        return { email: email.trim(), password: (password || '').trim() };
    });

    const result = await firstmailsCollection.insertMany(toInsert, { ordered: false });
    const count = await firstmailsCollection.countDocuments();
    bot.sendMessage(msg.chat.id,
        `✅ Добавлено: ${result.insertedCount}\n🔥 Всего FIRSTMAIL: ${count}`);
});

// Статус пула iCloud
bot.onText(/\/pool_status/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;

    const emailsCollection = await emails();
    const count = await emailsCollection.countDocuments();
    const first50 = await emailsCollection.find().limit(50).toArray();

    let message = `📊 Всего почт: ${count}\n\n`;
    message += first50.map(e => e.email).join('\n');

    if (count > 200) message += '\n\n...и другие (показаны первые 200)';

    bot.sendMessage(msg.chat.id, message);
});
// Статус пула FIRSTMAIL
bot.onText(/\/firstmail_status/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;

    const firstmailsCollection = await firstmails();
    const count = await firstmailsCollection.countDocuments();
    const first50 = await firstmailsCollection.find().limit(50).toArray();

    let message = `🔥 Всего FIRSTMAIL: ${count}\n\n`;
    message += first50.map(e => `${e.email}:${e.password}`).join('\n');

    if (count > 200) message += '\n\n...и другие (показаны первые 200)';

    bot.sendMessage(msg.chat.id, message);
});

// Реферальная статистика
bot.onText(/\/ref_stats/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;

    const usersCollection = await users();
    const topReferrers = await usersCollection.aggregate([
        { $project: { user_id: 1, referralsCount: { $size: { $ifNull: ["$referrals", []] } } } },
        { $sort: { referralsCount: -1 } },
        { $limit: 20 }
    ]).toArray();

    let message = `📊 <b>Топ 20 рефереров</b>\n\n`;
    for (const user of topReferrers) {
        message += `👤 ${user.user_id}: ${user.referralsCount} рефералов\n`;
    }

    const totalUsers = await usersCollection.countDocuments();
    const usersWithReferrals = await usersCollection.countDocuments({ referrals: { $exists: true, $not: { $size: 0 } } });
    const totalReferrals = (await usersCollection.aggregate([
        { $project: { count: { $size: { $ifNull: ["$referrals", []] } } } },
        { $group: { _id: null, total: { $sum: "$count" } } }
    ]).toArray())[0]?.total || 0;

    message += `\n<b>Общая статистика:</b>\n`;
    message += `👥 Всего пользователей: ${totalUsers}\n`;
    message += `👤 Пользователей с рефералами: ${usersWithReferrals}\n`;
    message += `🔗 Всего рефералов: ${totalReferrals}\n`;
    message += `🎁 Пользователей со связкой УКР: ${await usersCollection.countDocuments({ hasUkBundle: true })}`;

    bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
});

// Проверка подключения к базе
bot.onText(/\/db_status/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;

    try {
        const db = await connect();
        const stats = await db.command({ dbStats: 1 });
        const emailCount = await (await emails()).countDocuments();
        const firstmailCount = await (await firstmails()).countDocuments();

        bot.sendMessage(msg.chat.id,
            `🛠️ <b>Статус базы данных</b>\n\n` +
            `✅ Подключение активно\n` +
            `📊 Размер базы: ${(stats.dataSize / 1024).toFixed(2)} KB\n` +
            `📧 Почтов в пуле: ${emailCount}\n` +
            `🔥 FIRSTMAIL в пуле: ${firstmailCount}\n` +
            `👥 Пользователей: ${await (await users()).countDocuments()}\n` +
            `🔗 Всего рефералов: ${(await (await users()).aggregate([
                { $project: { count: { $size: { $ifNull: ["$referrals", []] } } } },
                { $group: { _id: null, total: { $sum: "$count" } } }
            ]).toArray())[0]?.total || 0}`,
            { parse_mode: 'HTML' });
    } catch (e) {
        bot.sendMessage(msg.chat.id, `❌ Ошибка подключения: ${e.message}`);
    }
});

// Статистика пользователей
bot.onText(/\/user_stats/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;

    const usersCollection = await users();
    const totalUsers = await usersCollection.countDocuments();
    const activeUsers = await usersCollection.countDocuments({
        last_seen: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
    });

    bot.sendMessage(msg.chat.id,
        `📊 <b>Статистика пользователей</b>\n\n` +
        `👥 Всего пользователей: <b>${totalUsers}</b>\n` +
        `🟢 Активных за неделю: <b>${activeUsers}</b>\n` +
        `🔗 Пользователей с рефералами: <b>${await usersCollection.countDocuments({ referrals: { $exists: true, $not: { $size: 0 } } })}</b>\n\n` +
        `Последние 5 пользователей:`,
        { parse_mode: 'HTML' }
    );

    // Показываем последних 5 пользователей
    const recentUsers = await usersCollection.find()
        .sort({ first_seen: -1 })
        .limit(5)
        .toArray();

    for (const user of recentUsers) {
        const userInfo = [
            `👤 ID: <code>${user.user_id}</code>`,
            `🆔 @${user.username || 'нет'}`,
            `📅 Первый визит: ${user.first_seen.toLocaleString()}`,
            `🔄 Последний визит: ${user.last_seen?.toLocaleString() || 'никогда'}`,
            `🔗 Рефералов: ${user.referrals?.length || 0}`,
            `🎁 Связка УКР: ${user.hasUkBundle ? 'да' : 'нет'}`
        ].join('\n');

        await bot.sendMessage(msg.chat.id, userInfo, { parse_mode: 'HTML' });
    }
});

// Рассылка сообщений всем пользователям
bot.onText(/\/broadcast/, async (msg) => {
    if (!isAdmin(msg.from.id)) {
        return bot.sendMessage(msg.chat.id, '❌ Эта команда доступна только администраторам');
    }

    // Запрашиваем сообщение для рассылки
    const prompt = await bot.sendMessage(msg.chat.id, '📢 Отправьте сообщение для рассылки (текст, фото или видео с подписью):', {
        reply_markup: {
            force_reply: true
        }
    });

    // Ожидаем ответа от админа
    bot.onReplyToMessage(msg.chat.id, prompt.message_id, async (reply) => {
        const usersCollection = await users();
        const allUsers = await usersCollection.find({}).toArray();

        let successCount = 0;
        let failCount = 0;
        const startTime = Date.now();

        // Отправляем статистику о начале рассылки
        await bot.sendMessage(msg.chat.id, `⏳ Начинаем рассылку для ${allUsers.length} пользователей...`);

        // Рассылка в зависимости от типа контента
        if (reply.photo) {
            // Рассылка фото
            const photoId = reply.photo[reply.photo.length - 1].file_id;
            const caption = reply.caption || '';

            for (const user of allUsers) {
                try {
                    await bot.sendPhoto(user.user_id, photoId, {
                        caption: caption,
                        parse_mode: 'HTML'
                    });
                    successCount++;
                } catch (e) {
                    failCount++;
                }
                // Небольшая задержка между сообщениями
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        } else if (reply.text) {
            // Рассылка текста
            for (const user of allUsers) {
                try {
                    await bot.sendMessage(user.user_id, reply.text, {
                        parse_mode: 'HTML'
                    });
                    successCount++;
                } catch (e) {
                    failCount++;
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        } else if (reply.video) {
            // Рассылка видео
            const videoId = reply.video.file_id;
            const caption = reply.caption || '';

            for (const user of allUsers) {
                try {
                    await bot.sendVideo(user.user_id, videoId, {
                        caption: caption,
                        parse_mode: 'HTML'
                    });
                    successCount++;
                } catch (e) {
                    failCount++;
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        // Отправляем статистику о результатах
        const timeSpent = Math.round((Date.now() - startTime) / 1000);
        await bot.sendMessage(msg.chat.id,
            `📊 Рассылка завершена за ${timeSpent} сек.\n\n` +
            `✅ Успешно: ${successCount}\n` +
            `❌ Не удалось: ${failCount}\n` +
            `📌 Всего пользователей: ${allUsers.length}`);
    });
});

// Быстрая текстовая рассылка
bot.onText(/\/broadcast_text (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) {
        return bot.sendMessage(msg.chat.id, '❌ Эта команда доступна только администраторам');
    }

    const text = match[1];
    const usersCollection = await users();
    const allUsers = await usersCollection.find({}).toArray();

    let successCount = 0;
    let failCount = 0;
    const startTime = Date.now();

    await bot.sendMessage(msg.chat.id, `⏳ Начинаем текстовую рассылку для ${allUsers.length} пользователей...`);

    for (const user of allUsers) {
        try {
            await bot.sendMessage(user.user_id, text, {
                parse_mode: 'HTML'
            });
            successCount++;
        } catch (e) {
            failCount++;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    const timeSpent = Math.round((Date.now() - startTime) / 1000);
    await bot.sendMessage(msg.chat.id,
        `📊 Текстовая рассылка завершена за ${timeSpent} сек.\n\n` +
        `✅ Успешно: ${successCount}\n` +
        `❌ Не удалось: ${failCount}`);
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