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

app.set('view engine', 'ejs');
app.set('views', path.resolve(process.cwd(), 'views'));
app.use(express.static(path.resolve(process.cwd(), 'public')));

const upload = multer({ storage: multer.memoryStorage() });

// Biến môi trường
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "123456";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const BOOKS_DIR = path.resolve(process.cwd(), 'public/books');

// Cấu hình giới hạn
const BASE_CHARS_PER_PAGE = 4000;
const BOOKS_PER_PAGE = 10;

// Hàm tạo slug từ tên truyện (Tự động sinh mã truyện)
function createSlug(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .replace(/([^0-9a-z-\s])/g, '')
    .replace(/(\s+)/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Hàm loại bỏ dấu tiếng Việt phục vụ tìm kiếm không dấu
function removeVietnameseTones(str) {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

// Hàm lấy tất cả danh sách truyện (Từ Supabase hoặc Thư mục Local)
async function getAllBooks() {
  let books = [];

  if (supabase) {
    const { data, error } = await supabase.storage.from('books').list();
    if (!error && data) {
      const txtFiles = data.filter(f => f.name.endsWith('.txt'));
      
      let titlesMap = {};
      try {
        const { data: metaData } = await supabase.storage.from('books').download('metadata.json');
        if (metaData) {
          titlesMap = JSON.parse(await metaData.text());
        }
      } catch (e) {}

      books = txtFiles.map(f => {
        const id = f.name.replace('.txt', '');
        return {
          id: id,
          title: titlesMap[id] || id.replace(/-/g, ' ')
        };
      });
    }
  } else if (fs.existsSync(BOOKS_DIR)) {
    const files = fs.readdirSync(BOOKS_DIR).filter(f => f.endsWith('.txt') && f !== 'metadata.json');
    let titlesMap = {};
    const metaPath = path.join(BOOKS_DIR, 'metadata.json');
    if (fs.existsSync(metaPath)) {
      try {
        titlesMap = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      } catch (e) {}
    }

    books = files.map(file => {
      const id = file.replace('.txt', '');
      return {
        id: id,
        title: titlesMap[id] || id.replace(/-/g, ' ')
      };
    });
  }

  return books;
}

// Thuật toán ngắt trang thông minh (Ưu tiên Dấu chấm -> Dấu phẩy -> Khoảng trắng)
function paginateTextSmart(content, targetPage) {
  const pages = [];
  let currentIndex = 0;
  const totalLength = content.length;

  while (currentIndex < totalLength) {
    let nextIndex = currentIndex + BASE_CHARS_PER_PAGE;

    if (nextIndex >= totalLength) {
      nextIndex = totalLength;
    } else {
      const searchChunk = content.substring(currentIndex, nextIndex);
      
      const lastSentenceEnd = Math.max(
        searchChunk.lastIndexOf('.'),
        searchChunk.lastIndexOf('?'),
        searchChunk.lastIndexOf('!')
      );

      const lastClauseEnd = Math.max(
        searchChunk.lastIndexOf(','),
        searchChunk.lastIndexOf(';')
      );

      const lastSpace = Math.max(
        searchChunk.lastIndexOf(' '),
        searchChunk.lastIndexOf('\n')
      );

      let breakPoint = -1;

      if (lastSentenceEnd !== -1 && lastSentenceEnd > BASE_CHARS_PER_PAGE - 500) {
        breakPoint = lastSentenceEnd + 1;
      } else if (lastClauseEnd !== -1 && lastClauseEnd > BASE_CHARS_PER_PAGE - 500) {
        breakPoint = lastClauseEnd + 1;
      } else if (lastSpace !== -1) {
        breakPoint = lastSpace + 1;
      }

      if (breakPoint > 0) {
        nextIndex = currentIndex + breakPoint;
      }
    }

    pages.push(content.substring(currentIndex, nextIndex));
    currentIndex = nextIndex;
  }

  const totalPages = pages.length || 1;
  const currentPage = Math.max(1, Math.min(targetPage, totalPages));
  const pageText = pages[currentPage - 1] || '';

  return { pageText, totalPages, currentPage };
}

// Helper render trang Admin kèm phân trang dữ liệu
async function renderAdminWithData(res, message, success, page = 1) {
  const allBooks = await getAllBooks();
  const totalBooks = allBooks.length;
  const totalPages = Math.ceil(totalBooks / BOOKS_PER_PAGE) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));
  const startIndex = (currentPage - 1) * BOOKS_PER_PAGE;
  const paginatedBooks = allBooks.slice(startIndex, startIndex + BOOKS_PER_PAGE);

  res.render('admin', {
    message,
    success,
    books: paginatedBooks,
    totalBooks,
    currentPage,
    totalPages
  });
}

// ------------------- DEFINITION ROUTES -------------------

// 1. Trang Chủ - Tìm kiếm & Phân trang
app.get('/', async (req, res) => {
  const query = req.query.q || '';
  const page = parseInt(req.query.page) || 1;

  let allBooks = await getAllBooks();

  if (query.trim()) {
    const cleanQuery = removeVietnameseTones(query);
    allBooks = allBooks.filter(b => 
      removeVietnameseTones(b.title).includes(cleanQuery)
    );
  }

  const totalBooks = allBooks.length;
  const totalPages = Math.ceil(totalBooks / BOOKS_PER_PAGE) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));
  const startIndex = (currentPage - 1) * BOOKS_PER_PAGE;
  const paginatedBooks = allBooks.slice(startIndex, startIndex + BOOKS_PER_PAGE);

  res.render('index', {
    books: paginatedBooks,
    query,
    currentPage,
    totalPages
  });
});

// 2. Trang Đọc Truyện
app.get('/read/:id', async (req, res) => {
  const bookId = req.params.id;
  const page = parseInt(req.query.page) || 1;
  let content = '';
  let bookTitle = bookId.replace(/-/g, ' ');

  try {
    const allBooks = await getAllBooks();
    const currentBook = allBooks.find(b => b.id === bookId);
    if (currentBook) bookTitle = currentBook.title;

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

  const { pageText, totalPages, currentPage } = paginateTextSmart(content, page);

  res.render('read', {
    title: bookTitle,
    bookId,
    text: pageText,
    currentPage,
    totalPages
  });
});

// 3. Trang Admin Dashboard
app.get('/admin', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  await renderAdminWithData(res, null, false, page);
});

// 4. Admin - Upload Truyện Mới (Tự động sinh mã truyện từ Tên truyện)
app.post('/admin/upload', upload.single('file'), async (req, res) => {
  const { adminPassword, displayTitle } = req.body;
  const file = req.file;

  if (adminPassword !== ADMIN_PASSWORD) {
    return await renderAdminWithData(res, 'Mật khẩu Admin không chính xác!', false);
  }

  if (!file || !displayTitle) {
    return await renderAdminWithData(res, 'Vui lòng nhập đầy đủ thông tin!', false);
  }

  // Tự động tạo mã truyện dạng slug
  const cleanBookId = createSlug(displayTitle) || `book-${Date.now()}`;
  const fileName = `${cleanBookId}.txt`;

  try {
    let titlesMap = {};
    if (supabase) {
      try {
        const { data: metaData } = await supabase.storage.from('books').download('metadata.json');
        if (metaData) titlesMap = JSON.parse(await metaData.text());
      } catch (e) {}

      titlesMap[cleanBookId] = displayTitle.trim();

      await supabase.storage.from('books').upload(fileName, file.buffer, {
        contentType: 'text/plain; charset=utf-8',
        upsert: true
      });

      await supabase.storage.from('books').upload('metadata.json', Buffer.from(JSON.stringify(titlesMap, null, 2)), {
        contentType: 'application/json',
        upsert: true
      });
    } else {
      if (!fs.existsSync(BOOKS_DIR)) {
        fs.mkdirSync(BOOKS_DIR, { recursive: true });
      }
      fs.writeFileSync(path.join(BOOKS_DIR, fileName), file.buffer);
      const metaPath = path.join(BOOKS_DIR, 'metadata.json');
      if (fs.existsSync(metaPath)) {
        try { titlesMap = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch (e) {}
      }
      titlesMap[cleanBookId] = displayTitle.trim();
      fs.writeFileSync(metaPath, JSON.stringify(titlesMap, null, 2));
    }

    await renderAdminWithData(res, `Tải lên thành công truyện: "${displayTitle}" (Mã: ${cleanBookId})`, true);
  } catch (err) {
    await renderAdminWithData(res, `Lỗi tải lên: ${err.message}`, false);
  }
});

// 5. Admin - Cập nhật/Chỉnh sửa Tên truyện & Mã truyện
app.post('/admin/update', async (req, res) => {
  const { adminPassword, oldBookId, newBookId, newDisplayTitle } = req.body;

  if (adminPassword !== ADMIN_PASSWORD) {
    return await renderAdminWithData(res, 'Mật khẩu Admin không chính xác!', false);
  }

  if (!oldBookId || !newDisplayTitle) {
    return await renderAdminWithData(res, 'Thông tin không hợp lệ!', false);
  }

  // Nếu người dùng không nhập mã mới, tự tạo slug theo tên mới
  const targetBookId = (newBookId && newBookId.trim()) 
    ? createSlug(newBookId) 
    : createSlug(newDisplayTitle);

  try {
    if (supabase) {
      let titlesMap = {};
      try {
        const { data: metaData } = await supabase.storage.from('books').download('metadata.json');
        if (metaData) titlesMap = JSON.parse(await metaData.text());
      } catch (e) {}

      // Nếu có đổi mã truyện, cần đổi tên file .txt tương ứng trên Supabase
      if (oldBookId !== targetBookId) {
        const { data: fileData, error: downloadErr } = await supabase.storage.from('books').download(`${oldBookId}.txt`);
        if (!downloadErr && fileData) {
          const contentBuffer = Buffer.from(await fileData.arrayBuffer());
          
          // Upload file mới với mã mới
          await supabase.storage.from('books').upload(`${targetBookId}.txt`, contentBuffer, {
            contentType: 'text/plain; charset=utf-8',
            upsert: true
          });
          
          // Xóa file cũ
          await supabase.storage.from('books').remove([`${oldBookId}.txt`]);
        }
        delete titlesMap[oldBookId];
      }

      titlesMap[targetBookId] = newDisplayTitle.trim();

      await supabase.storage.from('books').upload('metadata.json', Buffer.from(JSON.stringify(titlesMap, null, 2)), {
        contentType: 'application/json',
        upsert: true
      });

    } else {
      // Đổi tên file ở Local
      const oldFilePath = path.join(BOOKS_DIR, `${oldBookId}.txt`);
      const newFilePath = path.join(BOOKS_DIR, `${targetBookId}.txt`);

      if (oldBookId !== targetBookId && fs.existsSync(oldFilePath)) {
        fs.renameSync(oldFilePath, newFilePath);
      }

      const metaPath = path.join(BOOKS_DIR, 'metadata.json');
      let titlesMap = {};
      if (fs.existsSync(metaPath)) {
        try { titlesMap = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch (e) {}
      }

      if (oldBookId !== targetBookId) {
        delete titlesMap[oldBookId];
      }
      titlesMap[targetBookId] = newDisplayTitle.trim();

      fs.writeFileSync(metaPath, JSON.stringify(titlesMap, null, 2));
    }

    await renderAdminWithData(res, `Đã cập nhật thành công truyện!`, true);
  } catch (err) {
    await renderAdminWithData(res, `Lỗi khi cập nhật: ${err.message}`, false);
  }
});

// 6. Admin - Xóa Nhiều Truyện Cùng Lúc (Bulk Delete)
app.post('/admin/delete-multiple', async (req, res) => {
  const { adminPassword, bookIds } = req.body;

  if (adminPassword !== ADMIN_PASSWORD) {
    return await renderAdminWithData(res, 'Mật khẩu Admin không chính xác!', false);
  }

  const idsToDelete = Array.isArray(bookIds) ? bookIds : (bookIds ? [bookIds] : []);

  if (idsToDelete.length === 0) {
    return await renderAdminWithData(res, 'Vui lòng chọn ít nhất 1 truyện để xóa!', false);
  }

  try {
    if (supabase) {
      const filesToRemove = idsToDelete.map(id => `${id}.txt`);
      await supabase.storage.from('books').remove(filesToRemove);

      let titlesMap = {};
      try {
        const { data: metaData } = await supabase.storage.from('books').download('metadata.json');
        if (metaData) titlesMap = JSON.parse(await metaData.text());
      } catch (e) {}

      idsToDelete.forEach(id => delete titlesMap[id]);

      await supabase.storage.from('books').upload('metadata.json', Buffer.from(JSON.stringify(titlesMap, null, 2)), {
        contentType: 'application/json',
        upsert: true
      });
    } else {
      let titlesMap = {};
      const metaPath = path.join(BOOKS_DIR, 'metadata.json');
      if (fs.existsSync(metaPath)) {
        try { titlesMap = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch (e) {}
      }

      idsToDelete.forEach(id => {
        const filePath = path.join(BOOKS_DIR, `${id}.txt`);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        delete titlesMap[id];
      });

      if (fs.existsSync(metaPath)) {
        fs.writeFileSync(metaPath, JSON.stringify(titlesMap, null, 2));
      }
    }

    await renderAdminWithData(res, `Đã xóa thành công ${idsToDelete.length} truyện!`, true);
  } catch (err) {
    await renderAdminWithData(res, `Lỗi khi xóa: ${err.message}`, false);
  }
});

// Khởi chạy Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server đang chạy tại: http://localhost:${PORT}`));

module.exports = app;