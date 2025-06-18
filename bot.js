import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import express from 'express';
import config from './config.js';
import { connect, emails, users, firstmails, usaMails, ukrMails, gmailKeys } from './db.js';

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
// Было:
// const bot = new TelegramBot(config.telegramToken, {
//     polling: true // ← Конфликт с вебхуком
// });

// Стало:
const bot = new TelegramBot(config.telegramToken, {
    polling: {
        interval: 300, // Опционально: интервал опроса в мс
        autoStart: true // Автоматически стартовать polling
    }
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

// Было:
// app.post(`/webhook`, (req, res) => {
//     bot.processUpdate(req.body);
//     res.sendStatus(200);
// });

// Стало:
app.use(express.json());
app.get('/', (req, res) => {
    res.send('Бот работает в режиме polling!');
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
                usa_mails: [],
                ukr_mails: [],
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
    sendMainMenu(chatId, false, msg); // Pass msg object
});

// Главное меню с инлайн-кнопками
async function sendMainMenu(chatId, deletePrevious = false, msg = null) { // Add msg parameter
    const emailsCount = await (await emails()).countDocuments();
    const firstmailCount = await (await firstmails()).countDocuments();
    const usaMailCount = await (await usaMails()).countDocuments();
    const ukrMailCount = await (await ukrMails()).countDocuments();

    const usersCollection = await users();
    await usersCollection.updateOne(
        { user_id: chatId },
        {
            $setOnInsert: {
                user_id: chatId,
                username: msg?.from?.username || '', // Use optional chaining
                first_name: msg?.from?.first_name || '', // Use optional chaining
                last_name: msg?.from?.last_name || '', // Use optional chaining
                first_seen: new Date(),
                emails: [],
                firstmails: [],
                usa_mails: [],
                ukr_mails: [],
                referrals: [],
                invitedBy: null,
                hasDiscount: false,
                hasUkBundle: false,
                canGetUkBundle: false
            }
        },
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
        `• Купить аккаунты отлега 48+Ч USA/UKR FIRSTMAIL отлега (выдается как email:password:username:passwordacc)\n` +
        `• Скоро добавим еще разные почты и аккаунты\n` +
        `⚠️ Бот новый, возможны временные перебои\n\n` +
        `🎉 <b>ЧАСТО СКИДКИ, БОНУСЫ</b> часто связки, инфо поводы😱` + discountText;

    const options = {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: `📂 КАТЕГОРИИ 📂`, callback_data: 'categories' }],
                [{ text: '🛒 МОИ ПОКУПКИ 🛒', callback_data: 'my_purchases' }],
                [{ text: '🔗 РЕФЕРАЛКА 🔗', callback_data: 'referral' }],
                [{ text: '🇺🇦 СВЯЗКА 🇺🇦 ', callback_data: 'get_uk_bundle' }],
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
    const usaMailCount = await (await usaMails()).countDocuments();
    const ukrMailCount = await (await ukrMails()).countDocuments();
    const gmailKeyCount = await (await gmailKeys()).countDocuments();

    const text = `📂 <b>КАТЕГОРИИ</b>\n\n` +
        `В данном меню вы можете выбрать какие, почты или же аккаунты хотите купить\n\n`+
        `Оплата у нас CryptoBot - usdt\n\n`+
        `Удачных покупок, и удачного залива!\n\n`+
        `Выберите нужную категорию:`;

    const options = {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: `📧 ПОЧТЫ ICLOUD (${emailsCount}шт)`, callback_data: 'emails_category' }],
                [{ text: `🔥 FIRSTMAIL (${firstmailCount}шт)`, callback_data: 'firstmail_category' }],
                [{ text: '🤖 СОФТ TG PASING', callback_data: 'tg_pasing_category' }],
                [{ text: `🇺🇸 ПОЧТЫ USA FIRSTMAIL 🇺🇸 (${gmailKeyCount}шт)`, callback_data: 'gmail_key_category' }],
                [{ text: `🇺🇸 АККАУНТЫ FIRSTMAIL USA 48Ч (${usaMailCount}шт)`, callback_data: 'usa_mail_category' }],
                [{ text: `🇺🇦 АККАУНТЫ FIRSTMAIL UKR 48Ч (${ukrMailCount}шт)`, callback_data: 'ukr_mail_category' }],
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

// Меню TG PASING
// Меню TG PASING
async function sendTgPasingMenu(chatId) {
    const text = `🤖 <b>СОФТ TG PASING</b> 🤖

🔒 <b>Эксклюзив для Telegram-спамеров!</b>

💥 <b>Уникальный софт для пасинга Telegram-аккаунтов</b>
💰 <b>Цена:</b> <u>15 USDT</u>

После оплаты вы получите подробную инструкцию, как получить доступ и начать использовать софт.

<b>Преимущества:</b>
• Моментальная активация после оплаты
• Поддержка и обучение от автора
• Постоянные обновления
• Безопасно и легко в использовании

Выберите действие ниже 👇`;

    const options = {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '💰 КУПИТЬ TG PASING 💰', callback_data: 'buy_tg_pasing' }],
                [{ text: 'ℹ️ ФУНКЦИИ СОФТА ℹ️', callback_data: 'tg_pasing_info' }],
                [{ text: '🔙 Назад', callback_data: 'back_to_categories' }]
            ]
        }
    };

    return bot.sendMessage(chatId, text, options);
}

// Описание функций TG PASING
async function sendTgPasingInfo(chatId) {
    const text = `🤖 <b>ФУНКЦИИ TG PASING</b> 🤖

<b>Вас точно удивит этот софт! Вот что он умеет:</b>


1️⃣ <b>Добавляй сколько угодно аккаунтов для спама</b>
2️⃣ <b>Разнообразное крео для сообщений</b>
3️⃣ <b>Спам по личным сообщениям</b>
4️⃣ <b>Спам по группам</b>
5️⃣ <b>Автоматический сбор юзернеймов из групп</b> (больше не нужно делать это вручную!)
6️⃣ <b>Показывает, кому уже отправлял сообщения</b>
7️⃣ <b>Гибкая настройка под себя</b>
8️⃣ <b>Максимально простой и удобный интерфейс</b>
9️⃣ <b>Полное обучение по использованию</b>
🔟 <b>Прямая поддержка</b>
1️⃣1️⃣ <b>Видео-инструкции по работе с ботом</b>
1️⃣2️⃣ <b>Анти-блок: с одного аккаунта Telegram Premium можно писать до 60 человек в день</b> — спокойно и безопасно!
1️⃣3️⃣ <b>Постоянные обновления</b> (если будет время 😉)

⚠️ <b>Для работы софта нужен ноутбук или ПК!</b>

<b>Остались вопросы? Пиши в поддержку: <a href="https://t.me/igor_Potekov">@igor_Potekov</a></b>
`;

    return bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔙 Назад', callback_data: 'tg_pasing_category' }]
            ]
        }
    });
}

async function sendGmailKeyMenu(chatId) {
    const text = `
🔥 <b>🇺🇸 USA FIRSTMAIL LIMITED </b> 🔥

💎 <b>ЭКСКЛЮЗИВНЫЕ ПОЧТЫ:</b>
✔ Прямая регистрация в США
✔ Высокий уровень доверия
✔ Доступны только у избранных продавцов

🚀 <b>ЧЕМ ЛУЧШЕ ОБЫЧНЫХ FIRSTMAIL?</b>
✅ Меньше теневых банов
✅ Лучшая проходимость
✅ Стабильнее работа

💰 <b>ЦЕНА:</b> 8.5 рублей (0.11 USDT) за одну почту

📝 <b>ФОРМАТ:</b>
Почта | Пароль 

🔧 <b>ИНСТРУКЦИЯ ПО ПРОЛИВУ:</b>
!!!ТЕЛЕФОН ФУЛЛ НА СЩА СТАВИМ, И АППСТОР ТОЖЕ!!!
1️⃣ Удаляем TikTok (если был)
2️⃣ Сбрасываем GEO и сеть в телефоне
3️⃣ Скачиваем TikTok заново
4️⃣ Включаем VPN (USA Chicago)
5️⃣ Регистрируем аккаунт как обычно
6️⃣ Лайкаем 2 видео → проверяем в профиле
7️⃣ Выходим из аккаунта, закрываем TikTok
8️⃣ Переключаем VPN (снова Chicago)
9️⃣ Заходим в аккаунт → лайкаем 1 видео → проверяем
🔟 Закрываем TikTok
1️⃣1️⃣ Включаем VPN на нужное GEO
1️⃣2️⃣ Заливаем контент (БЕЗ ТЕГОВ!)


🛒 <b>ВЫБЕРИТЕ ДЕЙСТВИЕ:</b>
`;

    const options = {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '💰 КУПИТЬ ПОЧТЫ USA FIRSTMAIL 💰', callback_data: 'buy_gmail_key' }],
                [{ text: '🔙 Назад', callback_data: 'back_to_categories' }]
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

// Меню USA FIRSTMAIL
async function sendUsaMailMenu(chatId) {
    const usaMailCount = await (await usaMails()).countDocuments();

    const text = `🇺🇸 <b>АККАУНТЫ 48Ч ОТЛЕГИ FIRSTMAIL USA (${usaMailCount}шт)</b>\n\n` +
        `<b>В данном меню вы можете:</b>\n` +
        `✅ • Купить АККАУНТЫ 48Ч USA FIRSTMAIL отлега для спама\n\n` +
        `Цена: <b>10 рублей</b> или <b>0.13 USDT</b> за 1 почту\n\n` +
        `Выберите действие:`;

    const options = {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '💰 КУПИТЬ АККАУНТ 48Ч USA FIRSTMAIL 💰', callback_data: 'buy_usa_mail' }],
                [{ text: '🔙 Назад', callback_data: 'back_to_categories' }]
            ]
        }
    };

    return bot.sendMessage(chatId, text, options);
}

// Меню UKR FIRSTMAIL
async function sendUkrMailMenu(chatId) {
    const ukrMailCount = await (await ukrMails()).countDocuments();

    const text = `🇺🇦 <b>АККАУНТЫ 48Ч ОТЛЕГА FIRSTMAIL UKR (${ukrMailCount}шт)</b>\n\n` +
        `<b>В данном меню вы можете:</b>\n` +
        `✅ • Купить АККАУНТЫ 48Ч ОТЛЕГИ UKR FIRSTMAIL отлега для спама\n\n` +
        `Цена: <b>10 рублей</b> или <b>0.13 USDT</b> за 1 АККАУНТ\n\n` +
        `Выберите действие:`;

    const options = {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '💰 КУПИТЬ АККАУНТ 48Ч UKR FIRSTMAIL 💰', callback_data: 'buy_ukr_mail' }],
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

// Меню выбора количества почт USA FIRSTMAIL
async function sendUsaMailQuantityMenu(chatId) {
    const availableCount = await (await usaMails()).countDocuments();
    const maxAvailable = Math.min(availableCount, 10);

    const quantityButtons = [];
    for (let i = 1; i <= maxAvailable; i++) {
        quantityButtons.push({ text: `${i}`, callback_data: `usa_mail_quantity_${i}` });
    }

    const rows = [];
    for (let i = 0; i < quantityButtons.length; i += 5) {
        rows.push(quantityButtons.slice(i, i + 5));
    }
    rows.push([{ text: '🔙 Назад', callback_data: 'usa_mail_category' }]);

    const text = `📦 <b>Выберите количество АККАУНТОВ 48Ч USA FIRSTMAIL, которое хотите приобрести</b>\n\n` +
        `Доступно: <b>${maxAvailable}</b> почт\n` +
        `Цена: <b>10 Рублей</b> или <b>0.13 USDT</b> за 1 АККАУНТ`;

    const options = {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: rows
        }
    };

    return bot.sendMessage(chatId, text, options);
}

async function sendGmailKeyQuantityMenu(chatId) {
    const availableCount = await (await gmailKeys()).countDocuments();
    const maxAvailable = Math.min(availableCount, 10);

    const quantityButtons = [];
    for (let i = 1; i <= maxAvailable; i++) {
        quantityButtons.push({ text: `${i}`, callback_data: `gmail_key_quantity_${i}` });
    }

    const rows = [];
    for (let i = 0; i < quantityButtons.length; i += 5) {
        rows.push(quantityButtons.slice(i, i + 5));
    }
    rows.push([{ text: '🔙 Назад', callback_data: 'gmail_key_category' }]);

    const text = `📦 <b>Выберите количество почт USA FIRTSMAIL, которое хотите приобрести</b>\n\n` +
        `Доступно: <b>${maxAvailable}</b> аккаунтов\n` +
        `Цена: <b>0.10 USDT</b> за 1 почту`;

    const options = {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: rows
        }
    };

    return bot.sendMessage(chatId, text, options);
}

// Меню выбора количества почт UKR FIRSTMAIL
async function sendUkrMailQuantityMenu(chatId) {
    const availableCount = await (await ukrMails()).countDocuments();
    const maxAvailable = Math.min(availableCount, 10);

    const quantityButtons = [];
    for (let i = 1; i <= maxAvailable; i++) {
        quantityButtons.push({ text: `${i}`, callback_data: `ukr_mail_quantity_${i}` });
    }

    const rows = [];
    for (let i = 0; i < quantityButtons.length; i += 5) {
        rows.push(quantityButtons.slice(i, i + 5));
    }
    rows.push([{ text: '🔙 Назад', callback_data: 'ukr_mail_category' }]);

    const text = `📦 <b>Выберите количество АККАУНТОВ 48Ч UKR FIRSTMAIL, которое хотите приобрести</b>\n\n` +
        `Доступно: <b>${maxAvailable}</b> почт\n` +
        `Цена: <b>10 Рублей</b> или <b>0.13 USDT</b> за 1 АККАУНТ`;

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

async function sendGmailKeyPaymentMenu(chatId, invoiceUrl, quantity) {
    const totalAmount = (0.11 * quantity).toFixed(3);

    const text = `💳 <b>Оплата ${quantity} почт USA FIRSTMAIL</b>\n\n` +
        `Сумма: <b>${totalAmount} USDT</b>\n\n` +
        `Нажмите кнопку для оплаты:`;

    const options = {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '✅ ОПЛАТИТЬ ЧЕРЕЗ CRYPTOBOT', url: invoiceUrl }],
                [{ text: '🔙 Назад', callback_data: 'back_to_gmail_key_quantity_menu' }]
            ]
        }
    };

    return bot.sendMessage(chatId, text, options);
}

// Меню оплаты USA FIRSTMAIL
async function sendUsaMailPaymentMenu(chatId, invoiceUrl, quantity) {
    const totalAmount = (0.132 * quantity).toFixed(2);

    const text = `💳 <b>Оплата ${quantity} АККАУНТ-ОВ USA FIRSTMAIL</b>\n\n` +
        `Сумма: <b>${totalAmount} USDT</b>\n\n` +
        `Нажмите кнопку для оплаты:`;

    const options = {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '✅ ОПЛАТИТЬ ЧЕРЕЗ CRYPTOBOT', url: invoiceUrl }],
                [{ text: '🔙 Назад', callback_data: 'back_to_usa_mail_quantity_menu' }]
            ]
        }
    };

    return bot.sendMessage(chatId, text, options);
}

// Меню оплаты UKR FIRSTMAIL
async function sendUkrMailPaymentMenu(chatId, invoiceUrl, quantity) {
    const totalAmount = (0.132 * quantity).toFixed(2);

    const text = `💳 <b>Оплата ${quantity} АККАУНТ-ОВ UKR FIRSTMAIL</b>\n\n` +
        `Сумма: <b>${totalAmount} USDT</b>\n\n` +
        `Нажмите кнопку для оплаты:`;

    const options = {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '✅ ОПЛАТИТЬ ЧЕРЕЗ CRYPTOBOT', url: invoiceUrl }],
                [{ text: '🔙 Назад', callback_data: 'back_to_ukr_mail_quantity_menu' }]
            ]
        }
    };

    return bot.sendMessage(chatId, text, options);
}

// Создание инвойса для TG PASING
async function createTgPasingInvoice(userId) {
    try {
        const transactionId = `buy_tg_pasing_${userId}_${Date.now()}`;
        const amount = 15; // 15 USDT

        const response = await axios.post('https://pay.crypt.bot/api/createInvoice', {
            asset: 'USDT',
            amount: amount,
            description: `Покупка TG PASING`,
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

        // Сохраняем транзакцию
        const usersCollection = await users();
        await usersCollection.updateOne(
            { user_id: userId },
            {
                $set: {
                    [`tg_pasing_transaction`]: {
                        invoiceId: response.data.result.invoice_id,
                        status: 'pending',
                        timestamp: Date.now()
                    }
                }
            },
            { upsert: true }
        );

        return response.data.result.pay_url;
    } catch (err) {
        console.error('Ошибка при создании инвойса TG PASING:', err.response?.data || err.message);
        return null;
    }
}

// Меню оплаты TG PASING
async function sendTgPasingPaymentMenu(chatId, invoiceUrl) {
    const text = `💳 <b>Оплата софта TG PASING</b>\n\n` +
        `Сумма: <b>15 USDT</b>\n\n` +
        `Нажмите кнопку для оплаты:`;

    return bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '✅ ОПЛАТИТЬ ЧЕРЕЗ CRYPTOBOT', url: invoiceUrl }],
                [{ text: '🔙 Назад', callback_data: 'tg_pasing_category' }]
            ]
        }
    });
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

// Создание инвойса для// Создание инвойса для FIRSTMAIL
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
                        status: 'pending',                        timestamp: Date.now()
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

async function createGmailKeyInvoice(userId, quantity) {
    try {
        const transactionId = `buy_gmail_key_${userId}_${Date.now()}`;
        const amount = 0.11 * quantity;

        const response = await axios.post('https://pay.crypt.bot/api/createInvoice', {
            asset: 'USDT',
            amount: amount,
            description: `Покупка ${quantity} почт USA АFIRSTMAIL LIMITED`,
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
                $setOnInsert: { user_id: userId, gmail_keys: [] },
                $set: {
                    [`gmail_key_transactions.${transactionId}`]: {
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
        console.error('Ошибка при создании инвойса GMAIL KEY:', err.response?.data || err.message);
        return null;
    }
}

// Создание инвойса для USA FIRSTMAIL
async function createUsaMailInvoice(userId, quantity) {
    try {
        const transactionId = `buy_usa_mail_${userId}_${Date.now()}`;
        const amount = 0.132 * quantity;

        const response = await axios.post('https://pay.crypt.bot/api/createInvoice', {
            asset: 'USDT',
            amount: amount,
            description: `Покупка ${quantity} почт USA FIRSTMAIL`,
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
                $setOnInsert: { user_id: userId, usa_mails: [] },
                $set: {
                    [`usa_mail_transactions.${transactionId}`]: {
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
        console.error('Ошибка при создании инвойса USA FIRSTMAIL:', err.response?.data || err.message);
        return null;
    }
}

// Создание инвойса для UKR FIRSTMAIL
async function createUkrMailInvoice(userId, quantity) {
    try {
        const transactionId = `buy_ukr_mail_${userId}_${Date.now()}`;
        const amount = 0.132 * quantity;

        const response = await axios.post('https://pay.crypt.bot/api/createInvoice', {
            asset: 'USDT',
            amount: amount,
            description: `Покупка ${quantity} почт UKR FIRSTMAIL`,
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
                $setOnInsert: { user_id: userId, ukr_mails: [] },
                $set: {
                    [`ukr_mail_transactions.${transactionId}`]: {
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
        console.error('Ошибка при создании инвойса UKR FIRSTMAIL:', err.response?.data || err.message);
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

async function checkGmailKeyPayment(invoiceId) {
    try {
        const response = await axios.get(`https://pay.crypt.bot/api/getInvoices?invoice_ids=${invoiceId}`, {
            headers: {
                'Crypto-Pay-API-Token': CRYPTOBOT_API_TOKEN
            }
        });

        return response.data.result.items[0];
    } catch (err) {
        console.error('Ошибка при проверке оплаты GMAIL KEY:', err);
        return null;
    }
}

// Проверка оплаты USA FIRSTMAIL
async function checkUsaMailPayment(invoiceId) {
    try {
        const response = await axios.get(`https://pay.crypt.bot/api/getInvoices?invoice_ids=${invoiceId}`, {
            headers: {
                'Crypto-Pay-API-Token': CRYPTOBOT_API_TOKEN
            }
        });

        return response.data.result.items[0];
    } catch (err) {
        console.error('Ошибка при проверке оплаты USA FIRSTMAIL:', err);
        return null;
    }
}

// Проверка оплаты UKR FIRSTMAIL
async function checkUkrMailPayment(invoiceId) {
    try {
        const response = await axios.get(`https://pay.crypt.bot/api/getInvoices?invoice_ids=${invoiceId}`, {
            headers: {
                'Crypto-Pay-API-Token': CRYPTOBOT_API_TOKEN
            }
        });

        return response.data.result.items[0];
    } catch (err) {
        console.error('Ошибка при проверке оплаты UKR FIRSTMAIL:', err);
        return null;
    }
}

// Обработка успешной оплаты TG PASING
async function handleSuccessfulTgPasingPayment(userId) {
    const usersCollection = await users();
    const user = await usersCollection.findOne({ user_id: userId });
    if (!user || !user.tg_pasing_transaction) return false;

    await usersCollection.updateOne(
        { user_id: userId },
        { $set: { 'tg_pasing_transaction.status': 'completed' } }
    );

    await bot.sendMessage(userId,
        `🎉 <b>Спасибо за покупку TG PASING!</b>\n\n` +
        `Для получения доступа к софту напишите с скриншотом оплаты, или же если у вас бан от тг, ничего страшного 1 час и мы вам напишем!:\n` +
        `<a href="https://t.me/igor_Potekov">https://t.me/igor_Potekov</a>`, {
            parse_mode: 'HTML'
        });

    return true;
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
  // Получаем гарантированно только нужное количество почт и удаляем их атомарно
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

// Удаляем выданные почты атомарно по их _id
if (emailsToSell.length > 0) {
    const bulk = emailsToSell.map(e => ({
        deleteOne: { filter: { _id: e._id } }
    }));
    await emailsCollection.bulkWrite(bulk);
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

async function handleSuccessfulGmailKeyPayment(userId, transactionId) {
    const usersCollection = await users();
    const gmailKeysCollection = await gmailKeys();

    const user = await usersCollection.findOne({ user_id: userId });
    if (!user || !user.gmail_key_transactions || !user.gmail_key_transactions[transactionId]) {
        return false;
    }

    const quantity = user.gmail_key_transactions[transactionId].quantity;

    // Получаем аккаунты для продажи
    const gmailKeysToSell = await gmailKeysCollection.aggregate([
        { $sample: { size: quantity } }
    ]).toArray();

    if (gmailKeysToSell.length < quantity) {
        await usersCollection.updateOne(
            { user_id: userId },
            { $set: { [`gmail_key_transactions.${transactionId}.status`]: 'failed' } }
        );

        await bot.sendMessage(userId,
            `❌ Недостаточно аккаунтов USA FIRSTMAIL в пуле\nОбратитесь в поддержку @igor_Potekov`,
            { parse_mode: 'HTML' });
        return false;
    }

    await usersCollection.updateOne(
        { user_id: userId },
        {
            $push: { gmail_keys: { $each: gmailKeysToSell.map(e => e.raw) } },
            $set: {
                [`gmail_key_transactions.${transactionId}.status`]: 'completed',
                [`gmail_key_transactions.${transactionId}.accounts`]: gmailKeysToSell.map(e => e.raw)
            }
        }
    );

    // Удаляем выданные аккаунты
    await gmailKeysCollection.deleteMany({
        _id: { $in: gmailKeysToSell.map(e => e._id) }
    });

    await bot.sendMessage(userId,
        `🎉 Оплата подтверждена!\nВаши аккаунты:\n${gmailKeysToSell.map(e => e.raw).join('\n')}`,
        { parse_mode: 'HTML' });

    return true;
}

// Обработка успешной оплаты USA FIRSTMAIL
async function handleSuccessfulUsaMailPayment(userId, transactionId) {
    const usersCollection = await users();
    const usaMailsCollection = await usaMails();

    const user = await usersCollection.findOne({ user_id: userId });
    if (!user || !user.usa_mail_transactions || !user.usa_mail_transactions[transactionId]) {
        return false;
    }

    const quantity = user.usa_mail_transactions[transactionId].quantity;

    // Получаем почты для продажи
    const usaMailsToSell = await usaMailsCollection.aggregate([
        { $sample: { size: quantity } }
    ]).toArray();

    if (usaMailsToSell.length < quantity) {
        await usersCollection.updateOne(
            { user_id: userId },
            { $set: { [`usa_mail_transactions.${transactionId}.status`]: 'failed' } }
        );

        await bot.sendMessage(userId,
            `❌ Недостаточно почт USA FIRSTMAIL в пуле\nОбратитесь в поддержку @igor_Potekov`,
            { parse_mode: 'HTML' });
        return false;
    }

    // Обновляем данные пользователя
    await usersCollection.updateOne(
        { user_id: userId },
        {
            $push: { usa_mails: { $each: usaMailsToSell.map(e => `${e.email}:${e.password}`) } },
            $set: {
                [`usa_mail_transactions.${transactionId}.status`]: 'completed',
                [`usa_mail_transactions.${transactionId}.emails`]: usaMailsToSell.map(e => `${e.email}:${e.password}`)
            }
        }
    );

    // Удаляем проданные почты
    await usaMailsCollection.deleteMany({
        email: { $in: usaMailsToSell.map(e => e.email) }
    });

    await bot.sendMessage(userId,
        `🎉 Оплата подтверждена!\nВаши почты USA FIRSTMAIL:\n${usaMailsToSell.map(e => `${e.email}:${e.password}`).join('\n')}`,
        { parse_mode: 'HTML' });

    return true;
}

// Обработка успешной оплаты UKR FIRSTMAIL
async function handleSuccessfulUkrMailPayment(userId, transactionId) {
    const usersCollection = await users();
    const ukrMailsCollection = await ukrMails();

    const user = await usersCollection.findOne({ user_id: userId });
    if (!user || !user.ukr_mail_transactions || !user.ukr_mail_transactions[transactionId]) {
        return false;
    }

    const quantity = user.ukr_mail_transactions[transactionId].quantity;

    // Получаем почты для продажи
    const ukrMailsToSell = await ukrMailsCollection.aggregate([
        { $sample: { size: quantity } }
    ]).toArray();

    if (ukrMailsToSell.length < quantity) {
        await usersCollection.updateOne(
            { user_id: userId },
            { $set: { [`ukr_mail_transactions.${transactionId}.status`]: 'failed' } }
        );

        await bot.sendMessage(userId,
            `❌ Недостаточно почт UKR FIRSTMAIL в пуле\nОбратитесь в поддержку @igor_Potekov`,
            { parse_mode: 'HTML' });
        return false;
    }

    // Обновляем данные пользователя
    await usersCollection.updateOne(
        { user_id: userId },
        {
            $push: { ukr_mails: { $each: ukrMailsToSell.map(e => `${e.email}:${e.password}`) } },
            $set: {
                [`ukr_mail_transactions.${transactionId}.status`]: 'completed',
                [`ukr_mail_transactions.${transactionId}.emails`]: ukrMailsToSell.map(e => `${e.email}:${e.password}`)
            }
        }
    );

    // Удаляем проданные почты
    await ukrMailsCollection.deleteMany({
        email: { $in: ukrMailsToSell.map(e => e.email) }
    });

    await bot.sendMessage(userId,
        `🎉 Оплата подтверждена!\nВаши почты UKR FIRSTMAIL:\n${ukrMailsToSell.map(e => `${e.email}:${e.password}`).join('\n')}`,
        { parse_mode: 'HTML' });

    return true;
}

// Периодическая проверка оплаты с защитой от дублирования iCloud/FIRSTMAIL/USA/UKR
setInterval(async () => {
    try {
        const usersCollection = await users();

        // iCloud
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

        // Проверка оплаты TG PASING
async function checkTgPasingPayment(invoiceId) {
    try {
        const response = await axios.get(`https://pay.crypt.bot/api/getInvoices?invoice_ids=${invoiceId}`, {
            headers: {
                'Crypto-Pay-API-Token': CRYPTOBOT_API_TOKEN
            }
        });
        return response.data.result.items[0];
    } catch (err) {
        console.error('Ошибка при проверке оплаты TG PASING:', err);
        return null;
    }
}
// TG PASING
const usersWithTgPasing = await usersCollection.find({
    "tg_pasing_transaction": { $exists: true }
}).toArray();

for (const user of usersWithTgPasing) {
    const transaction = user.tg_pasing_transaction;
    if (transaction.status === 'pending' && transaction.invoiceId) {
        const invoice = await checkTgPasingPayment(transaction.invoiceId);
        if (invoice?.status === 'paid') {
            await handleSuccessfulTgPasingPayment(user.user_id);
        } else if (invoice?.status === 'expired') {
            await usersCollection.updateOne(
                { user_id: user.user_id },
                { $set: { 'tg_pasing_transaction.status': 'expired' } }
            );
        }
    }
}

// GMAIL KEY
const usersWithGmailKey = await usersCollection.find({
    "gmail_key_transactions": { $exists: true }
}).toArray();

for (const user of usersWithGmailKey) {
    for (const [transactionId, transaction] of Object.entries(user.gmail_key_transactions)) {
        if (transaction.status === 'pending' && transaction.invoiceId) {
            const invoice = await checkGmailKeyPayment(transaction.invoiceId);

            if (invoice?.status === 'paid') {
                await handleSuccessfulGmailKeyPayment(user.user_id, transactionId);
            } else if (invoice?.status === 'expired') {
                await usersCollection.updateOne(
                    { user_id: user.user_id },
                    { $set: { [`gmail_key_transactions.${transactionId}.status`]: 'expired' } }
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

        // USA FIRSTMAIL
        const usersWithUsaMail = await usersCollection.find({
            "usa_mail_transactions": { $exists: true }
        }).toArray();

        for (const user of usersWithUsaMail) {
            for (const [transactionId, transaction] of Object.entries(user.usa_mail_transactions)) {
                if (transaction.status === 'pending' && transaction.invoiceId) {
                    const invoice = await checkUsaMailPayment(transaction.invoiceId);

                    if (invoice?.status === 'paid') {
                        await handleSuccessfulUsaMailPayment(user.user_id, transactionId);
                    } else if (invoice?.status === 'expired') {
                        await usersCollection.updateOne(
                            { user_id: user.user_id },
                            { $set: { [`usa_mail_transactions.${transactionId}.status`]: 'expired' } }
                        );
                    }
                }
            }
        }

        // UKR FIRSTMAIL
        const usersWithUkrMail = await usersCollection.find({
            "ukr_mail_transactions": { $exists: true }
        }).toArray();

        for (const user of usersWithUkrMail) {
            for (const [transactionId, transaction] of Object.entries(user.ukr_mail_transactions)) {
                if (transaction.status === 'pending' && transaction.invoiceId) {
                    const invoice = await checkUkrMailPayment(transaction.invoiceId);

                    if (invoice?.status === 'paid') {
                        await handleSuccessfulUkrMailPayment(user.user_id, transactionId);
                    } else if (invoice?.status === 'expired') {
                        await usersCollection.updateOne(
                            { user_id: user.user_id },
                            { $set: { [`ukr_mail_transactions.${transactionId}.status`]: 'expired' } }
                        );
                    }
                }
            }
        }
    } catch (err) {
        console.error('Ошибка при проверке платежей:', err);
    }
}, 10000); // Проверяем каждые 10 секунд (было 20)

// Мои покупки (iCloud + FIRSTMAIL + USA + UKR)
async function sendMyPurchasesMenu(chatId) {
    const usersCollection = await users();
    const user = await usersCollection.findOne({ user_id: chatId });

    const hasIcloud = user && user.emails && user.emails.length > 0;
    const hasFirstmail = user && user.firstmails && user.firstmails.length > 0;
    const hasUsaMail = user && user.usa_mails && user.usa_mails.length > 0;
    const hasUkrMail = user && user.ukr_mails && user.ukr_mails.length > 0;
    const hasGmailKey = user && user.gmail_keys && user.gmail_keys.length > 0;

    const buttons = [];
    if (hasIcloud) buttons.push([{ text: '📧 Мои ICLOUD 📧', callback_data: 'my_iclouds' }]);
    if (hasGmailKey) buttons.push([{ text: '🇺🇸 Мои USA FIRSTMAIL 🇺🇸', callback_data: 'my_gmail_keys' }]);
    buttons.push([{ text: '🔙 Назад', callback_data: 'back_to_main' }]);

    if (!hasIcloud && !hasFirstmail && !hasUsaMail && !hasUkrMail) {
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
                reply_markup: {
                    inline_keyboard: [
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

async function sendMyGmailKeysMenu(chatId) {
    const usersCollection = await users();
    const user = await usersCollection.findOne({ user_id: chatId });

    if (!user || !user.gmail_keys || user.gmail_keys.length === 0) {
        return bot.sendMessage(chatId,
            `🔍 <b>У вас нет купленных почт</b>\n\n` +
            `📌 Чтобы получить доступ к эксклюзивным USA FIRSTMAIL аккаунтам:\n` +
            `➡️ Перейдите в раздел <b>🇺🇸 USA FIRSTMAIL</b>\n` +
            `💎 Доступны только качественные проверенные аккаунты`, {
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🛒 КУПИТЬ USA FIRSTMAIL', callback_data: 'buy_gmail_key' }],
                        [
                            { text: '📂 Категории', callback_data: 'categories' },
                            { text: '🔙 Назад', callback_data: 'back_to_main' }
                        ]
                    ]
                }
            });
    }

    const buttons = user.gmail_keys.map(acc => [{ text: acc.split('|')[0], callback_data: `gmail_key_show_${acc}` }]);
    buttons.push([{ text: '🔙 Назад', callback_data: 'back_to_main' }]);

    return bot.sendMessage(chatId, '🇺🇸 <b>Ваши USA FIRSTMAIL почты:</b> 🇺🇸', {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: buttons
        }
    });
}

// Мои USA FIRSTMAIL почты
async function sendMyUsaMailsMenu(chatId) {
    const usersCollection = await users();
    const user = await usersCollection.findOne({ user_id: chatId });

    if (!user || !user.usa_mails || user.usa_mails.length === 0) {
        return bot.sendMessage(chatId,
            '❌ У вас пока нет USA фирстмаилов.\n' +
            'Купите их в разделе USA FIRSTMAIL!', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📂 КАТЕГОРИИ 📂', callback_data: 'categories' }],
                        [{ text: '🔙 Назад', callback_data: 'back_to_main' }]
                    ]
                }
            });
    }

    const buttons = user.usa_mails.map(emailpass => [{ text: emailpass, callback_data: `usa_mail_show_${emailpass}` }]);
    buttons.push([{ text: '🔙 Назад', callback_data: 'back_to_main' }]);

    return bot.sendMessage(chatId, '🇺🇸 <b>Ваши USA FIRSTMAIL почты:</b> 🇺🇸', {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: buttons
        }
    });
}

// Мои UKR FIRSTMAIL почты
async function sendMyUkrMailsMenu(chatId) {
    const usersCollection = await users();
    const user = await usersCollection.findOne({ user_id: chatId });

    if (!user || !user.ukr_mails || user.ukr_mails.length === 0) {
        return bot.sendMessage(chatId,
            '❌ У вас пока нет UKR фирстмаилов.\n' +
            'Купите их в разделе UKR FIRSTMAIL!', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📂 КАТЕГОРИИ 📂', callback_data: 'categories' }],
                        [{ text: '🔙 Назад', callback_data: 'back_to_main' }]
                    ]
                }
            });
    }

    const buttons = user.ukr_mails.map(emailpass => [{ text: emailpass, callback_data: `ukr_mail_show_${emailpass}` }]);
    buttons.push([{ text: '🔙 Назад', callback_data: 'back_to_main' }]);

    return bot.sendMessage(chatId, '🇺🇦 <b>Ваши UKR FIRSTMAIL почты:</b> 🇺🇦', {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: buttons
        }
    });
}// Меню поддержки
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
}// Обработка callback-запросов
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

        // Открытие меню TG PASING
if (data === 'tg_pasing_category') {
    await bot.deleteMessage(chatId, callbackQuery.message.message_id);
    return sendTgPasingMenu(chatId);
}

// Описание функций TG PASING
if (data === 'tg_pasing_info') {
    await bot.deleteMessage(chatId, callbackQuery.message.message_id);
    return sendTgPasingInfo(chatId);
}

        // Категории
        if (data === 'categories') {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendCategoriesMenu(chatId);
        }

        if (data === 'buy_tg_pasing') {
            const invoiceUrl = await createTgPasingInvoice(chatId);
            if (!invoiceUrl) {
                return bot.answerCallbackQuery(callbackQuery.id, {
                    text: 'Ошибка при создании платежа. Попробуйте позже.',
                    show_alert: true
                });
            }
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            await sendTgPasingPaymentMenu(chatId, invoiceUrl);
            return bot.answerCallbackQuery(callbackQuery.id);
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

        if (data === 'gmail_key_category') {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendGmailKeyMenu(chatId);
        }

        // Категория FIRSTMAIL
        if (data === 'firstmail_category') {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendFirstmailMenu(chatId);
        }

        // Категория USA FIRSTMAIL
        if (data === 'usa_mail_category') {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendUsaMailMenu(chatId);
        }

        // Категория UKR FIRSTMAIL
        if (data === 'ukr_mail_category') {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendUkrMailMenu(chatId);
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

        // Назад к меню usa mail
        if (data === 'back_to_usa_mail_menu') {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendUsaMailMenu(chatId);
        }

        // Назад к меню ukr mail
        if (data === 'back_to_ukr_mail_menu') {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendUkrMailMenu(chatId);
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
        } // Купить usa mail
        if (data === 'buy_usa_mail') {
            const usaMailCount = await (await usaMails()).countDocuments();
            if (usaMailCount === 0) {
                return bot.answerCallbackQuery(callbackQuery.id, {
                    text: 'USA FIRSTMAIL почты временно закончились. Попробуйте позже.',
                    show_alert: true
                });
            }
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendUsaMailQuantityMenu(chatId);
        }

        if (data === 'buy_gmail_key') {
            const gmailKeyCount = await (await gmailKeys()).countDocuments();
            if (gmailKeyCount === 0) {
                return bot.answerCallbackQuery(callbackQuery.id, {
                    text: 'USA FIRSTMAIL аккаунты временно закончились. Попробуйте позже.',
                    show_alert: true
                });
            }
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendGmailKeyQuantityMenu(chatId);
        }

        // Купить ukr mail
        if (data === 'buy_ukr_mail') {
            const ukrMailCount = await (await ukrMails()).countDocuments();
            if (ukrMailCount === 0) {
                return bot.answerCallbackQuery(callbackQuery.id, {
                    text: 'UKR FIRSTMAIL почты временно закончились. Попробуйте позже.',
                    show_alert: true
                });
            }
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendUkrMailQuantityMenu(chatId);
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

        if (data.startsWith('gmail_key_quantity_')) {
            const quantity = parseInt(data.split('_')[3]);
            const invoiceUrl = await createGmailKeyInvoice(chatId, quantity);
        
            if (!invoiceUrl) {
                return bot.answerCallbackQuery(callbackQuery.id, {
                    text: 'Ошибка при создании платежа. Попробуйте позже.',
                    show_alert: true
                });
            }
        
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            await sendGmailKeyPaymentMenu(chatId, invoiceUrl, quantity);
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

        // Выбор количества usa mail
        if (data.startsWith('usa_mail_quantity_')) {
            const quantity = parseInt(data.split('_')[3]);
            const invoiceUrl = await createUsaMailInvoice(chatId, quantity);

            if (!invoiceUrl) {
                return bot.answerCallbackQuery(callbackQuery.id, {
                    text: 'Ошибка при создании платежа. Попробуйте позже.',
                    show_alert: true
                });
            }

            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            await sendUsaMailPaymentMenu(chatId, invoiceUrl, quantity);
            return bot.answerCallbackQuery(callbackQuery.id);
        }

        // Выбор количества ukr mail
        if (data.startsWith('ukr_mail_quantity_')) {
            const quantity = parseInt(data.split('_')[3]);
            const invoiceUrl = await createUkrMailInvoice(chatId, quantity);

            if (!invoiceUrl) {
                return bot.answerCallbackQuery(callbackQuery.id, {
                    text: 'Ошибка при создании платежа. Попробуйте позже.',
                    show_alert: true
                });
            }

            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            await sendUkrMailPaymentMenu(chatId, invoiceUrl, quantity);
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

        // Назад к выбору количества usa mail
        if (data === 'back_to_usa_mail_quantity_menu') {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendUsaMailQuantityMenu(chatId);
        }

        // Назад к выбору количества ukr mail
        if (data === 'back_to_ukr_mail_quantity_menu') {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendUkrMailQuantityMenu(chatId);
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

        // Мои usa mail
        if (data === 'my_usa_mails') {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendMyUsaMailsMenu(chatId);
        }

        // Мои ukr mail
        if (data === 'my_ukr_mails') {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendMyUkrMailsMenu(chatId);
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

        if (data === 'my_gmail_keys') {
            await bot.deleteMessage(chatId, callbackQuery.message.message_id);
            return sendMyGmailKeysMenu(chatId);
        }
        
        if (data.startsWith('gmail_key_show_')) {
            const acc = data.replace('gmail_key_show_', '');
            await bot.sendMessage(chatId,
                `🇺🇸 <b>Ваши USA FIRSTMAIL:</b>\n<code>${acc}</code>\n\nИспользуйте для ваших целей!`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔙 Назад', callback_data: 'my_gmail_keys' }]
                        ]
                    }
                }
            );
            return;
        }

        // Показываем выбранную usa mail
        if (data.startsWith('usa_mail_show_')) {
            const emailpass = data.replace('usa_mail_show_', '');
            await bot.sendMessage(chatId,
                `🇺🇸 <b>Ваша почта USA FIRSTMAIL:</b> <code>${emailpass}</code>\n\n` +
                `Используйте для ваших целей!`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔙 Назад', callback_data: 'my_usa_mails' }]
                        ]
                    }
                }
            );
            return;
        }

        // Показываем выбранную ukr mail
        if (data.startsWith('ukr_mail_show_')) {
            const emailpass = data.replace('ukr_mail_show_', '');
            await bot.sendMessage(chatId,
                `🇺🇦 <b>Ваша почта UKR FIRSTMAIL:</b> <code>${emailpass}</code>\n\n` +
                `Используйте для ваших целей!`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔙 Назад', callback_data: 'my_ukr_mails' }]
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
                firstmails: [],
                usa_mails: [],
                ukr_mails: [],
                referrals: [],
                invitedBy: null,
                hasDiscount: false,
                hasUkBundle: false,
                canGetUkBundle: false
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

// Добавление аккаунтов USA GMAIL KEY 24+H
bot.onText(/\/add_gmail (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;

    const gmailKeysCollection = await gmailKeys();
    const newGmailKeys = match[1].split(',').map(e => e.trim()).filter(e => e);

    // Формат: email|логин|пароль|US|KEY
    const toInsert = newGmailKeys.map(str => {
        const [email, login, password, country, key] = str.split('|');
        return {
            email: (email || '').trim(),
            login: (login || '').trim(),
            password: (password || '').trim(),
            country: (country || '').trim(),
            key: (key || '').trim(),
            raw: str.trim()
        };
    });

    const result = await gmailKeysCollection.insertMany(toInsert, { ordered: false });
    const count = await gmailKeysCollection.countDocuments();
    bot.sendMessage(msg.chat.id,
        `✅ Добавлено: ${result.insertedCount}\n🇺🇸 Всего USA FIRSTMAIL: ${count}`);
});

// Добавление почт USA FIRSTMAIL
// Добавление почт USA FIRSTMAIL
bot.onText(/\/add_usa (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;

    const usaMailsCollection = await usaMails();
    const newUsaMails = match[1].split(',').map(e => e.trim()).filter(e => e);

    // Для USA фирстмаил почт необходим формат типа "email:password:extra:info"
    const toInsert = newUsaMails.map(str => {
        const parts = str.split(':');
        const email = parts[0].trim();
        const password = parts.slice(1).join(':').trim(); // Join the rest as password
        return { email: email, password: password };
    });

    const result = await usaMailsCollection.insertMany(toInsert, { ordered: false });
    const count = await usaMailsCollection.countDocuments();
    bot.sendMessage(msg.chat.id,
        `✅ Добавлено: ${result.insertedCount}\n🇺🇸 Всего USA FIRSTMAIL: ${count}`);
});

// Добавление почт UKR FIRSTMAIL
bot.onText(/\/add_ukr (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;

    const ukrMailsCollection = await ukrMails();
    const newUkrMails = match[1].split(',').map(e => e.trim()).filter(e => e);

    // Для UKR фирстмаил почт необходим формат типа "email:password:extra:info"
    const toInsert = newUkrMails.map(str => {
        const parts = str.split(':');
        const email = parts[0].trim();
        const password = parts.slice(1).join(':').trim(); // Join the rest as password
        return { email: email, password: password };
    });

    const result = await ukrMailsCollection.insertMany(toInsert, { ordered: false });
    const count = await ukrMailsCollection.countDocuments();
    bot.sendMessage(msg.chat.id,
        `✅ Добавлено: ${result.insertedCount}\n🇺🇦 Всего UKR FIRSTMAIL: ${count}`);
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

// Статус пула USA FIRSTMAIL
bot.onText(/\/usa_status/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;

    const usaMailsCollection = await usaMails();
    const count = await usaMailsCollection.countDocuments();
    const first50 = await usaMailsCollection.find().limit(50).toArray();

    let message = `🇺🇸 Всего USA FIRSTMAIL: ${count}\n\n`;
    message += first50.map(e => `${e.email}:${e.password}`).join('\n');

    if (count > 200) message += '\n\n...и другие (показаны первые 200)';

    bot.sendMessage(msg.chat.id, message);
});

// Статус пула UKR FIRSTMAIL
bot.onText(/\/ukr_status/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;

    const ukrMailsCollection = await ukrMails();
    const count = await ukrMailsCollection.countDocuments();
    const first50 = await ukrMailsCollection.find().limit(50).toArray();

    let message = `🇺🇦 Всего UKR FIRSTMAIL: ${count}\n\n`;
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
        const usaMailCount = await (await usaMails()).countDocuments();
        const ukrMailCount = await (await ukrMails()).countDocuments();

        bot.sendMessage(msg.chat.id,
            `🛠️ <b>Статус базы данных</b>\n\n` +
            `✅ Подключение активно\n` +
            `📊 Размер базы: ${(stats.dataSize / 1024).toFixed(2)} KB\n` +
            `📧 Почтов в пуле: ${emailCount}\n` +
            `🔥 FIRSTMAIL в пуле: ${firstmailCount}\n` +
            `🇺🇸 USA FIRSTMAIL в пуле: ${usaMailCount}\n` +
            `🇺🇦 UKR FIRSTMAIL в пуле: ${ukrMailCount}\n` +
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

bot.onText(/\/gmail_status/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;

    const gmailKeysCollection = await gmailKeys();
    const count = await gmailKeysCollection.countDocuments();
    const first50 = await gmailKeysCollection.find().limit(50).toArray();

    let message = `🇺🇸 Всего USA USA FIRSTMAIL: ${count}\n\n`;
    message += first50.map(e => e.raw).join('\n');

    if (count > 200) message += '\n\n...и другие (показаны первые 200)';

    bot.sendMessage(msg.chat.id, message);
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

// Helper function to determine collection
function getCollectionForType(mailType) {
    switch (mailType) {
        case 'firstmail':
            return firstmails();
        case 'usa':
            return usaMails();
        case 'ukr':
            return ukrMails();
        default:
            throw new Error(`Unknown mail type: ${mailType}`);
    }
}

// Helper function to send my mails menu
async function sendMyMailsMenu(chatId, mailType) {
    const usersCollection = await users();
    const user = await usersCollection.findOne({ user_id: chatId });
    let mails;

    switch (mailType) {
        case 'firstmail':
            mails = user?.firstmails || [];
            break;
        case 'usa':
            mails = user?.usa_mails || [];
            break;
        case 'ukr':
            mails = user?.ukr_mails || [];
            break;
        default:
            return bot.sendMessage(chatId, '❌ Неизвестный тип почты');
    }

    if (!mails || mails.length === 0) {
        return bot.sendMessage(chatId, `❌ У вас пока нет ${mailType.toUpperCase()} почт.\nКупите их в соответствующем разделе!`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📂 КАТЕГОРИИ 📂', callback_data: 'categories' }],
                    [{ text: '🔙 Назад', callback_data: 'back_to_main' }]
                ]
            }
        });
    }

    const buttons = mails.map(emailpass => [{ text: emailpass, callback_data: `${mailType}_show_${emailpass}` }]);
    buttons.push([{ text: '🔙 Назад', callback_data: 'back_to_main' }]);

    let title;
    switch (mailType) {
        case 'firstmail':
            title = '🔥 Ваши FIRSTMAIL почты: 🔥';
            break;
        case 'usa':
            title = '🇺🇸 Ваши USA FIRSTMAIL почты: 🇺🇸';
            break;
        case 'ukr':
            title = '🇺🇦 Ваши UKR FIRSTMAIL почты: 🇺🇦';
            break;
        default:
            title = 'Ваши почты';
    }

    return bot.sendMessage(chatId, title, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: buttons
        }
    });
}

// Helper function to show selected mail
async function showSelectedMail(chatId, data, mailType) {
    const emailpass = data.replace(`${mailType}_show_`, '');
    await bot.sendMessage(chatId,
        `📧 <b>Ваша почта ${mailType.toUpperCase()}:</b> <code>${emailpass}</code>\n\n` +
        `Используйте для ваших целей!`,
        {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔙 Назад', callback_data: `my_${mailType}s` }]
                ]
            }
        }
    );
}

// Запуск сервера и бота (только для health-check)
console.log('Bot работает в режиме polling (DigitalOcean)');

app.listen(PORT, () => {
    console.log(`Сервер health-check запущен на порту ${PORT}`);
    console.log('💎 Бот успешно запущен и готов к работе!');
});
