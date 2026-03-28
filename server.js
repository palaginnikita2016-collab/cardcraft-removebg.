require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 3000;
const REMOVE_BG_API_KEY = process.env.REMOVE_BG_API_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'cardcraft_login_bot';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const SESSION_SECRET = process.env.SESSION_SECRET || TELEGRAM_BOT_TOKEN || 'cardcraft-dev-secret';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('Supabase secrets are missing. Auth and balances will not work until SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

function signSession(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(data)
    .digest('hex');
  return `${data}.${signature}`;
}

function readSession(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [data, signature] = token.split('.');
  const expected = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(data)
    .digest('hex');

  if (signature.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  } catch (_) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function setSessionCookie(res, payload) {
  const token = signSession(payload);
  res.cookie('cc_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    maxAge: 1000 * 60 * 60 * 24 * 30,
    path: '/'
  });
}

function clearSessionCookie(res) {
  res.clearCookie('cc_session', {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: '/'
  });
}

function normalizeTelegramAuthData(authData = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(authData || {})) {
    if (value === undefined || value === null || value === '') continue;
    normalized[key] = String(value);
  }
  return normalized;
}

function verifyTelegramAuth(authData) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN не задан в Render.');
  }

  const normalized = normalizeTelegramAuthData(authData);
  const hash = normalized.hash;
  delete normalized.hash;

  if (!hash || !normalized.id || !normalized.auth_date) {
    throw new Error('Неполные данные Telegram-логина.');
  }

  const dataCheckString = Object.keys(normalized)
    .sort()
    .map((key) => `${key}=${normalized[key]}`)
    .join('\n');

  const secretKey = crypto.createHash('sha256').update(TELEGRAM_BOT_TOKEN).digest();
  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (calculatedHash.length !== hash.length) {
    throw new Error('Неверная подпись Telegram.');
  }

  if (!crypto.timingSafeEqual(Buffer.from(calculatedHash), Buffer.from(hash))) {
    throw new Error('Неверная подпись Telegram.');
  }

  const authDate = Number(normalized.auth_date);
  if (!Number.isFinite(authDate)) {
    throw new Error('Неверная дата авторизации Telegram.');
  }

  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds > 60 * 60 * 24) {
    throw new Error('Данные Telegram устарели. Повтори вход ещё раз.');
  }

  return normalized;
}

async function ensureUserAndBalance(telegramUser) {
  const now = new Date().toISOString();

  const userPayload = {
    telegram_id: telegramUser.id,
    telegram_username: telegramUser.username || null,
    telegram_first_name: telegramUser.first_name || null,
    telegram_last_name: telegramUser.last_name || null,
    telegram_photo_url: telegramUser.photo_url || null,
    updated_at: now
  };

  const { data: user, error: userError } = await supabase
    .from('users')
    .upsert(userPayload, { onConflict: 'telegram_id' })
    .select('*')
    .single();

  if (userError) {
    throw new Error(`Не удалось сохранить пользователя: ${userError.message}`);
  }

  const { data: existingBalance, error: balanceError } = await supabase
    .from('balances')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  if (balanceError) {
    throw new Error(`Не удалось прочитать баланс: ${balanceError.message}`);
  }

  if (!existingBalance) {
    const { data: newBalance, error: createBalanceError } = await supabase
      .from('balances')
      .insert({
        user_id: user.id,
        card_credits: 0,
        bg_remove_credits: 0,
        free_cards_used: 0,
        updated_at: now
      })
      .select('*')
      .single();

    if (createBalanceError) {
      throw new Error(`Не удалось создать баланс: ${createBalanceError.message}`);
    }

    return { user, balance: newBalance };
  }

  return { user, balance: existingBalance };
}

async function getViewerFromRequest(req) {
  const session = readSession(req.cookies?.cc_session);
  if (!session?.telegram_id) return null;

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', String(session.telegram_id))
    .maybeSingle();

  if (userError || !user) return null;

  const { data: balance, error: balanceError } = await supabase
    .from('balances')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  if (balanceError) return null;

  return { user, balance };
}

async function requireViewer(req, res) {
  const viewer = await getViewerFromRequest(req);
  if (!viewer) {
    res.status(401).json({ error: 'Сначала войди через Telegram, чтобы сохранить остаток пакетов.' });
    return null;
  }
  return viewer;
}

async function spendCredit(viewer, type) {
  const now = new Date().toISOString();

  if (type === 'card') {
    if ((viewer.balance?.card_credits || 0) < 1) {
      throw new Error('Карточки закончились. Купи пакет или забери бесплатный старт.');
    }

    const nextCards = viewer.balance.card_credits - 1;
    const { data: updatedBalance, error: updateError } = await supabase
      .from('balances')
      .update({ card_credits: nextCards, updated_at: now })
      .eq('user_id', viewer.user.id)
      .select('*')
      .single();

    if (updateError) {
      throw new Error(`Не удалось списать карточку: ${updateError.message}`);
    }

    await supabase.from('usage_logs').insert({
      user_id: viewer.user.id,
      action_type: 'export_card',
      cards_spent: 1,
      bg_removes_spent: 0,
      note: 'Экспорт карточки'
    });

    return updatedBalance;
  }

  if (type === 'bg_remove') {
    if ((viewer.balance?.bg_remove_credits || 0) < 1) {
      throw new Error('AI-удаления фона закончились. Купи пакет с бонусными удалениями.');
    }

    const nextBg = viewer.balance.bg_remove_credits - 1;
    const { data: updatedBalance, error: updateError } = await supabase
      .from('balances')
      .update({ bg_remove_credits: nextBg, updated_at: now })
      .eq('user_id', viewer.user.id)
      .select('*')
      .single();

    if (updateError) {
      throw new Error(`Не удалось списать удаление фона: ${updateError.message}`);
    }

    await supabase.from('usage_logs').insert({
      user_id: viewer.user.id,
      action_type: 'remove_background',
      cards_spent: 0,
      bg_removes_spent: 1,
      note: 'AI-удаление фона'
    });

    return updatedBalance;
  }

  throw new Error('Неизвестный тип списания.');
}

app.get('/api/me', async (req, res) => {
  try {
    const viewer = await getViewerFromRequest(req);
    if (!viewer) {
      return res.json({ loggedIn: false, botUsername: TELEGRAM_BOT_USERNAME });
    }

    return res.json({
      loggedIn: true,
      botUsername: TELEGRAM_BOT_USERNAME,
      user: viewer.user,
      balance: viewer.balance
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Не удалось получить профиль.' });
  }
});

app.post('/api/auth/telegram', async (req, res) => {
  try {
    const authData = req.body?.authData;
    const telegramUser = verifyTelegramAuth(authData);
    const viewer = await ensureUserAndBalance(telegramUser);

    setSessionCookie(res, {
      telegram_id: viewer.user.telegram_id,
      user_id: viewer.user.id
    });

    return res.json({
      loggedIn: true,
      botUsername: TELEGRAM_BOT_USERNAME,
      user: viewer.user,
      balance: viewer.balance
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Не удалось войти через Telegram.' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  clearSessionCookie(res);
  return res.json({ ok: true });
});

app.post('/api/claim-free-start', async (req, res) => {
  try {
    const viewer = await requireViewer(req, res);
    if (!viewer) return;

    if ((viewer.balance?.free_cards_used || 0) > 0) {
      return res.status(400).json({ error: 'Бесплатный старт уже был начислен этому аккаунту.' });
    }

    const nextCards = (viewer.balance?.card_credits || 0) + 3;
    const { data: updatedBalance, error: updateError } = await supabase
      .from('balances')
      .update({
        card_credits: nextCards,
        free_cards_used: 1,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', viewer.user.id)
      .select('*')
      .single();

    if (updateError) {
      throw new Error(updateError.message);
    }

    await supabase.from('usage_logs').insert({
      user_id: viewer.user.id,
      action_type: 'claim_free_start',
      cards_spent: 0,
      bg_removes_spent: 0,
      note: 'Начислено 3 бесплатные карточки'
    });

    return res.json({
      loggedIn: true,
      botUsername: TELEGRAM_BOT_USERNAME,
      user: viewer.user,
      balance: updatedBalance
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Не удалось начислить бесплатный старт.' });
  }
});

app.post('/api/use-card-credit', async (req, res) => {
  try {
    const viewer = await requireViewer(req, res);
    if (!viewer) return;

    const balance = await spendCredit(viewer, 'card');
    return res.json({
      loggedIn: true,
      botUsername: TELEGRAM_BOT_USERNAME,
      user: viewer.user,
      balance
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Не удалось списать карточку.' });
  }
});

app.post('/api/remove-background', upload.single('image'), async (req, res) => {
  try {
    const viewer = await requireViewer(req, res);
    if (!viewer) return;

    if (!req.file) {
      return res.status(400).json({ error: 'Файл не загружен.' });
    }

    if (!REMOVE_BG_API_KEY) {
      return res.status(500).json({ error: 'Сначала добавь REMOVE_BG_API_KEY в переменные окружения Render.' });
    }

    if ((viewer.balance?.bg_remove_credits || 0) < 1) {
      return res.status(402).json({ error: 'AI-удаления фона закончились. Купи пакет с бонусными удалениями.' });
    }

    const form = new FormData();
    form.append('image_file', req.file.buffer, req.file.originalname || 'photo.png');
    form.append('size', 'auto');

    const response = await axios.post('https://api.remove.bg/v1.0/removebg', form, {
      headers: {
        ...form.getHeaders(),
        'X-API-Key': REMOVE_BG_API_KEY
      },
      responseType: 'arraybuffer',
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120000
    });

    await spendCredit(viewer, 'bg_remove');

    res.setHeader('Content-Type', response.headers['content-type'] || 'image/png');
    res.send(response.data);
  } catch (error) {
    if (res.headersSent) return;
    const apiMessage =
      error.response?.data
        ? Buffer.from(error.response.data).toString('utf-8')
        : '';

    return res.status(error.response?.status || 500).json({
      error: apiMessage || error.message || 'Ошибка remove.bg. Проверь API key, лимит и само изображение.'
    });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`CardCraft запущен: http://localhost:${PORT}`);
});
