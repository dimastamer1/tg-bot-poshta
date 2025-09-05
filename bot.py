import os
import re
import sys
import json
import logging
import time
import asyncio
from logging.handlers import RotatingFileHandler
from typing import Optional, Dict, Any
import requests
from urllib.parse import urlsplit, parse_qsl, urlencode, urlunsplit
from datetime import datetime
from dotenv import load_dotenv
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes, CallbackQueryHandler

# =====================[ НАСТРОЙКИ ]=====================
load_dotenv()

# Токены из .env
ANYMESSAGE_TOKEN = os.getenv("ANYMESSAGE_TOKEN")
TELEGRAM_TOKENN = os.getenv("TELEGRAM_TOKENN")

if not ANYMESSAGE_TOKEN:
    raise ValueError("ANYMESSAGE_TOKEN не указан в .env")
if not TELEGRAM_TOKENN:
    raise ValueError("TELEGRAM_TOKENN не указан в .env")

# Настройки AnyMessage - ПРАВИЛЬНЫЕ ЗНАЧЕНИЯ ДЛЯ TIKTOK
SITE_NAME: str = "tiktok"  # Попробуйте также: "tiktok_com", "tiktok_ok", "tiktok"
USE_CUSTOM_REGEX: bool = False
CUSTOM_REGEX: Optional[str] = None
REQUEST_PREVIEW_HTML: bool = True
TIMEOUT_SEC: int = 180
POLL_INTERVAL_SEC: int = 3

# Сетевые опции
HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AnyMessageClient/1.2"
}
PROXIES: Optional[Dict[str, str]] = None
VERIFY_SSL: bool = True

# Логирование
LOG_LEVEL = logging.INFO
LOG_FILE = "anymessage.log"
LOG_MAX_BYTES = 1_000_000
LOG_BACKUP_COUNT = 3

# Базовый URL
BASE_URL = "https://api.anymessage.shop"

# Паттерны
DEFAULT_REGEX_PATTERNS: Dict[str, str] = {
    "tiktok": r"\b(\d{6})\b",
    "instagram": r"\b(\d{6})\b", 
    "default": r"\b(\d{4,8})\b"
}

# ---------- ЛОГГЕР ----------
logger = logging.getLogger("anymessage")
logger.setLevel(LOG_LEVEL)
_fmt = logging.Formatter("%(asctime)s | %(levelname)s | %(name)s | %(message)s",
                         datefmt="%Y-%m-%d %H:%M:%S")
ch = logging.StreamHandler(sys.stdout)
ch.setFormatter(_fmt)
ch.setLevel(LOG_LEVEL)
fh = RotatingFileHandler(LOG_FILE, maxBytes=LOG_MAX_BYTES,
                         backupCount=LOG_BACKUP_COUNT, encoding="utf-8")
fh.setFormatter(_fmt)
fh.setLevel(LOG_LEVEL)
if not logger.handlers:
    logger.addHandler(ch)
    logger.addHandler(fh)

# ---------- КЛАСС ОШИБОК ----------
class AnyMessageError(Exception):
    pass

# ---------- ПОЛНАЯ РЕАЛИЗАЦИЯ ANYMESSAGE API ----------
def _get(url: str, params: Dict[str, Any]) -> Dict[str, Any]:
    try:
        r = requests.get(url, params=params, timeout=30,
                         headers=HEADERS, proxies=PROXIES, verify=VERIFY_SSL)
    except requests.exceptions.RequestException as e:
        logger.error(f"HTTP connect error: {e}")
        raise AnyMessageError(f"HTTP connect error: {e}") from e

    if r.status_code >= 400:
        snippet = r.text[:200].replace("\n", "\\n")
        logger.error(f"HTTP {r.status_code}; body[:200]={snippet!r}")
        raise AnyMessageError(f"HTTP {r.status_code}")

    try:
        return r.json()
    except requests.exceptions.JSONDecodeError:
        return {
            "status": "error",
            "message": r.text
        }

def get_available_sites() -> Optional[Dict[str, Any]]:
    """Получает список доступных сайтов"""
    try:
        data = _get(f"{BASE_URL}/email/services", {"token": ANYMESSAGE_TOKEN})
        return data
    except Exception as e:
        logger.error(f"Ошибка получения списка сайтов: {e}")
        return None

def reorder_activation(
    email: str,
    site: str = None,
    regex: Optional[str] = None,
    subject: Optional[str] = None,
) -> Dict[str, Any]:
    """Создает новую активацию с email и site"""
    
    # Попробуем разные варианты сайтов для TikTok
    possible_sites = [
        "tiktok_com", "tiktok_ok", "tiktok_", "tiktok123", "tiktok",
        "tiktok.com", "tiktok-ok", "tiktok123", "tiktok_api"
    ]
    
    for test_site in possible_sites:
        try:
            params: Dict[str, Any] = {
                "token": ANYMESSAGE_TOKEN,
                "email": email,
                "site": test_site
            }

            if regex:
                params["regex"] = regex
            if subject:
                params["subject"] = subject

            logger.info(f"Пробуем сайт: {test_site}")
            data = _get(f"{BASE_URL}/email/reorder", params)
            
            if data.get("status") == "success":
                logger.info(f"Успех с сайтом: {test_site}")
                return data
            else:
                logger.info(f"Сайт {test_site} не подошел: {data.get('value')}")
                
        except Exception as e:
            logger.error(f"Ошибка с сайтом {test_site}: {e}")
            continue
    
    # Если ни один сайт не подошел
    raise AnyMessageError("Ни один из вариантов сайтов не подошел для TikTok")

def get_message_once(activation_id: str, preview_html: bool = False) -> Dict[str, Any]:
    """Получает сообщение по activation_id"""
    params = {"token": ANYMESSAGE_TOKEN, "id": activation_id}
    if preview_html:
        params["preview"] = 1
    
    data = _get(f"{BASE_URL}/email/getmessage", params)
    
    # Логируем ответ для отладки
    logger.info(f"GetMessage response for {activation_id}: status={data.get('status')}, value={data.get('value')}")
    if data.get("message"):
        logger.info(f"Message length: {len(data.get('message', ''))} chars")
        # Логируем первые 200 символов сообщения для отладки
        message_preview = data.get('message', '')[:200]
        logger.info(f"Message preview: {message_preview}")
    
    return data

def extract_code_from_message(text_to_search: str) -> Optional[str]:
    """Улучшенная функция извлечения кода из HTML"""
    if not text_to_search:
        return None
    
    # 1. Сначала попробуем найти код в HTML (из вашего лога)
    # Ищем паттерн: <label id="m_-2480990675687449120code">819390</label>
    html_matches = re.findall(r'<label[^>]*id=[\'"][^\'"]*code[\'"][^>]*>(\d{4,8})</label>', text_to_search, re.IGNORECASE)
    if html_matches:
        logger.info(f"Найден код в HTML: {html_matches[0]}")
        return html_matches[0]
    
    # 2. Ищем код в JavaScript/переменных
    js_matches = re.findall(r'code[\'"]?\s*[:=]\s*[\'"]?(\d{4,8})[\'"]?', text_to_search, re.IGNORECASE)
    if js_matches:
        logger.info(f"Найден код в JS: {js_matches[0]}")
        return js_matches[0]
    
    # 3. Ищем код в тексте ссылок
    link_matches = re.findall(r'code=(\d{4,8})', text_to_search, re.IGNORECASE)
    if link_matches:
        logger.info(f"Найден код в ссылке: {link_matches[0]}")
        return link_matches[0]
    
    # 4. Обычный поиск 4-8 цифр
    matches = re.findall(r'\b(\d{4,8})\b', text_to_search)
    if matches:
        logger.info(f"Найден код обычным поиском: {matches[0]}")
        return matches[0]
    
    return None

def wait_for_code_sync(activation_id: str, timeout_sec: int = 120, poll_interval_sec: int = 5) -> Dict[str, Any]:
    """Ожидает код для активации (увеличено время ожидания)"""
    deadline = time.monotonic() + timeout_sec
    tries = 0

    while time.monotonic() < deadline:
        tries += 1
        try:
            data = get_message_once(activation_id, REQUEST_PREVIEW_HTML)
            status = data.get("status")
            plain_value = str(data.get("value") or "").strip()
            message_text = data.get("message") or ""

            logger.debug(f"Poll #{tries}: status={status}, value={plain_value}")

            if status == "error":
                if data.get("value") == "wait message":
                    logger.info("Ожидаем сообщение...")
                    time.sleep(poll_interval_sec)
                    continue
                else:
                    # Если это не ошибка "wait message", проверим есть ли код в сообщении
                    error_message = data.get("message", "")
                    code = extract_code_from_message(error_message)
                    if code:
                        logger.info(f"Найден код в ошибке: {code}")
                        return {
                            "code": code,
                            "raw_value": plain_value,
                            "message": error_message,
                            "api_payload": data,
                        }
                    raise AnyMessageError(f"API error: {data}")

            if status == "success":
                # Пробуем извлечь код
                code = None
                
                # Сначала из plain_value
                if plain_value and plain_value.isdigit() and 4 <= len(plain_value) <= 8:
                    code = plain_value
                    logger.info(f"Найден код в value: {code}")
                
                # Затем из message
                if not code and message_text:
                    code = extract_code_from_message(message_text)
                    if code:
                        logger.info(f"Найден код в message: {code}")
                
                if code:
                    return {
                        "code": code,
                        "raw_value": plain_value,
                        "message": message_text,
                        "api_payload": data,
                    }

            time.sleep(poll_interval_sec)
            
        except Exception as e:
            logger.error(f"Ошибка при опросе: {e}")
            time.sleep(poll_interval_sec)

    raise AnyMessageError(f"Timeout {timeout_sec}s while waiting for code")

def check_balance() -> Optional[Dict[str, Any]]:
    """Проверяет баланс"""
    try:
        data = _get(f"{BASE_URL}/user/balance", {"token": ANYMESSAGE_TOKEN})
        return data
    except AnyMessageError as e:
        logger.warning(f"Balance check failed: {e}")
        return None

# ---------- TELEGRAM BOT HANDLERS ----------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "👋 Привет! Отправь данные аккаунта в формате:\n"
        "email|phone|username|key|country\n\n"
        "Пример: velgapelsa@gmail.com|56349266006|velgajos7xo|e242573063696!|KZ\n\n"
        "После этого нажми кнопку '🔢 Получить код' для получения кода подтверждения TikTok."
    )

async def sites_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Команда для получения списка доступных сайтов"""
    try:
        sites_data = await asyncio.get_event_loop().run_in_executor(None, get_available_sites)
        
        if sites_data and sites_data.get("status") == "success":
            sites = sites_data.get("services", [])
            sites_list = "\n".join([f"• {site}" for site in sites])
            await update.message.reply_text(
                f"📋 Доступные сайты:\n\n{sites_list}\n\n"
                f"Текущий сайт: {SITE_NAME}"
            )
        else:
            await update.message.reply_text(
                f"❌ Не удалось получить список сайтов\n"
                f"Ответ: {json.dumps(sites_data, ensure_ascii=False) if sites_data else 'N/A'}"
            )
    except Exception as e:
        await update.message.reply_text(f"❌ Ошибка при получении списка сайтов: {e}")


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    text = update.message.text.strip()
    logger.info(f"Получено сообщение: {text}")

    # Парсим формат
    try:
        parts = text.split("|")
        if len(parts) != 5:
            raise ValueError("Неверное количество частей")
            
        email, phone, username, key, country = parts
        if not email or "@" not in email:
            raise ValueError("Неверный email")
        if not phone or not phone.isdigit():
            raise ValueError("Phone должен содержать только цифры")
            
    except ValueError as e:
        await update.message.reply_text(
            f"❌ Неверный формат: {e}\n\n"
            "✅ Правильный формат: email|phone|username|key|country\n"
            "📋 Пример: velgapelsa@gmail.com|56349266006|velgajos7xo|e242573063696!|KZ"
        )
        return

    # Сохраняем данные для callback
    context.user_data['account_data'] = {
        'email': email,
        'phone': phone,
        'username': username,
        'key': key,
        'country': country
    }
    
    # Создаем инлайн кнопку
    keyboard = [
        [InlineKeyboardButton("🔢 Получить код", callback_data=f"get_code_{email}")]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    
    await update.message.reply_text(
        f"✅ Данные приняты!\n\n"
        f"📧 Email: {email}\n"
        f"📱 Phone: {phone}\n"
        f"👤 Username: {username}\n"
        f"🗝️ Key: {key}\n"
        f"🇰🇿 Country: {country}\n\n"
        f"Нажми кнопку ниже чтобы получить код подтверждения:",
        reply_markup=reply_markup
    )

async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    
    if query.data.startswith("get_code_"):
        email = query.data.replace("get_code_", "")
        account_data = context.user_data.get('account_data', {})
        
        if not account_data or account_data.get('email') != email:
            await query.edit_message_text("❌ Данные не найдены. Отправьте формат снова.")
            return
        
        # Показываем "обработка"
        await query.edit_message_text(
            f"🔍 Создаем активацию для: {email}\nПожалуйста, подождите...",
            reply_markup=None
        )
        
        try:
            # 1. Сначала создаем активацию (reorder)
            logger.info(f"Создаем активацию для email: {email}, site: {SITE_NAME}")
            reorder_result = await asyncio.get_event_loop().run_in_executor(
    None, reorder_activation, email
)
            
            activation_id = reorder_result.get('id')
            if not activation_id:
                raise AnyMessageError(f"Не получили activation_id: {reorder_result}")
            
            logger.info(f"Активация создана: {activation_id}")
            
            # 2. Ждем код
            await query.edit_message_text(
                f"✅ Активация создана!\n"
                f"📧 Email: {email}\n"
                f"🆔 ID: {activation_id}\n\n"
                f"🔍 Ищем код...",
                reply_markup=None
            )
            
            result = await asyncio.get_event_loop().run_in_executor(
                None, wait_for_code_sync, activation_id
            )
            
            if result and result.get("code"):
                code = result["code"]
                await query.edit_message_text(
                    f"✅ Код найден!\n\n"
                    f"📧 Email: {email}\n"
                    f"🆔 ID: {activation_id}\n"
                    f"🔢 Код подтверждения: <code>{code}</code>\n\n"
                    f"💡 Используйте этот код для подтверждения аккаунта TikTok.",
                    parse_mode='HTML'
                )
            else:
                raise AnyMessageError("Код не найден в ответе")
                
        except AnyMessageError as e:
            error_msg = str(e)
            if "wait message" in error_msg.lower():
                keyboard = [
                    [InlineKeyboardButton("🔄 Попробовать снова", callback_data=f"get_code_{email}")]
                ]
                reply_markup = InlineKeyboardMarkup(keyboard)
                
                await query.edit_message_text(
                    f"⏳ Код еще не пришел\n\n"
                    f"📧 Email: {email}\n"
                    f"🕒 Подождите 10-20 секунд и нажмите кнопку 'Попробовать снова'\n"
                    f"📧 Письмо с кодом может идти несколько минут",
                    reply_markup=reply_markup
                )
            else:
                await query.edit_message_text(
                    f"❌ Ошибка: {error_msg}\n\n"
                    f"Попробуйте позже или обратитесь в поддержку"
                )
        except Exception as e:
            logger.error(f"Неожиданная ошибка: {e}")
            await query.edit_message_text(
                f"❌ Неожиданная ошибка: {str(e)[:100]}...\n"
                f"Попробуйте позже или обратитесь в поддержку"
            )

async def debug_api(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Команда для отладки API"""
    try:
        # Проверим разные возможные endpoints
        endpoints = [
            "/email/services",
            "/services",
            "/email/service/list",
            "/service/list"
        ]
        
        results = []
        for endpoint in endpoints:
            try:
                url = f"{BASE_URL}{endpoint}"
                params = {"token": ANYMESSAGE_TOKEN}
                
                response = requests.get(url, params=params, timeout=10, headers=HEADERS)
                data = response.json()
                results.append(f"{endpoint}: {data}")
            except Exception as e:
                results.append(f"{endpoint}: ERROR - {e}")
        
        await update.message.reply_text(
            f"🔍 Результаты проверки endpoints:\n\n" + "\n".join(results)
        )
        
    except Exception as e:
        await update.message.reply_text(f"❌ Ошибка отладки: {e}")

      

async def balance_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Команда для проверки баланса"""
    try:
        balance_data = await asyncio.get_event_loop().run_in_executor(None, check_balance)
        
        if balance_data and balance_data.get("status") == "success":
            await update.message.reply_text(
                f"💰 Баланс AnyMessage: {balance_data.get('balance', 'N/A')} USD"
            )
        else:
            await update.message.reply_text(
                f"❌ Не удалось получить баланс\n"
                f"Ответ: {json.dumps(balance_data, ensure_ascii=False) if balance_data else 'N/A'}"
            )
    except Exception as e:
        await update.message.reply_text(f"❌ Ошибка при проверке баланса: {e}")

def main() -> None:
    # Создаём приложение Telegram-бота
    application = Application.builder().token(TELEGRAM_TOKENN).build()

    # Добавляем обработчики
    # Добавьте обработчик
    application.add_handler(CommandHandler("debug", debug_api))      
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("balance", balance_command))
    application.add_handler(CommandHandler("sites", sites_command))  # Новая команда
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    application.add_handler(CallbackQueryHandler(handle_callback))

    # Запускаем бота
    logger.info("Запуск Telegram-бота с AnyMessage интеграцией...")
    print("Бот запущен! Ожидаем сообщения...")
    print(f"Используемый сайт: {SITE_NAME}")
    application.run_polling(allowed_updates=Update.ALL_TYPES)

if __name__ == "__main__":
    main()