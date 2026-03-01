const tg = window.Telegram.WebApp;
tg.expand();

let bibleData = null;
let currentBook = null;
let currentChapter = null;
let translations = [];
const bibleCache = {};

const elements = {
    booksList: document.getElementById('books-list'),
    chaptersGrid: document.getElementById('chapters-grid'),
    versesContent: document.getElementById('verses-content'),
    viewBooks: document.getElementById('view-books'),
    viewChapters: document.getElementById('view-chapters'),
    viewReader: document.getElementById('view-reader'),
    currentBookName: document.getElementById('current-book-name'),
    readerTitle: document.getElementById('reader-title'),
    loader: document.getElementById('loader'),
    searchInput: document.getElementById('search-input'),
    translationSelect: document.getElementById('translation-select'),
    readerTranslationSelect: document.getElementById('reader-translation-select'),
    appTitle: document.getElementById('app-title')
};

async function init() {
    const response = await fetch('translations.json');
    translations = await response.json();

    translations.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.label;
        elements.translationSelect.appendChild(opt);

        const opt2 = document.createElement('option');
        opt2.value = t.id;
        opt2.textContent = t.id.toUpperCase();
        elements.readerTranslationSelect.appendChild(opt2);
    });

    const saved = localStorage.getItem('bible-translation') || translations[0].id;
    elements.translationSelect.value = saved;

    await loadBible(saved);
}

async function loadBible(translationId) {
    const translation = translations.find(t => t.id === translationId);
    if (!translation) return;

    elements.appTitle.textContent = translation.id.toUpperCase();
    elements.translationSelect.value = translationId;
    elements.readerTranslationSelect.value = translationId;
    elements.loader.style.display = 'block';
    elements.viewBooks.style.display = 'none';

    if (bibleCache[translationId]) {
        bibleData = bibleCache[translationId];
    } else {
        try {
            const response = await fetch(translation.file);
            bibleData = await response.json();
            bibleCache[translationId] = bibleData;
        } catch (error) {
            elements.loader.innerText = 'Error al cargar la traducción.';
            console.error(error);
            return;
        }
    }

    elements.loader.style.display = 'none';

    const saved = JSON.parse(localStorage.getItem('bible-position'));
    if (saved && saved.translationId === translationId) {
        const book = bibleData.find(b => b.id === saved.bookId);
        if (book) {
            const chapter = book.chapters.find(c => c.n === saved.chapterN);
            if (chapter) {
                showReader(book, chapter);
                return;
            }
        }
    }

    switchView('books');
    renderBooks();
}

function renderBooks(filter = '') {
    elements.booksList.innerHTML = '';
    const filtered = bibleData.filter(b =>
        b.name.toLowerCase().includes(filter.toLowerCase())
    );

    filtered.forEach(book => {
        const li = document.createElement('li');
        li.innerText = book.name;
        li.onclick = () => showChapters(book);
        elements.booksList.appendChild(li);
    });
}

function showChapters(book) {
    currentBook = book;
    elements.currentBookName.innerText = book.name;
    elements.chaptersGrid.innerHTML = '';

    book.chapters.forEach(chap => {
        const btn = document.createElement('div');
        btn.className = 'chapter-btn';
        btn.innerText = chap.n;
        btn.onclick = () => showReader(book, chap);
        elements.chaptersGrid.appendChild(btn);
    });

    switchView('chapters');
}

function showReader(book, chapter) {
    currentBook = book;
    currentChapter = chapter;
    elements.readerTitle.innerText = `${book.name} ${chapter.n}`;
    elements.versesContent.innerHTML = '';

    chapter.v.forEach(v => {
        const p = document.createElement('div');
        p.className = 'verse';
        p.innerHTML = `<span class="v-num">${v.n}</span> ${v.t}`;
        elements.versesContent.appendChild(p);
    });

    const prevBtn = document.getElementById('prev-chap');
    const nextBtn = document.getElementById('next-chap');

    const chapIndex = book.chapters.findIndex(c => c.n === chapter.n);

    prevBtn.disabled = chapIndex === 0;
    nextBtn.disabled = chapIndex === book.chapters.length - 1;

    prevBtn.onclick = () => showReader(book, book.chapters[chapIndex - 1]);
    nextBtn.onclick = () => showReader(book, book.chapters[chapIndex + 1]);

    localStorage.setItem('bible-position', JSON.stringify({
        translationId: elements.translationSelect.value,
        bookId: book.id,
        chapterN: chapter.n
    }));

    switchView('reader');
    window.scrollTo(0, 0);
}

let touchStartX = 0;

document.getElementById('view-reader').addEventListener('touchstart', e => {
    touchStartX = e.changedTouches[0].clientX;
}, { passive: true });

document.getElementById('view-reader').addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) < 50) return;

    const prevBtn = document.getElementById('prev-chap');
    const nextBtn = document.getElementById('next-chap');
    const bookIndex = bibleData.findIndex(b => b.id === currentBook.id);

    if (dx > 0) {
        if (!prevBtn.disabled) {
            prevBtn.click();
        } else if (bookIndex > 0) {
            const prevBook = bibleData[bookIndex - 1];
            showReader(prevBook, prevBook.chapters[prevBook.chapters.length - 1]);
        }
    } else {
        if (!nextBtn.disabled) {
            nextBtn.click();
        } else if (bookIndex < bibleData.length - 1) {
            const nextBook = bibleData[bookIndex + 1];
            showReader(nextBook, nextBook.chapters[0]);
        }
    }
}, { passive: true });

function handleBack() {
    if (elements.viewReader.style.display === 'block') {
        switchView('chapters');
    } else if (elements.viewChapters.style.display === 'block') {
        switchView('books');
    }
}

function switchView(view) {
    elements.viewBooks.style.display = view === 'books' ? 'block' : 'none';
    elements.viewChapters.style.display = view === 'chapters' ? 'block' : 'none';
    elements.viewReader.style.display = view === 'reader' ? 'block' : 'none';

    document.querySelector('header').style.display = view === 'books' ? 'block' : 'none';

    if (tg.isVersionAtLeast('6.1')) {
        if (view === 'books') {
            tg.BackButton.hide();
        } else {
            tg.BackButton.show();
        }
    }
}

tg.BackButton.onClick(handleBack);

document.querySelectorAll('.back-btn').forEach(btn => {
    btn.onclick = handleBack;
});

document.getElementById('home-btn').onclick = () => {
    switchView('books');
};

elements.searchInput.oninput = (e) => {
    renderBooks(e.target.value);
};

elements.translationSelect.onchange = (e) => {
    const id = e.target.value;
    localStorage.setItem('bible-translation', id);
    elements.searchInput.value = '';
    loadBible(id);
};

elements.readerTranslationSelect.onchange = async (e) => {
    const id = e.target.value;
    const savedBook = currentBook;
    const savedChapter = currentChapter;
    localStorage.setItem('bible-translation', id);
    await loadBible(id);
    // Volver al mismo libro y capítulo en la nueva traducción
    const book = bibleData.find(b => b.id === savedBook.id);
    if (book) {
        const chapter = book.chapters.find(c => c.n === savedChapter.n) || book.chapters[0];
        showReader(book, chapter);
    }
};

init();
