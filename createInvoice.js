// createInvoice.js
import axios from 'axios';
import db from './db.js';

const CRYPTOBOT_API_TOKEN = '410439:AAM0NgXAGGfpTPnJJmrzdTAKhxtqiRqq1Ti';

export async function createInvoice(userId) {
  try {
    const payload = `buy_${userId}`;
    const response = await axios.post('https://pay.crypt.bot/api/createInvoice', {
      asset: 'USDT',
      amount: 1.00,
      description: 'Покупка почты iCloud',
      hidden_message: 'Спасибо за оплату!',
      paid_btn_name: 'openBot',
      paid_btn_url: 'https://t.me/Passingum_bot',
      payload
    }, {
      headers: {
        'Crypto-Pay-API-Token': "410439:AAM0NgXAGGfpTPnJJmrzdTAKhxtqiRqq1Ti",
        'Content-Type': 'application/json'
      }
    });

    await db.read();
    db.data.users ||= {};
    db.data.users[userId] = {
      paid: false,
      payload,
      pay_url: response.data.result.pay_url,
      invoice_id: response.data.result.invoice_id
    };
    await db.write();

    return response.data.result.pay_url;
  } catch (err) {
    console.error('Ошибка при создании инвойса:', err.response?.data || err.message);
    return null;
  }
}
