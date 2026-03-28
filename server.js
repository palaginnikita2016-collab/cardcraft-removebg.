require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 3000;
const REMOVE_BG_API_KEY = process.env.REMOVE_BG_API_KEY || staS2STCJgLbYJfFZpVs61T4;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/remove-background', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не загружен.' });
    }

    if (!REMOVE_BG_API_KEY || REMOVE_BG_API_KEY === 'ВСТАВЬ_СЮДА_СВОЙ_REMOVE_BG_API_KEY') {
      return res.status(500).json({ error: 'Сначала вставь свой REMOVE_BG_API_KEY в переменные окружения или в server.js.' });
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

    res.setHeader('Content-Type', response.headers['content-type'] || 'image/png');
    res.send(response.data);
  } catch (error) {
    const apiMessage =
      error.response?.data
        ? Buffer.from(error.response.data).toString('utf-8')
        : '';

    return res.status(error.response?.status || 500).json({
      error: apiMessage || 'Ошибка remove.bg. Проверь API key, лимит и само изображение.'
    });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`CardCraft запущен: http://localhost:${PORT}`);
});
