const tg = window.Telegram.WebApp;
tg.expand();

let bibleData = null;
let currentBook = null;
let currentChapter = null;

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
    searchInput: document.getElementById('search-input')
};

async function loadBible() {
    try {
        const response = await fetch('bible.json');
        bibleData = await response.json();
        elements.loader.style.display = 'none';
        renderBooks();
    } catch (error) {
        elements.loader.innerText = 'Error al cargar la Biblia offline.';
        console.error(error);
    }
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

    // Configurar navegación de capítulos
    const prevBtn = document.getElementById('prev-chap');
    const nextBtn = document.getElementById('next-chap');
    
    const chapIndex = book.chapters.findIndex(c => c.n === chapter.n);
    
    prevBtn.disabled = chapIndex === 0;
    nextBtn.disabled = chapIndex === book.chapters.length - 1;
    
    prevBtn.onclick = () => showReader(book, book.chapters[chapIndex - 1]);
    nextBtn.onclick = () => showReader(book, book.chapters[chapIndex + 1]);

    switchView('reader');
    window.scrollTo(0, 0);
}

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
    
    // Configurar el botón de retroceso con seguridad de versión
    if (tg.isVersionAtLeast('6.1')) {
        if (view === 'books') {
            tg.BackButton.hide();
        } else {
            tg.BackButton.show();
        }
    }
}

if (tg.isVersionAtLeast('6.1')) {
    tg.BackButton.onClick(handleBack);
}

document.querySelectorAll('.back-btn').forEach(btn => {
    btn.onclick = handleBack;
});

elements.searchInput.oninput = (e) => {
    renderBooks(e.target.value);
};

// Inicializar
loadBible();
