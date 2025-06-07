import axios from 'axios';
import config from './config.js';

const CRYPTOBOT_API_TOKEN = config.cryptoBotToken;

export async function checkPaymentStatus(invoiceId) {
  try {
    const response = await axios.get(`https://pay.crypt.bot/api/getInvoices?invoice_ids=${invoiceId}`, {
      headers: {
        'Crypto-Pay-API-Token': CRYPTOBOT_API_TOKEN
      }
    });
    
    return response.data.result.items[0]?.status === 'paid';
  } catch (err) {
    console.error('Ошибка при проверке оплаты:', err);
    return false;
  }
}

export async function createInvoice(userId) {
  try {
    const response = await axios.post('https://pay.crypt.bot/api/createInvoice', {
      asset: 'USDT',
      amount: 1.0,
      description: 'Покупка почты iCloud',
      hidden_message: 'Спасибо за оплату!',
      paid_btn_name: 'openBot',
      paid_btn_url: 'https://t.me/Passingum_bot',
      payload: `buy_${userId}`
    }, {
      headers: {
        'Crypto-Pay-API-Token': CRYPTOBOT_API_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    return {
      payUrl: response.data.result.pay_url,
      invoiceId: response.data.result.invoice_id
    };
  } catch (err) {
    console.error('Ошибка при создании инвойса:', err.response?.data || err.message);
    return null;
  }
}