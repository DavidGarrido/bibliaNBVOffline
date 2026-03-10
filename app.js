const tg = window.Telegram.WebApp;
tg.expand();

let bibleData = null;
let currentBook = null;
let currentChapter = null;
let translations = [];
const bibleCache = {};
let readingMode = localStorage.getItem('bible-reading-mode') || 'paged';
let chapterObserver = null;

// Estado del modo páginas
let currentPageNum = 0;
let totalPageCount = 0;
let pageHeight = 0;
let pageBreaks = []; // offsets en px donde empieza cada página

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
    appTitle: document.getElementById('app-title'),
    modeBtn: document.getElementById('mode-btn'),
    chapNav: document.querySelector('.chapter-navigation')
};

function updateModeBtn() {
    elements.modeBtn.textContent = readingMode === 'paged' ? '📄' : '📜';
    elements.modeBtn.title = readingMode === 'paged' ? 'Cambiar a modo continuo' : 'Cambiar a modo por capítulos';
}
updateModeBtn();

elements.modeBtn.onclick = () => {
    cleanupPageMode();
    readingMode = readingMode === 'paged' ? 'continuous' : 'paged';
    localStorage.setItem('bible-reading-mode', readingMode);
    updateModeBtn();
    if (currentBook && currentChapter) showReader(currentBook, currentChapter);
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

async function loadBible(translationId, restorePosition = true) {
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
    renderBooks();

    if (restorePosition) {
        const saved = JSON.parse(localStorage.getItem('bible-position'));
        if (saved && saved.bookId && saved.chapterN) {
            const book = bibleData.find(b => b.id === saved.bookId);
            if (book) {
                const chapter = book.chapters.find(c => c.n === saved.chapterN);
                if (chapter) {
                    showChapters(book);
                    showReader(book, chapter);
                    return;
                }
            }
        }
    }

    switchView('books');
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
    if (readingMode === 'continuous') {
        showReaderContinuous(book, chapter);
    } else {
        showReaderPaged(book, chapter);
    }
}

// ── Modo páginas ──────────────────────────────────────────────

function showReaderPaged(book, chapter) {
    if (chapterObserver) { chapterObserver.disconnect(); chapterObserver = null; }

    currentBook = book;
    currentChapter = chapter;
    elements.readerTitle.innerText = `${book.name} ${chapter.n}`;
    elements.versesContent.innerHTML = '';
    elements.chapNav.style.display = 'none';

    // Fase 1: renderizar en div oculto para medir alturas
    const measurer = document.createElement('div');
    measurer.style.visibility = 'hidden';
    chapter.v.forEach(v => {
        const p = document.createElement('div');
        p.className = 'verse';
        p.innerHTML = `<span class="v-num">${v.n}</span> ${v.t}`;
        measurer.appendChild(p);
    });
    elements.versesContent.appendChild(measurer);

    savePosition(book, chapter, {});
    switchView('reader');

    requestAnimationFrame(() => {
        const navH = document.querySelector('.reader-nav').offsetHeight;
        const mainPad = 32;
        pageHeight = window.innerHeight - navH - mainPad;
        const pageWidth = elements.versesContent.offsetWidth;

        elements.versesContent.classList.add('page-mode');
        elements.versesContent.style.height = pageHeight + 'px';

        // Fase 2: calcular cortes por índice de versículo
        const verseEls = [...measurer.querySelectorAll('.verse')];
        pageBreaks = [0];
        let pageStart = 0;
        for (let i = 0; i < verseEls.length; i++) {
            const verseBottom = verseEls[i].offsetTop + verseEls[i].offsetHeight;
            if (verseBottom - pageStart > pageHeight) {
                pageBreaks.push(i);
                pageStart = verseEls[i].offsetTop;
            }
        }
        totalPageCount = pageBreaks.length;
        elements.versesContent.innerHTML = '';

        // Fase 3: construir strip horizontal con una página por div
        const strip = document.createElement('div');
        strip.id = 'pages-strip';
        strip.style.cssText = `display:flex;width:${totalPageCount * pageWidth}px;height:${pageHeight}px`;

        for (let p = 0; p < totalPageCount; p++) {
            const startIdx = pageBreaks[p];
            const endIdx = p + 1 < totalPageCount ? pageBreaks[p + 1] : chapter.v.length;
            const pageDiv = document.createElement('div');
            pageDiv.style.cssText = `width:${pageWidth}px;height:${pageHeight}px;overflow:hidden;flex-shrink:0;box-sizing:border-box`;
            for (let i = startIdx; i < endIdx; i++) {
                const v = chapter.v[i];
                const el = document.createElement('div');
                el.className = 'verse';
                el.innerHTML = `<span class="v-num">${v.n}</span> ${v.t}`;
                pageDiv.appendChild(el);
            }
            strip.appendChild(pageDiv);
        }
        elements.versesContent.appendChild(strip);

        if (pendingPage !== null) {
            currentPageNum = pendingPage === -1 ? totalPageCount - 1 : Math.min(pendingPage, totalPageCount - 1);
            pendingPage = null;
        } else {
            const saved = JSON.parse(localStorage.getItem('bible-position'));
            currentPageNum = (saved && saved.bookId === book.id && saved.chapterN === chapter.n && saved.pageNum != null)
                ? Math.min(saved.pageNum, totalPageCount - 1) : 0;
        }

        // Si hay un verso pendiente de búsqueda, ir a su página
        if (pendingVerse) {
            const pages = [...strip.children];
            for (let p = 0; p < pages.length; p++) {
                if ([...pages[p].querySelectorAll('.v-num')].some(el => parseInt(el.textContent) === pendingVerse)) {
                    currentPageNum = p;
                    break;
                }
            }
            pendingVerse = null;
        }

        strip.style.transition = 'none';
        strip.style.transform = `translateX(-${currentPageNum * pageWidth}px)`;
        updatePageIndicator();
    });
}

function scrollToPage(pageNum) {
    currentPageNum = Math.max(0, Math.min(pageNum, totalPageCount - 1));
    const strip = document.getElementById('pages-strip');
    if (!strip) return;
    const pageWidth = elements.versesContent.offsetWidth;
    strip.style.transition = 'transform 0.3s ease';
    strip.style.transform = `translateX(-${currentPageNum * pageWidth}px)`;
    updatePageIndicator();
    const pos = JSON.parse(localStorage.getItem('bible-position'));
    if (pos) {
        pos.pageNum = currentPageNum;
        localStorage.setItem('bible-position', JSON.stringify(pos));
    }
}

function updatePageIndicator() {
    if (readingMode === 'paged') {
        elements.readerTitle.innerText = `${currentBook.name} ${currentChapter.n}`;
    } else {
        elements.readerTitle.innerText = `${currentBook.name} ${currentChapter.n}  ·  ${currentPageNum + 1}/${totalPageCount}`;
    }
}

function cleanupPageMode() {
    elements.versesContent.classList.remove('page-mode');
    elements.versesContent.style.height = '';
}

// ── Modo continuo ─────────────────────────────────────────────

function showReaderContinuous(book, chapter) {
    cleanupPageMode();
    currentBook = book;
    currentChapter = chapter;
    elements.readerTitle.innerText = `${book.name} ${chapter.n}`;
    elements.versesContent.innerHTML = '';
    elements.chapNav.style.display = 'none';

    book.chapters.forEach(chap => {
        const header = document.createElement('h3');
        header.className = 'chap-header';
        header.id = `chap-${chap.n}`;
        header.textContent = `Capítulo ${chap.n}`;
        elements.versesContent.appendChild(header);

        chap.v.forEach(v => {
            const p = document.createElement('div');
            p.className = 'verse';
            p.setAttribute('data-chap', chap.n);
            p.innerHTML = `<span class="v-num">${v.n}</span> ${v.t}`;
            elements.versesContent.appendChild(p);
        });
    });

    if (chapterObserver) chapterObserver.disconnect();
    chapterObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const chapN = parseInt(entry.target.id.replace('chap-', ''));
                const chap = book.chapters.find(c => c.n === chapN);
                if (chap) {
                    currentChapter = chap;
                    elements.readerTitle.innerText = `${book.name} ${chapN}`;
                    savePosition(book, chap, {});
                }
            }
        });
    }, { rootMargin: '-10% 0px -80% 0px' });

    elements.versesContent.querySelectorAll('.chap-header').forEach(h => chapterObserver.observe(h));

    switchView('reader');

    setTimeout(() => {
        const saved = JSON.parse(localStorage.getItem('bible-position'));
        const resolvedVerse = pendingVerse ? String(pendingVerse) : (saved && saved.bookId === book.id && saved.chapterN === chapter.n ? saved.verseN : null);
        pendingVerse = null;

        const targetEl = resolvedVerse
            ? [...elements.versesContent.querySelectorAll('.verse')]
                .find(el => el.querySelector('.v-num')?.textContent == savedVerseN)
            : document.getElementById(`chap-${chapter.n}`);

        if (targetEl) {
            const y = targetEl.getBoundingClientRect().top + window.scrollY;
            window.scrollTo({ top: y, behavior: 'instant' });
        }
    }, 80);
}

// ── Scroll (solo modo continuo) ───────────────────────────────

let lastScrollY = 0;
const readerNav = document.querySelector('.reader-nav');

let scrollDebounce = null;
window.addEventListener('scroll', () => {
    if (elements.viewReader.style.display !== 'block' || readingMode !== 'continuous') return;

    // Mostrar/ocultar nav según dirección de scroll
    const currentY = window.scrollY;
    if (currentY < lastScrollY - 5) {
        readerNav.classList.remove('nav-hidden');   // subiendo → mostrar
    } else if (currentY > lastScrollY + 10) {
        readerNav.classList.add('nav-hidden');       // bajando → ocultar
    }
    lastScrollY = currentY;
    clearTimeout(scrollDebounce);
    scrollDebounce = setTimeout(() => {
        const verses = elements.versesContent.querySelectorAll('.verse');
        for (const verse of verses) {
            if (verse.getBoundingClientRect().top >= 0) {
                const verseN = verse.querySelector('.v-num')?.textContent;
                if (verseN) {
                    const pos = JSON.parse(localStorage.getItem('bible-position'));
                    if (pos) {
                        pos.verseN = verseN;
                        pos.chapterN = parseInt(verse.getAttribute('data-chap')) || pos.chapterN;
                        localStorage.setItem('bible-position', JSON.stringify(pos));
                    }
                }
                break;
            }
        }
    }, 300);
}, { passive: true });

// ── Swipe ─────────────────────────────────────────────────────

let touchStartX = 0;
let touchStartY = 0;

document.getElementById('view-reader').addEventListener('touchstart', e => {
    touchStartX = e.changedTouches[0].clientX;
    touchStartY = e.changedTouches[0].clientY;
}, { passive: true });

document.getElementById('view-reader').addEventListener('touchend', e => {
    if (readingMode === 'continuous') return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;
    simulateSwipe(dx > 0 ? 'right' : 'left');
}, { passive: true });

// ── Teclado (PC) ─────────────────────────────────────────────

document.addEventListener('keydown', e => {
    if (elements.viewReader.style.display !== 'block') return;
    if (e.key === 'ArrowRight') simulateSwipe('left');
    if (e.key === 'ArrowLeft')  simulateSwipe('right');
});

function simulateSwipe(direction) {
    const bookIndex = bibleData.findIndex(b => b.id === currentBook.id);
    const chapIndex = currentBook.chapters.findIndex(c => c.n === currentChapter.n);

    if (direction === 'left') {
        if (readingMode === 'paged' && currentPageNum < totalPageCount - 1) {
            scrollToPage(currentPageNum + 1);
        } else if (chapIndex < currentBook.chapters.length - 1) {
            cleanupPageMode();
            showReader(currentBook, currentBook.chapters[chapIndex + 1]);
        } else if (bookIndex < bibleData.length - 1) {
            const nextBook = bibleData[bookIndex + 1];
            cleanupPageMode();
            showReader(nextBook, nextBook.chapters[0]);
        }
    } else {
        if (readingMode === 'paged' && currentPageNum > 0) {
            scrollToPage(currentPageNum - 1);
        } else if (chapIndex > 0) {
            cleanupPageMode();
            pendingPage = -1;
            showReader(currentBook, currentBook.chapters[chapIndex - 1]);
        } else if (bookIndex > 0) {
            const prevBook = bibleData[bookIndex - 1];
            cleanupPageMode();
            pendingPage = -1;
            showReader(prevBook, prevBook.chapters[prevBook.chapters.length - 1]);
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────

function savePosition(book, chapter, extra) {
    localStorage.setItem('bible-position', JSON.stringify({
        translationId: elements.translationSelect.value,
        bookId: book.id,
        chapterN: chapter.n,
        ...extra
    }));
}

function handleBack() {
    if (elements.viewReader.style.display === 'block') {
        cleanupPageMode();
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
    if (view === 'reader') { readerNav.classList.remove('nav-hidden'); lastScrollY = 0; }

    if (tg.isVersionAtLeast('6.1')) {
        view === 'books' ? tg.BackButton.hide() : tg.BackButton.show();
    }
}

tg.BackButton.onClick(handleBack);
document.querySelectorAll('.back-btn').forEach(btn => { btn.onclick = handleBack; });
document.getElementById('home-btn').onclick = () => { cleanupPageMode(); switchView('books'); };

elements.searchInput.oninput = (e) => renderBooks(e.target.value);

elements.translationSelect.onchange = (e) => {
    const id = e.target.value;
    localStorage.setItem('bible-translation', id);
    elements.searchInput.value = '';
    cleanupPageMode();
    loadBible(id, false);
};

elements.readerTranslationSelect.onchange = async (e) => {
    const id = e.target.value;
    const savedBook = currentBook;
    const savedChapter = currentChapter;
    localStorage.setItem('bible-translation', id);
    cleanupPageMode();
    await loadBible(id, false);
    const book = bibleData.find(b => b.id === savedBook.id);
    if (book) {
        const chapter = book.chapters.find(c => c.n === savedChapter.n) || book.chapters[0];
        showReader(book, chapter);
    }
};

async function checkVersion() {
  try {
    const res = await fetch('version.json');
    const { v } = await res.json();
    const stored = localStorage.getItem('app-version');
    if (stored !== null && stored !== v) {
      localStorage.setItem('app-version', v);
      const keys = await caches.keys();
      await Promise.all(
        keys.filter(k => !k.includes('json')).map(k => caches.delete(k))
      );
      window.location.reload();
      return false;
    }
    localStorage.setItem('app-version', v);
    const el = document.getElementById('app-version');
    if (el) el.textContent = `v${v}`;
  } catch (e) {
    const stored = localStorage.getItem('app-version');
    const el = document.getElementById('app-version');
    if (el && stored) el.textContent = `v${stored}`;
  }
  return true;
}

// ── Búsqueda Rápida ───────────────────────────────────────────

let qsActiveIdx = -1;
let qsSuggestions = [];
let pendingVerse = null;
let pendingPage = null;  // -1 = última página, N = página específica
let qsLastTappedTitle = null;

function normStr(s) {
    return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '').trim();
}

function findBooks(query) {
    const q = normStr(query);
    if (q.length < 1) return [];
    return (bibleData || []).filter(b => {
        const n = normStr(b.name);
        return n.startsWith(q) || n.includes(q);
    }).slice(0, 5);
}

function parseQuery(raw) {
    const text = raw.trim();
    if (!text) return null;

    // libro cap:verso1-verso2  o  libro cap verso1 verso2
    let m = text.match(/^(.+?)\s+(\d+)[:\s]+(\d+)[\s-]+(\d+)$/);
    if (m) {
        const books = findBooks(m[1]);
        if (books.length) {
            const v1 = parseInt(m[3]), v2 = parseInt(m[4]);
            return { type: 'range', books, chap: parseInt(m[2]),
                     verseStart: Math.min(v1, v2), verseEnd: Math.max(v1, v2) };
        }
    }

    // libro cap:verso  o  libro cap verso
    m = text.match(/^(.+?)\s+(\d+)[:\s]+(\d+)$/);
    if (m) {
        const books = findBooks(m[1]);
        if (books.length) return { type: 'verse', books, chap: parseInt(m[2]), verse: parseInt(m[3]) };
    }

    // libro cap
    m = text.match(/^(.+?)\s+(\d+)$/);
    if (m) {
        const books = findBooks(m[1]);
        if (books.length) return { type: 'chapter', books, chap: parseInt(m[2]) };
    }

    // solo libro
    const books = findBooks(text);
    if (books.length) return { type: 'book', books };

    return null;
}

function buildQsSuggestions(raw) {
    if (!raw.trim()) return [];
    const parsed = parseQuery(raw);
    if (!parsed) return [];
    const items = [];

    if (parsed.type === 'range') {
        parsed.books.forEach(book => {
            const chapObj = book.chapters.find(c => c.n === parsed.chap);
            if (!chapObj) return;
            const verses = chapObj.v.filter(v => v.n >= parsed.verseStart && v.n <= parsed.verseEnd);
            if (!verses.length) return;
            const rangeText = verses.map(v => `${v.n} ${v.t}`).join('\n');
            items.push({
                type: 'verse',
                icon: '📖',
                bookName: book.name,
                title: `${book.name} ${parsed.chap}:${parsed.verseStart}-${parsed.verseEnd}`,
                rangeText,
                action: () => {
                    pendingVerse = parsed.verseStart;
                    closeQS();
                    showChapters(book);
                    showReader(book, chapObj);
                }
            });
        });
    } else if (parsed.type === 'verse') {
        parsed.books.forEach(book => {
            const chapObj = book.chapters.find(c => c.n === parsed.chap);
            if (!chapObj) return;
            const verseObj = chapObj.v.find(v => v.n === parsed.verse);
            items.push({
                type: 'verse',
                icon: '📖',
                bookName: book.name,
                title: `${book.name} ${parsed.chap}:${parsed.verse}`,
                sub: verseObj ? verseObj.t.substring(0, 70) + '…' : 'Versículo no encontrado',
                action: () => {
                    pendingVerse = parsed.verse;
                    closeQS();
                    showChapters(book);
                    showReader(book, chapObj);
                }
            });
        });
    } else if (parsed.type === 'chapter') {
        parsed.books.forEach(book => {
            const chapObj = book.chapters.find(c => c.n === parsed.chap);
            if (!chapObj) return;
            items.push({
                type: 'chapter',
                icon: '📄',
                bookName: book.name,
                title: `${book.name} ${parsed.chap}`,
                sub: `Capítulo ${parsed.chap} · ${book.chapters.length} caps en total`,
                action: () => { closeQS(); showChapters(book); showReader(book, chapObj); }
            });
        });
        if (!items.length) {
            parsed.books.forEach(book => items.push({
                type: 'book',
                icon: '📚', bookName: book.name, title: book.name,
                sub: `Capítulo ${parsed.chap} no existe (${book.chapters.length} caps)`,
                action: () => { closeQS(); showChapters(book); }
            }));
        }
    } else {
        parsed.books.forEach(book => items.push({
            type: 'book',
            icon: '📚',
            bookName: book.name,
            title: book.name,
            sub: `${book.chapters.length} capítulos → ir al capítulo 1`,
            action: () => { closeQS(); showChapters(book); showReader(book, book.chapters[0]); }
        }));
    }

    return items.slice(0, 6);
}

function renderQS() {
    const input = document.getElementById('qs-input');
    const results = document.getElementById('qs-results');
    const hint = document.getElementById('qs-hint');
    qsSuggestions = buildQsSuggestions(input.value);
    qsActiveIdx = -1;
    qsLastTappedTitle = null;
    results.innerHTML = '';
    hint.style.display = qsSuggestions.length ? 'none' : 'block';

    qsSuggestions.forEach((item, i) => {
        const div = document.createElement('div');
        div.className = 'qs-item';
        div.innerHTML = `
            <span class="qs-item-icon">${item.icon}</span>
            <div class="qs-item-main">
                <div class="qs-item-title">${item.title}</div>
                ${item.rangeText
                    ? `<div class="qs-item-sub qs-item-range">${item.rangeText.replace(/\n/g, '<br>')}</div>`
                    : item.sub ? `<div class="qs-item-sub">${item.sub}</div>` : ''}
            </div>`;
        div.addEventListener('click', () => {
            if (item.type !== 'book') {
                // Capítulo o versículo: navegar directo con un solo toque
                item.action();
            } else if (qsLastTappedTitle === item.title) {
                // Segundo toque sobre el mismo libro: navegar
                qsLastTappedTitle = null;
                item.action();
            } else {
                // Primer toque sobre libro: completar nombre + espacio y posicionar cursor
                qsLastTappedTitle = item.title;
                qsActiveIdx = i;
                updateQsActive();
                input.value = item.bookName + ' ';
                input.focus();
                setTimeout(() => input.setSelectionRange(input.value.length, input.value.length), 0);
            }
        });
        results.appendChild(div);
    });
}

function updateQsActive() {
    document.querySelectorAll('.qs-item').forEach((el, i) =>
        el.classList.toggle('qs-active', i === qsActiveIdx));
}

function openQS() {
    const modal = document.getElementById('quick-search');
    const input = document.getElementById('qs-input');
    modal.classList.remove('qs-hidden');
    input.value = '';
    document.getElementById('qs-results').innerHTML = '';
    document.getElementById('qs-hint').style.display = 'block';
    setTimeout(() => input.focus(), 50);
}

function closeQS() {
    document.getElementById('quick-search').classList.add('qs-hidden');
}

document.getElementById('qs-input').addEventListener('input', renderQS);
document.getElementById('qs-overlay').addEventListener('click', closeQS);
document.getElementById('qs-open-btn').addEventListener('click', openQS);
document.getElementById('qs-reader-btn').addEventListener('click', openQS);

document.addEventListener('keydown', e => {
    // Abrir con / o Ctrl+K
    if ((e.key === '/' || (e.key === 'k' && (e.ctrlKey || e.metaKey))) &&
        !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
        e.preventDefault();
        openQS();
        return;
    }
    if (document.getElementById('quick-search').classList.contains('qs-hidden')) return;
    if (e.key === 'Escape') { closeQS(); return; }
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault();
        if (!qsSuggestions.length) return;
        qsActiveIdx = (qsActiveIdx + 1) % qsSuggestions.length;
        updateQsActive();
        document.getElementById('qs-input').value = qsSuggestions[qsActiveIdx].bookName;
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
        e.preventDefault();
        if (!qsSuggestions.length) return;
        qsActiveIdx = (qsActiveIdx - 1 + qsSuggestions.length) % qsSuggestions.length;
        updateQsActive();
        document.getElementById('qs-input').value = qsSuggestions[qsActiveIdx].bookName;
    } else if (e.key === 'Enter') {
        const target = qsActiveIdx >= 0 ? qsSuggestions[qsActiveIdx] : qsSuggestions[0];
        if (target) target.action();
    }
});

function hideSplash() {
    const splash = document.getElementById('splash');
    if (!splash) return;
    splash.classList.add('fade-out');
    setTimeout(() => splash.remove(), 650);
}

checkVersion().then(ok => {
    if (ok) {
        const minWait = new Promise(r => setTimeout(r, 1500));
        Promise.all([init(), minWait]).then(hideSplash);
    }
});
