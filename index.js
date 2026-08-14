if (process.env.NODE_ENV !== 'production') {
  try {
    require('dotenv').config();
  } catch (e) {}
}

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.urlencoded({ extended: true }));

// Thiết lập view engine và đường dẫn views chuẩn cho Vercel
app.set('view engine', 'ejs');
app.set('views', path.resolve(process.cwd(), 'views'));
app.use(express.static(path.resolve(process.cwd(), 'public')));

const upload = multer({ storage: multer.memoryStorage() });

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "123456";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const BOOKS_DIR = path.resolve(process.cwd(), 'public/books');
const CHARS_PER_PAGE = 2000;

// Chỉ kiểm tra folder local nếu chạy KHÔNG CÓ Supabase
if (!supabase) {
  try {
    if (!fs.existsSync(BOOKS_DIR)) {
      fs.mkdirSync(BOOKS_DIR, { recursive: true });
    }
  } catch (e) {}
}

// 1. Homepage
app.get('/', async (req, res) => {
  const query = (req.query.q || '').toLowerCase();
  let books = [];

  try {
    if (supabase) {
      const { data, error } = await supabase.storage.from('books').list();
      if (!error && data) {
        books = data.filter(f => f.name.endsWith('.txt')).map(f => ({
          id: f.name.replace('.txt', ''),
          title: f.name.replace('.txt', '').replace(/-/g, ' ')
        }));
      }
    } else if (fs.existsSync(BOOKS_DIR)) {
      const files = fs.readdirSync(BOOKS_DIR).filter(f => f.endsWith('.txt'));
      books = files.map(file => ({
        id: file.replace('.txt', ''),
        title: file.replace('.txt', '').replace(/-/g, ' ')
      }));
    }
  } catch (err) {
    console.error("Lỗi đọc danh sách:", err.message);
  }

  if (query) {
    books = books.filter(b => b.title.toLowerCase().includes(query));
  }

  res.render('index', { books, query });
});

// 2. Trang Doc Truyen
app.get('/read/:id', async (req, res) => {
  const bookId = req.params.id;
  const page = parseInt(req.query.page) || 1;
  let content = '';

  try {
    if (supabase) {
      const { data, error } = await supabase.storage.from('books').download(`${bookId}.txt`);
      if (error || !data) return res.send('Truyện không tồn tại! <a href="/">Về trang chủ</a>');
      content = await data.text();
    } else {
      const filePath = path.join(BOOKS_DIR, `${bookId}.txt`);
      if (!fs.existsSync(filePath)) return res.send('Truyện không tồn tại! <a href="/">Về trang chủ</a>');
      content = fs.readFileSync(filePath, 'utf-8');
    }
  } catch (err) {
    return res.send('Lỗi đọc truyện! <a href="/">Về trang chủ</a>');
  }

  const totalChars = content.length;
  const totalPages = Math.ceil(totalChars / CHARS_PER_PAGE) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));
  const start = (currentPage - 1) * CHARS_PER_PAGE;
  const pageText = content.substring(start, start + CHARS_PER_PAGE);

  res.render('read', {
    title: bookId.replace(/-/g, ' '),
    bookId,
    text: pageText,
    currentPage,
    totalPages
  });
});

// 3. Trang Admin
app.get('/admin', (req, res) => {
  res.render('admin', { message: null, success: false });
});

// 4. Upload Truyen
app.post('/admin/upload', upload.single('file'), async (req, res) => {
  const { adminPassword, bookId } = req.body;
  const file = req.file;

  if (adminPassword !== ADMIN_PASSWORD) {
    return res.render('admin', { message: 'Sai mật khẩu Admin!', success: false });
  }

  if (!file || !bookId) {
    return res.render('admin', { message: 'Vui lòng nhập đủ thông tin!', success: false });
  }

  const cleanBookId = bookId.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  const fileName = `${cleanBookId}.txt`;

  try {
    if (supabase) {
      const { error } = await supabase.storage.from('books').upload(fileName, file.buffer, {
        contentType: 'text/plain; charset=utf-8',
        upsert: true
      });
      if (error) throw error;
    } else {
      fs.writeFileSync(path.join(BOOKS_DIR, fileName), file.buffer);
    }

    res.render('admin', { message: `Upload thành công truyện: ${cleanBookId}`, success: true });
  } catch (err) {
    res.render('admin', { message: `Lỗi upload: ${err.message}`, success: false });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));

module.exports = app;