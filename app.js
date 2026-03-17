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
    loader: document.getElementById('loader'),
    translationSelect: document.getElementById('translation-select'),
    readerTranslationSelect: document.getElementById('translation-select'), // unified
    appTitle: document.getElementById('tb-title'),
    currentBookName: document.getElementById('tb-title'),
    readerTitle: document.getElementById('tb-title'),
    chapNav: document.querySelector('.chapter-navigation')
};

function updateTopBar(view, data = {}) {
    const back = document.getElementById('tb-back');
    const title = document.getElementById('tb-title');

    if (view === 'books') {
        title.textContent = 'Biblia';
        back.classList.add('tb-hidden');
        back.onclick = null;
    } else if (view === 'chapters') {
        title.textContent = data.bookName || '';
        back.textContent = '⬅ Libros';
        back.classList.remove('tb-hidden');
        back.onclick = () => { cleanupPageMode(); switchView('books'); };
    } else if (view === 'reader') {
        title.textContent = data.title || '';
        back.textContent = '⬅ Cap.';
        back.classList.remove('tb-hidden');
        back.onclick = () => { cleanupPageMode(); showChapters(currentBook); };
    }
}

async function init() {
    const response = await fetch('translations.json');
    translations = await response.json();

    translations.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.id.toUpperCase();
        elements.translationSelect.appendChild(opt);
    });

    const saved = localStorage.getItem('bible-translation') || translations[0].id;
    elements.translationSelect.value = saved;

    await loadBible(saved);
}

async function loadBible(translationId, restorePosition = true) {
    const translation = translations.find(t => t.id === translationId);
    if (!translation) return;

    elements.translationSelect.value = translationId;
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

    if (restorePosition && localStorage.getItem('bible-restore-position') !== 'off') {
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
    elements.chaptersGrid.innerHTML = '';
    book.chapters.forEach(chap => {
        const btn = document.createElement('div');
        btn.className = 'chapter-btn';
        btn.innerText = chap.n;
        btn.onclick = () => showReader(book, chap);
        elements.chaptersGrid.appendChild(btn);
    });
    switchView('chapters');
    updateTopBar('chapters', { bookName: book.name });
}

function showReader(book, chapter) {
    clearVerseSelection();
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
    document.getElementById('tb-title').textContent = `${book.name} ${chapter.n}`;
    elements.versesContent.innerHTML = '';
    elements.chapNav.style.display = 'none';

    // Fase 1: renderizar en div oculto para medir alturas
    const measurer = document.createElement('div');
    measurer.style.visibility = 'hidden';
    chapter.v.forEach(v => {
        const p = document.createElement('div');
        p.className = 'verse';
        p.innerHTML = `<span class="v-num">${v.n}</span><span class="v-text"> ${v.t}</span>`;
        measurer.appendChild(p);
    });
    elements.versesContent.appendChild(measurer);

    savePosition(book, chapter, {});
    switchView('reader');

    requestAnimationFrame(() => {
        const mainEl = document.querySelector('main#content');
        const chapNavH = elements.chapNav ? elements.chapNav.offsetHeight : 0;
        const mainPad = parseInt(getComputedStyle(mainEl).paddingTop) * 2;
        pageHeight = mainEl.clientHeight - chapNavH - mainPad;
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
                el.innerHTML = `<span class="v-num">${v.n}</span><span class="v-text"> ${v.t}</span>`;
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
        let flashVerseN = null;
        let flashVerseEndN = null;
        if (pendingVerse) {
            flashVerseN = pendingVerse;
            flashVerseEndN = pendingVerseEnd;
            const pages = [...strip.children];
            for (let p = 0; p < pages.length; p++) {
                if ([...pages[p].querySelectorAll('.v-num')].some(el => parseInt(el.textContent) === pendingVerse)) {
                    currentPageNum = p;
                    break;
                }
            }
            pendingVerse = null;
            pendingVerseEnd = null;
            pendingChapterN = null;
        }

        strip.style.transition = 'none';
        strip.style.transform = `translateX(-${currentPageNum * pageWidth}px)`;
        updatePageIndicator();
        applyStudyMarkers(strip, chapter.n);

        if (flashVerseN !== null) {
            const page = strip.children[currentPageNum];
            if (page) flashVerseRange(page, chapter.n, flashVerseN, flashVerseEndN);
        }
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
        const strip = document.getElementById('pages-strip');
        const page = strip ? strip.children[currentPageNum] : null;
        let verseRange = '';
        if (page) {
            const vnums = [...page.querySelectorAll('.v-num')].map(el => parseInt(el.textContent)).filter(n => !isNaN(n));
            if (vnums.length) {
                const first = vnums[0];
                const last = vnums[vnums.length - 1];
                verseRange = first === last ? `  ·  ${currentChapter.n}:${first}` : `  ·  ${currentChapter.n}:${first}-${last}`;
            }
        }
        document.getElementById('tb-title').textContent = `${currentBook.name}${verseRange}`;
    } else {
        document.getElementById('tb-title').textContent = `${currentBook.name} ${currentChapter.n}  ·  ${currentPageNum + 1}/${totalPageCount}`;
    }
}

function flashVerse(el) {
    el.classList.remove('verse-flash');
    void el.offsetWidth;
    el.classList.add('verse-flash');
    el.addEventListener('animationend', () => el.classList.remove('verse-flash'), { once: true });
}

function flashVerseRange(container, chapN, verseN, verseEnd) {
    const end = verseEnd || verseN;
    [...container.querySelectorAll('.verse')].forEach(el => {
        if (el.getAttribute('data-chap') != null && el.getAttribute('data-chap') != String(chapN)) return;
        const n = parseInt(el.querySelector('.v-num')?.textContent);
        if (n >= verseN && n <= end) flashVerse(el);
    });
}

function cleanupPageMode() {
    elements.versesContent.classList.remove('page-mode');
    elements.versesContent.style.height = '';
    document.querySelector('main#content').classList.remove('continuous');
}

// ── Modo continuo ─────────────────────────────────────────────

function showReaderContinuous(book, chapter) {
    cleanupPageMode();
    document.querySelector('main#content').classList.add('continuous');
    currentBook = book;
    currentChapter = chapter;
    document.getElementById('tb-title').textContent = `${book.name} ${chapter.n}`;
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
            p.innerHTML = `<span class="v-num">${v.n}</span><span class="v-text"> ${v.t}</span>`;
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
                    document.getElementById('tb-title').textContent = `${book.name} ${chapN}`;
                    savePosition(book, chap, {});
                }
            }
        });
    }, { rootMargin: '-10% 0px -80% 0px' });

    elements.versesContent.querySelectorAll('.chap-header').forEach(h => chapterObserver.observe(h));
    applyStudyMarkers(elements.versesContent);

    switchView('reader');

    setTimeout(() => {
        const saved = JSON.parse(localStorage.getItem('bible-position'));
        const resolvedVerse = pendingVerse ? String(pendingVerse) : (saved && saved.bookId === book.id ? saved.verseN : null);
        const resolvedChap = pendingChapterN || (saved && saved.chapterN) || chapter.n;
        pendingVerse = null;
        pendingChapterN = null;

        const targetEl = resolvedVerse
            ? [...elements.versesContent.querySelectorAll('.verse')]
                .find(el => el.getAttribute('data-chap') == String(resolvedChap) && el.querySelector('.v-num')?.textContent == resolvedVerse)
            : document.getElementById(`chap-${chapter.n}`);

        if (targetEl) {
            const mainEl = document.querySelector('main#content');
            const y = targetEl.getBoundingClientRect().top - mainEl.getBoundingClientRect().top + mainEl.scrollTop;
            mainEl.scrollTo({ top: y, behavior: 'instant' });
            if (resolvedVerse) flashVerseRange(elements.versesContent, resolvedChap, parseInt(resolvedVerse), pendingVerseEnd);
            pendingVerseEnd = null;
        }
    }, 80);
}

// ── Scroll (solo modo continuo) ───────────────────────────────

let lastScrollY = 0;

let scrollDebounce = null;
document.querySelector('main#content').addEventListener('scroll', () => {
    if (elements.viewReader.style.display !== 'block' || readingMode !== 'continuous') return;

    const mainEl = document.querySelector('main#content');
    const currentY = mainEl.scrollTop;
    lastScrollY = currentY;
    clearTimeout(scrollDebounce);
    scrollDebounce = setTimeout(() => {
        const mainEl = document.querySelector('main#content');
        const mainTop = mainEl.getBoundingClientRect().top;
        const verses = elements.versesContent.querySelectorAll('.verse');
        for (const verse of verses) {
            if (verse.getBoundingClientRect().top >= mainTop) {
                const verseN = verse.querySelector('.v-num')?.textContent;
                const chapN = parseInt(verse.getAttribute('data-chap')) || currentChapter?.n;
                if (verseN && currentBook) {
                    document.getElementById('tb-title').textContent = `${currentBook.name} ${chapN}:${verseN}`;
                    const pos = JSON.parse(localStorage.getItem('bible-position'));
                    if (pos) {
                        pos.verseN = verseN;
                        pos.chapterN = chapN;
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
    if (view === 'books') { lastScrollY = 0; updateTopBar('books'); }
    // Diferir para que el display ya esté aplicado
    setTimeout(studyNavUpdate, 0);

    if (tg.isVersionAtLeast('6.1')) {
        view === 'books' ? tg.BackButton.hide() : tg.BackButton.show();
    }
}

tg.BackButton.onClick(handleBack);


elements.translationSelect.onchange = async (e) => {
    const id = e.target.value;
    localStorage.setItem('bible-translation', id);
    if (elements.viewReader.style.display === 'block' && currentBook && currentChapter) {
        // Cambio desde el lector: mantener posición
        const savedBook = currentBook;
        const savedChapter = currentChapter;
        cleanupPageMode();
        await loadBible(id, false);
        const book = bibleData.find(b => b.id == savedBook.id);
        if (book) {
            const chapter = book.chapters.find(c => c.n == savedChapter.n) || book.chapters[0];
            showReader(book, chapter);
        }
    } else {
        cleanupPageMode();
        loadBible(id, false);
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
let pendingVerseEnd = null;
let pendingChapterN = null;
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
                verseData: verses.length ? { ref: `${book.name} ${parsed.chap}:${parsed.verseStart}-${parsed.verseEnd}`, bookId: book.id, chapN: parsed.chap, verseN: parsed.verseStart, verseEnd: parsed.verseEnd, text: verses.map(v => `${v.n} ${v.t}`).join(' ') } : null,
                action: () => {
                    const fv = verses[0];
                    if (fv && studiesState && localStorage.getItem('bible-autosave-verse') === 'on') {
                        const ref = `${book.name} ${parsed.chap}:${fv.n}`;
                        const tid = elements.translationSelect.value;
                        if (!isVerseAlreadySaved(ref, tid)) {
                            const activeStudy = studiesGetActive(studiesState);
                            studiesState = studiesAddEntry(studiesState, activeStudy.id, { type: 'verse', ref, bookId: book.id, chapN: parsed.chap, verseN: fv.n, text: fv.t, translationId: tid, note: '' });
                            studiesSave(studiesState);
                            showSaveToast('Guardado ✓');
                        }
                    }
                    pendingVerse = parsed.verseStart;
                    pendingChapterN = parsed.chap;
                    closeQS();
                    showChapters(book);
                    showReader(book, chapObj);
                }
            });
        });
    } else if (parsed.type === 'verse') {
        parsed.books.forEach(book => {
            const chapObj = book.chapters.find(c => c.n == parsed.chap);
            if (!chapObj) return;
            const verseObj = chapObj.v.find(v => v.n == parsed.verse);
            items.push({
                type: 'verse',
                icon: '📖',
                bookName: book.name,
                title: `${book.name} ${parsed.chap}:${parsed.verse}`,
                sub: verseObj ? verseObj.t : 'Versículo no encontrado',
                verseData: verseObj ? { ref: `${book.name} ${parsed.chap}:${parsed.verse}`, bookId: book.id, chapN: parsed.chap, verseN: parsed.verse, text: verseObj.t } : null,
                action: () => {
                    const ref = `${book.name} ${parsed.chap}:${parsed.verse}`;
                    const tid = elements.translationSelect.value;
                    if (studiesState && localStorage.getItem('bible-autosave-verse') === 'on' && !isVerseAlreadySaved(ref, tid)) {
                        const verseText = verseObj ? verseObj.t : (chapObj.v.find(v => v.n == parsed.verse) || {}).t || '';
                        const activeStudy = studiesGetActive(studiesState);
                        studiesState = studiesAddEntry(studiesState, activeStudy.id, { type: 'verse', ref, bookId: book.id, chapN: parsed.chap, verseN: parsed.verse, text: verseText, translationId: tid, note: '' });
                        studiesSave(studiesState);
                        showSaveToast('Guardado ✓');
                    }
                    pendingVerse = parsed.verse;
                    pendingChapterN = parsed.chap;
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
                    : item.sub ? `<div class="qs-item-sub qs-item-verse-text">${item.sub}</div>` : ''}
                ${item.verseData ? `<button class="qs-save-btn">🔖 Guardar</button>` : ''}
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
        const saveBtn = div.querySelector('.qs-save-btn');
        if (saveBtn) {
            const tid = elements.translationSelect.value;
            if (isVerseAlreadySaved(item.verseData.ref, tid)) {
                saveBtn.textContent = '✓ Guardado';
                saveBtn.disabled = true;
            }
            saveBtn.addEventListener('click', e => {
                e.stopPropagation();
                if (studiesState && !isVerseAlreadySaved(item.verseData.ref, tid)) {
                    const activeStudy = studiesGetActive(studiesState);
                    studiesState = studiesAddEntry(studiesState, activeStudy.id, { type: 'verse', ref: item.verseData.ref, bookId: item.verseData.bookId, chapN: item.verseData.chapN, verseN: item.verseData.verseN, verseEnd: item.verseData.verseEnd || null, text: item.verseData.text, translationId: tid, note: '' });
                    studiesSave(studiesState);
                    showSaveToast('Guardado ✓');
                    saveBtn.textContent = '✓ Guardado';
                    saveBtn.disabled = true;
                }
            });
        }

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
document.getElementById('qs-open-btn').addEventListener('click', openQS);

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

// ── Selección de versículo y acciones ─────────────────────────

let selectedVerseEl    = null;
let selectedVerseEndEl = null;

function getVerseInfo(el) {
    const verseN = parseInt(el.querySelector('.v-num')?.textContent);
    const chapN  = parseInt(el.getAttribute('data-chap')) || currentChapter?.n;
    return { verseN, chapN };
}

function clearVerseSelection() {
    if (selectedVerseEl) {
        selectedVerseEl.classList.remove('verse-selected');
        selectedVerseEl = null;
    }
    selectedVerseEndEl = null;
    elements.versesContent.querySelectorAll('.verse-in-range').forEach(el => {
        el.classList.remove('verse-in-range');
    });
    document.getElementById('verse-actions').classList.remove('va-active');
}

function highlightVerseRange() {
    elements.versesContent.querySelectorAll('.verse-in-range').forEach(el => el.classList.remove('verse-in-range'));
    if (!selectedVerseEl || !selectedVerseEndEl) return;
    const { verseN: startN, chapN } = getVerseInfo(selectedVerseEl);
    const { verseN: endN }          = getVerseInfo(selectedVerseEndEl);
    const minN = Math.min(startN, endN);
    const maxN = Math.max(startN, endN);
    elements.versesContent.querySelectorAll('.verse').forEach(el => {
        const { verseN, chapN: vChap } = getVerseInfo(el);
        if (vChap === chapN && verseN >= minN && verseN <= maxN) {
            el.classList.add('verse-in-range');
        }
    });
}

function updateVerseActionBar() {
    if (!selectedVerseEl) return;
    const { verseN: startN, chapN } = getVerseInfo(selectedVerseEl);
    if (selectedVerseEndEl) {
        const { verseN: endN } = getVerseInfo(selectedVerseEndEl);
        const minN = Math.min(startN, endN);
        const maxN = Math.max(startN, endN);
        document.getElementById('va-ref').textContent = `${currentBook.name} ${chapN}:${minN}-${maxN}`;
    } else {
        document.getElementById('va-ref').textContent = `${currentBook.name} ${chapN}:${startN}`;
    }
}

elements.versesContent.addEventListener('click', e => {
    if (e.target.classList.contains('study-note-badge')) return;
    const verseEl = e.target.closest('.verse');
    if (!verseEl) { clearVerseSelection(); return; }

    // Rango ya completo → limpiar y empezar desde el nuevo verso
    if (selectedVerseEndEl) {
        clearVerseSelection();
        selectedVerseEl = verseEl;
        verseEl.classList.add('verse-selected');
        updateVerseActionBar();
        document.getElementById('verse-actions').classList.add('va-active');
        return;
    }

    // Mismo verso seleccionado → deseleccionar
    if (selectedVerseEl === verseEl) {
        clearVerseSelection();
        return;
    }

    // Hay un verso inicial → extender rango si mismo capítulo
    if (selectedVerseEl) {
        const { chapN: startChap } = getVerseInfo(selectedVerseEl);
        const { chapN: endChap }   = getVerseInfo(verseEl);
        if (startChap === endChap) {
            selectedVerseEndEl = verseEl;
            highlightVerseRange();
        } else {
            // Distinto capítulo (modo continuo) → empezar de nuevo
            clearVerseSelection();
            selectedVerseEl = verseEl;
            verseEl.classList.add('verse-selected');
        }
    } else {
        selectedVerseEl = verseEl;
        verseEl.classList.add('verse-selected');
    }

    updateVerseActionBar();
    document.getElementById('verse-actions').classList.add('va-active');
});

document.getElementById('va-compare').addEventListener('click', () => {
    if (!selectedVerseEl) return;
    const { verseN, chapN } = getVerseInfo(selectedVerseEl);
    openVerseCompare(currentBook.id, chapN, verseN);
});

async function openVerseCompare(bookId, chapN, verseN) {
    const modal = document.getElementById('verse-compare');
    const content = document.getElementById('vc-content');
    document.getElementById('vc-title').textContent =
        `${currentBook.name} ${chapN}:${verseN}`;
    content.innerHTML = '<div style="padding:20px;text-align:center;opacity:0.5">Cargando…</div>';
    modal.classList.remove('vc-hidden');

    const results = await Promise.all(translations.map(async t => {
        let data = bibleCache[t.id];
        if (!data) {
            try {
                const res = await fetch(t.file);
                data = await res.json();
                bibleCache[t.id] = data;
            } catch { return { label: t.label, text: null }; }
        }
        const book = data.find(b => b.id == bookId);
        const chap = book?.chapters.find(c => c.n == chapN);
        const verse = chap?.v.find(v => v.n == verseN);
        return { label: t.label, text: verse?.t || null };
    }));

    content.innerHTML = results.map(r => `
        <div class="vc-item">
            <div class="vc-label">${r.label}</div>
            <div class="vc-text">${r.text ?? '<em style="opacity:0.4">No disponible</em>'}</div>
        </div>`).join('');
}

document.getElementById('vc-overlay').addEventListener('click', () => {
    document.getElementById('verse-compare').classList.add('vc-hidden');
});
document.getElementById('vc-close').addEventListener('click', () => {
    document.getElementById('verse-compare').classList.add('vc-hidden');
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
        Promise.all([init(), minWait]).then(() => {
            hideSplash();
            setTimeout(() => studiesInit(), 700); // after splash fade (650ms)
        });
    }
});

// ═══════════════════════════════════════════════════════════════
// ── Estudios Bíblicos ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

function isVerseAlreadySaved(ref, translationId) {
    if (!studiesState) return false;
    const active = studiesGetActive(studiesState);
    const entries = active.entries;
    if (!entries.length) return false;
    const last = entries[entries.length - 1];
    return last.type === 'verse' && last.ref === ref && last.translationId === translationId;
}

const STORAGE_KEY = 'bible-studies';
const DEFAULT_STATE = {
    activeStudyId: 'general',
    studies: [
        {
            id: 'general',
            name: 'General',
            createdAt: new Date().toISOString(),
            entries: []
        }
    ]
};

// Capa de datos
function studiesLoad() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { ...DEFAULT_STATE };
        const parsed = JSON.parse(raw);
        // Ensure general study exists
        if (!parsed.studies.find(s => s.id === 'general')) {
            parsed.studies.unshift({
                id: 'general',
                name: 'General',
                createdAt: new Date().toISOString(),
                entries: []
            });
        }
        // Ensure all studies have tags array
        parsed.studies.forEach(s => { if (!s.tags) s.tags = []; });
        return parsed;
    } catch {
        return { ...DEFAULT_STATE };
    }
}

function studiesSave(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function studiesGetActive(state) {
    return state.studies.find(s => s.id === (state.activeStudyId || 'general')) || state.studies[0];
}

function studiesCreate(state, name, tags = []) {
    const id = 'study_' + Date.now();
    const newStudy = { id, name, tags, createdAt: new Date().toISOString(), entries: [] };
    return { ...state, studies: [...state.studies, newStudy] };
}

function studiesUpdateStudy(state, studyId, { name, tags }) {
    const studies = state.studies.map(s => {
        if (s.id !== studyId) return s;
        return { ...s, name: name || s.name, tags: tags || [] };
    });
    return { ...state, studies };
}

function studiesSetActive(state, id) {
    return {
        ...state,
        activeStudyId: id
    };
}

function studiesAddEntry(state, studyId, entry) {
    const studies = state.studies.map(s => {
        if (s.id !== studyId) return s;
        return {
            ...s,
            entries: [...s.entries, { ...entry, id: 'entry_' + Date.now(), savedAt: new Date().toISOString() }]
        };
    });
    return { ...state, studies };
}

function studiesUpdateEntry(state, studyId, entryId, updates) {
    const studies = state.studies.map(s => {
        if (s.id !== studyId) return s;
        return { ...s, entries: s.entries.map(e => e.id === entryId ? { ...e, ...updates } : e) };
    });
    return { ...state, studies };
}

function studiesDeleteEntry(state, studyId, entryId) {
    const studies = state.studies.map(s => {
        if (s.id !== studyId) return s;
        return {
            ...s,
            entries: s.entries.filter(e => e.id !== entryId)
        };
    });
    return { ...state, studies };
}

function studiesDeleteStudy(state, studyId) {
    if (studyId === 'general') return state;
    const studies = state.studies.filter(s => s.id !== studyId);
    const newActiveId = state.activeStudyId === studyId ? 'general' : state.activeStudyId;
    return { ...state, studies, activeStudyId: newActiveId };
}

// Variables de estado
let studiesState = studiesLoad();

// UI Functions
function studiesInit() {
    setupStudiesListeners();
    setupStudyEditListeners();
    setupExportImport();
    setupSharedStudies();
    updateStudiesButton();
    renderStudiesDropdown();
    updateModeToggleText();
    updateRefsToggleText();
    updateNavToggleText();
    studyNavInit();
    
    // Alerta de estudio activo al iniciar (si está habilitada)
    updateStudyAlertToggleText();
    if (localStorage.getItem('bible-study-alert') !== 'off') {
        showActiveStudyAlert(studiesState.activeStudyId || 'general');
    }
}

function setupStudiesListeners() {
    const btn = document.getElementById('studies-btn');
    const header = document.getElementById('sd-header');
    const newNote = document.getElementById('sd-new-note');
    const newStudy = document.getElementById('sd-new-study');
    
    // Toggle dropdown
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleStudiesDropdown();
    });
    
    // Cerrar con overlay
    document.getElementById('sd-overlay').addEventListener('click', closeStudiesDropdown);
    
    // Header opens sheet for active study
    header.addEventListener('click', () => {
        const activeStudy = studiesGetActive(studiesState);
        openStudySheet(activeStudy.id);
    });
    
    // Botón de configuración en el drawer
    document.getElementById('sd-config-btn').addEventListener('click', () => {
        closeStudiesDropdown();
        openConfigModal();
    });

    // Modal de configuración — cerrar
    document.getElementById('cfg-close').addEventListener('click', closeConfigModal);
    document.getElementById('cfg-overlay').addEventListener('click', closeConfigModal);

    // Modal de configuración — toggles
    document.getElementById('cfg-mode-toggle').addEventListener('click', () => {
        cleanupPageMode();
        readingMode = readingMode === 'paged' ? 'continuous' : 'paged';
        localStorage.setItem('bible-reading-mode', readingMode);
        updateModeToggleText();
        if (currentBook && currentChapter) showReader(currentBook, currentChapter);
    });

    document.getElementById('cfg-alert-toggle').addEventListener('click', () => {
        const current = localStorage.getItem('bible-study-alert');
        localStorage.setItem('bible-study-alert', current === 'off' ? 'on' : 'off');
        updateStudyAlertToggleText();
    });

    document.getElementById('cfg-refs-toggle').addEventListener('click', () => {
        const current = localStorage.getItem('bible-study-refs-mode') || 'active';
        localStorage.setItem('bible-study-refs-mode', current === 'active' ? 'all' : 'active');
        updateRefsToggleText();
        reapplyStudyMarkers();
    });

    document.getElementById('cfg-nav-toggle').addEventListener('click', () => {
        const enabled = studyNavIsEnabled();
        localStorage.setItem('bible-study-nav', enabled ? 'off' : 'on');
        updateNavToggleText();
        studyNavUpdate();
    });

    document.getElementById('cfg-autosave-toggle').addEventListener('click', () => {
        const current = localStorage.getItem('bible-autosave-verse');
        localStorage.setItem('bible-autosave-verse', current === 'on' ? 'off' : 'on');
        updateAutosaveToggleText();
    });

    document.getElementById('cfg-restore-toggle').addEventListener('click', () => {
        const current = localStorage.getItem('bible-restore-position');
        localStorage.setItem('bible-restore-position', current === 'off' ? 'on' : 'off');
        updateRestorePositionToggleText();
    });

    // New note
    newNote.addEventListener('click', () => {
        openNoteSheet();
    });
    
    // New study
    newStudy.addEventListener('click', () => {
        closeStudiesDropdown();
        openStudyEditSheet(null, { autoActivate: true });
    });
    
    // Sheet overlays
    document.getElementById('ss-overlay').addEventListener('click', closeStudySheet);
    document.getElementById('ss-close').addEventListener('click', closeStudySheet);
    
    document.getElementById('ns-overlay').addEventListener('click', closeNoteSheet);
    document.getElementById('ns-close').addEventListener('click', closeNoteSheet);
    
    // Save note
    document.getElementById('ns-save-btn').addEventListener('click', handleSaveNote);
    
    // Save verse button in verse-actions
    document.getElementById('va-save').addEventListener('click', handleSaveVerse);

    // Image button in verse-actions
    document.getElementById('va-image').addEventListener('click', handleVerseImage);

    // Verse image modal
    document.getElementById('vim-close').addEventListener('click', () =>
        document.getElementById('verse-img-modal').classList.add('vim-hidden'));
    document.getElementById('vim-overlay').addEventListener('click', () =>
        document.getElementById('verse-img-modal').classList.add('vim-hidden'));
    document.getElementById('vim-share').addEventListener('click', shareVerseImage);

    // Cross-references button
    document.getElementById('va-crossref').addEventListener('click', handleCrossRef);
    document.getElementById('crm-close').addEventListener('click', () =>
        document.getElementById('crossref-modal').classList.add('crm-hidden'));
    document.getElementById('crm-overlay').addEventListener('click', () =>
        document.getElementById('crossref-modal').classList.add('crm-hidden'));
}

function toggleStudiesDropdown() {
    const drawer = document.getElementById('studies-drawer');
    const isOpen = drawer.classList.contains('sd-open');
    if (isOpen) {
        drawer.classList.remove('sd-open');
    } else {
        renderStudiesDropdown();
        drawer.classList.add('sd-open');
    }
}

let activeTagFilter = null;

function getAllTags() {
    const set = new Set();
    studiesState.studies.forEach(s => (s.tags || []).forEach(t => set.add(t)));
    return [...set].sort();
}

function renderTagFilter() {
    const filterEl = document.getElementById('sd-tag-filter');
    if (!filterEl) return;
    const allTags = getAllTags();
    if (!allTags.length) { filterEl.innerHTML = ''; return; }

    const label = activeTagFilter ? `🏷️ ${activeTagFilter}` : '🏷️ Filtrar por etiqueta';
    filterEl.innerHTML = `
        <button class="sd-filter-btn${activeTagFilter ? ' sd-filter-btn-active' : ''}" id="sd-filter-toggle">${label}</button>
        <div class="sd-filter-chips sd-filter-chips-hidden" id="sd-filter-chips">
            <span class="sd-filter-chip ${!activeTagFilter ? 'sd-filter-active' : ''}" data-tag="">Todas</span>
            ${allTags.map(t => `<span class="sd-filter-chip ${activeTagFilter === t ? 'sd-filter-active' : ''}" data-tag="${t}">${t}</span>`).join('')}
        </div>
    `;
    document.getElementById('sd-filter-toggle').addEventListener('click', () => {
        document.getElementById('sd-filter-chips').classList.toggle('sd-filter-chips-hidden');
    });
    filterEl.querySelectorAll('.sd-filter-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            activeTagFilter = chip.dataset.tag || null;
            renderStudiesDropdown();
        });
    });
}

function renderStudiesDropdown() {
    const list = document.getElementById('sd-studies-list');
    const header = document.getElementById('sd-header');
    const activeStudy = studiesGetActive(studiesState);

    header.innerHTML = `<span class="sd-header-name">${activeStudy.name} ›</span><span class="sd-header-sub">Estudio activo</span>`;
    updateModeToggleText();
    renderTagFilter();

    list.innerHTML = '';
    studiesState.studies
        .filter(s => !activeTagFilter || (s.tags || []).includes(activeTagFilter))
        .forEach(study => {
            const li = document.createElement('li');
            const tagsHtml = (study.tags || []).length
                ? `<div class="sd-study-tags">${(study.tags || []).map(t => `<span class="sd-tag-chip">${t}</span>`).join('')}</div>`
                : '';
            li.innerHTML = `<div class="sd-study-info"><span class="sd-study-name">${study.name}</span>${tagsHtml}</div>`;
            const isActive = study.id === (studiesState.activeStudyId || 'general');
            if (isActive) li.classList.add('sd-active');
            li.addEventListener('click', () => openStudySheet(study.id));
            list.appendChild(li);
        });
}

function updateStudiesButton() {
    const btn = document.getElementById('studies-btn');
    if (studiesState.activeStudyId && studiesState.activeStudyId !== 'general') {
        btn.classList.add('has-active');
    } else {
        btn.classList.remove('has-active');
    }
}

function updateStudyAlertToggleText() {
    const btn = document.getElementById('cfg-alert-toggle');
    if (!btn) return;
    const enabled = localStorage.getItem('bible-study-alert') !== 'off';
    btn.textContent = enabled ? '🔔 Activada' : '🔕 Desactivada';
}

function updateModeToggleText() {
    const btn = document.getElementById('cfg-mode-toggle');
    if (btn) btn.textContent = readingMode === 'paged' ? '📄 Páginas' : '📜 Continuo';
}

function openStudySheet(studyId, isStartup = false) {
    const sheet = document.getElementById('study-sheet');
    const title = document.getElementById('ss-title');
    const actions = document.getElementById('ss-actions');

    const study = studiesState.studies.find(s => s.id === studyId);
    if (!study) return;

    const tagsHtml = (study.tags || []).length
        ? `<div class="ss-study-tags">${(study.tags || []).map(t => `<span class="ss-tag-chip">${t}</span>`).join('')}</div>`
        : '';
    title.innerHTML = `📓 ${study.name} <button id="ss-edit-study-btn" class="icon-btn ss-edit-btn" title="Editar">✏️</button>`;
    // Insert tags row between header and content
    const ssBox = document.getElementById('ss-box');
    const existingTagsRow = ssBox.querySelector('.ss-study-tags');
    if (existingTagsRow) existingTagsRow.remove();
    if (tagsHtml) {
        const ssHeader = document.getElementById('ss-header');
        ssHeader.insertAdjacentHTML('afterend', tagsHtml);
    }
    document.getElementById('ss-edit-study-btn').addEventListener('click', () => {
        closeStudySheet();
        openStudyEditSheet(studyId);
    });

    // Mostrar ID del estudio
    const idEl = document.getElementById('ss-study-id');
    idEl.innerHTML = `ID: <span class="ss-study-id-value">${studyId}</span><button class="ss-copy-id-btn" title="Copiar ID">📋</button>`;
    idEl.querySelector('.ss-copy-id-btn').addEventListener('click', () => {
        navigator.clipboard.writeText(studyId).then(() => showSaveToast('ID copiado ✓')).catch(() => {
            // fallback manual
            const ta = document.createElement('textarea');
            ta.value = studyId;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            showSaveToast('ID copiado ✓');
        });
    });

    const content = document.getElementById('ss-content');
    if (isStartup) {
        content.innerHTML = `
            <div class="ss-explanation">
                <p><strong>¿Qué son los estudios?</strong></p>
                <p>Los estudios te permiten organizar tus citas bíblicas y notas en grupos temáticos. Por ejemplo: <em>Sermón del domingo</em>, <em>Estudio de Romanos</em> o <em>Devocional personal</em>.</p>
                <p>El estudio <strong>General</strong> siempre está disponible como espacio por defecto. Puedes crear tantos estudios como necesites y cambiar entre ellos en cualquier momento desde el menú 📓.</p>
                <p>Estudio activo actualmente: <strong>${study.name}</strong></p>
            </div>
        `;
    } else {
        renderStudyEntries(study);
    }

    if (isStartup) {
        // Al iniciar: continuar, ir a General, o crear nuevo
        const goGeneralBtn = studyId !== 'general'
            ? `<button id="ss-go-general-btn" class="ss-secondary-btn">Ir a General</button>`
            : '';
        const otherStudies = studiesState.studies.filter(s => s.id !== studyId && s.id !== 'general');
        const moreStudiesBtn = otherStudies.length > 0
            ? `<button id="ss-more-studies-btn" class="ss-secondary-btn">Ver más estudios (${otherStudies.length})</button>`
            : '';
        actions.innerHTML = `
            <button id="ss-continue-btn" class="primary-btn">Continuar en este estudio</button>
            <button id="ss-view-entries-btn" class="ss-secondary-btn">Ver entradas del estudio</button>
            ${goGeneralBtn}
            ${moreStudiesBtn}
            <button id="ss-new-study-btn" class="ss-secondary-btn">➕ Crear nuevo estudio</button>
        `;
        document.getElementById('ss-continue-btn').addEventListener('click', () => {
            if (window.innerWidth >= 1024) {
                renderStudyEntries(study);
                actions.innerHTML = '';
            } else {
                closeStudySheet();
            }
        });
        document.getElementById('ss-view-entries-btn').addEventListener('click', () => {
            renderStudyEntries(study);
            actions.innerHTML = '';
        });
        document.getElementById('ss-more-studies-btn')?.addEventListener('click', () => {
            const content = document.getElementById('ss-content');
            content.innerHTML = otherStudies.map(s => `
                <div class="ss-study-option" data-id="${s.id}">
                    <span class="ss-study-option-name">${s.name}</span>
                    <span class="ss-study-option-count">${s.entries.length} entradas</span>
                </div>
            `).join('');
            content.querySelectorAll('.ss-study-option').forEach(el => {
                el.addEventListener('click', () => {
                    studiesState = studiesSetActive(studiesState, el.dataset.id);
                    studiesSave(studiesState);
                    updateStudiesButton();
                    renderStudiesDropdown();
                    closeStudySheet();
                    showSaveToast(`Estudio activo: ${el.querySelector('.ss-study-option-name').textContent}`);
                    studyNavReset();
                    reapplyStudyMarkers();
                    studyNavUpdate();
                });
            });
            document.getElementById('ss-more-studies-btn').remove();
        });
        document.getElementById('ss-go-general-btn')?.addEventListener('click', () => {
            studiesState = studiesSetActive(studiesState, 'general');
            studiesSave(studiesState);
            updateStudiesButton();
            renderStudiesDropdown();
            closeStudySheet();
            showSaveToast('Estudio activo: General');
            studyNavReset();
            reapplyStudyMarkers();
            studyNavUpdate();
        });
        document.getElementById('ss-new-study-btn').addEventListener('click', () => {
            closeStudySheet();
            openStudyEditSheet(null, { autoActivate: true });
        });
    } else {
        const isActive = study.id === studiesState.activeStudyId;
        if (isActive) {
            actions.innerHTML = `<button id="ss-continue-btn" class="primary-btn">Continuar en este estudio</button>`;
            document.getElementById('ss-continue-btn').addEventListener('click', () => {
                if (window.innerWidth >= 1024) {
                    renderStudyEntries(study);
                    actions.innerHTML = '';
                } else {
                    closeStudySheet();
                }
            });
        } else {
            actions.innerHTML = `
                <button id="ss-continue-btn" class="primary-btn">Continuar en este estudio</button>
                <button id="ss-cancel-btn" class="ss-secondary-btn">Cancelar</button>
            `;
            document.getElementById('ss-continue-btn').addEventListener('click', () => {
                studiesState = studiesSetActive(studiesState, study.id);
                studiesSave(studiesState);
                updateStudiesButton();
                renderStudiesDropdown();
                showSaveToast(`Estudio activo: ${study.name}`);
                studyNavReset();
                reapplyStudyMarkers();
                studyNavUpdate();
                if (window.innerWidth >= 1024) {
                    renderStudyEntries(study);
                    actions.innerHTML = '';
                } else {
                    closeStudySheet();
                }
            });
            document.getElementById('ss-cancel-btn').addEventListener('click', closeStudySheet);
        }
    }

    sheet.classList.remove('ss-hidden');
    document.body.classList.add('study-sheet-open');
    closeStudyNavModal();
    closeStudiesDropdown();
}

function closeStudiesDropdown() {
    document.getElementById('studies-drawer').classList.remove('sd-open');
}

function renderStudyEntries(study) {
    const content = document.getElementById('ss-content');
    
    if (!study.entries.length) {
        content.innerHTML = '<div class="ss-empty">Aún no hay entradas en este estudio</div>';
        return;
    }
    
    content.innerHTML = study.entries.map(entry => {
        if (entry.type === 'verse') {
            return `
                <div class="ss-entry">
                    <div class="ss-entry-ref" data-entry-id="${entry.id}">${entry.ref}${entry.translationId ? ` <span class="ss-entry-version">${entry.translationId.toUpperCase()}</span>` : ''}</div>
                    <div class="ss-entry-text">${entry.text}</div>
                    ${entry.note ? `<div class="ss-entry-note">${linkifyNoteText(entry.note, { bookId: entry.bookId, chapN: entry.chapN })}</div>` : ''}
                    <div class="ss-entry-actions">
                        <button class="ss-edit-entry" data-entry-id="${entry.id}">✏️ Editar nota</button>
                        <button class="ss-delete-entry" data-entry-id="${entry.id}">🗑️ Eliminar</button>
                    </div>
                </div>
            `;
        } else {
            return `
                <div class="ss-entry">
                    <div class="ss-entry-text">📝 ${entry.text}</div>
                    <div class="ss-entry-actions">
                        <button class="ss-edit-entry" data-entry-id="${entry.id}">✏️ Editar</button>
                        <button class="ss-delete-entry" data-entry-id="${entry.id}">🗑️ Eliminar</button>
                    </div>
                </div>
            `;
        }
    }).join('');
    
    // Add click handlers for verse refs
    content.querySelectorAll('.ss-entry-ref').forEach(refEl => {
        refEl.addEventListener('click', () => {
            const entryId = refEl.dataset.entryId;
            const entry = study.entries.find(e => e.id === entryId);
            if (entry && entry.bookId && entry.chapN && entry.verseN) {
                const book = bibleData?.find(b => b.id === entry.bookId);
                if (book) {
                    const chapter = book.chapters.find(c => c.n === entry.chapN);
                    if (chapter) {
                        closeStudySheet();
                        showChapters(book);
                        pendingVerse = entry.verseN;
                        pendingChapterN = entry.chapN;
                        showReader(book, chapter);
                    }
                }
            }
        });
    });
    
    // Links de citas en notas
    attachNoteRefListeners(content);

    // Edit handlers
    content.querySelectorAll('.ss-edit-entry').forEach(btn => {
        btn.addEventListener('click', () => {
            const entry = study.entries.find(e => e.id === btn.dataset.entryId);
            if (entry) openNoteSheet(null, entry, study.id);
        });
    });

    // Delete handlers
    content.querySelectorAll('.ss-delete-entry').forEach(btn => {
        btn.addEventListener('click', () => {
            showConfirmModal('¿Eliminar esta entrada?', () => {
                studiesState = studiesDeleteEntry(studiesState, study.id, btn.dataset.entryId);
                studiesSave(studiesState);
                const updatedStudy = studiesState.studies.find(s => s.id === study.id);
                renderStudyEntries(updatedStudy);
                reapplyStudyMarkers();
                studyNavUpdate();
            });
        });
    });
}

function closeStudySheet() {
    document.getElementById('study-sheet').classList.add('ss-hidden');
    document.body.classList.remove('study-sheet-open');
}

function openNoteSheet(verseData = null, editEntry = null, editStudyId = null) {
    const sheet = document.getElementById('note-sheet');
    const title = document.getElementById('ns-title');
    const refEl = document.getElementById('ns-verse-ref');
    const textEl = document.getElementById('ns-verse-text');
    const noteInput = document.getElementById('ns-note-input');

    noteInput.value = '';
    sheet.dataset.editEntry = '';
    sheet.dataset.editStudyId = '';

    if (editEntry) {
        title.textContent = 'Editar entrada';
        sheet.dataset.editEntry = JSON.stringify(editEntry);
        sheet.dataset.editStudyId = editStudyId || '';
        if (editEntry.type === 'verse') {
            refEl.textContent = editEntry.ref;
            refEl.style.display = 'block';
            textEl.textContent = editEntry.text;
            textEl.style.display = 'block';
            noteInput.value = editEntry.note || '';
            noteInput.placeholder = 'Nota del versículo (opcional)';
        } else {
            refEl.style.display = 'none';
            textEl.style.display = 'none';
            noteInput.value = editEntry.text || '';
            noteInput.placeholder = 'Texto de la nota';
        }
    } else if (verseData) {
        title.textContent = 'Guardar versículo';
        refEl.textContent = verseData.ref;
        refEl.style.display = 'block';
        textEl.textContent = verseData.text;
        textEl.style.display = 'block';
        noteInput.placeholder = 'Escribe una nota (opcional)';
    } else {
        title.textContent = 'Nueva nota';
        refEl.style.display = 'none';
        textEl.style.display = 'none';
        noteInput.placeholder = 'Escribe una nota (opcional)';
    }

    sheet.classList.remove('ns-hidden');
    closeStudiesDropdown();
    setTimeout(() => noteInput.focus(), 100);

    // Store verse data for save
    sheet.dataset.verseData = verseData ? JSON.stringify(verseData) : '';
}

function closeNoteSheet() {
    document.getElementById('note-sheet').classList.add('ns-hidden');
}

function handleSaveNote() {
    const sheet = document.getElementById('note-sheet');
    const noteInput = document.getElementById('ns-note-input');
    const note = noteInput.value.trim();
    const verseDataStr = sheet.dataset.verseData;
    const editEntryStr = sheet.dataset.editEntry;

    // ── Modo edición ──────────────────────────────────────────
    if (editEntryStr) {
        const editEntry = JSON.parse(editEntryStr);
        const studyId = sheet.dataset.editStudyId;
        if (editEntry.type === 'verse') {
            studiesState = studiesUpdateEntry(studiesState, studyId, editEntry.id, { note });
        } else {
            if (!note) { showSaveToast('Escribe algo para guardar'); return; }
            studiesState = studiesUpdateEntry(studiesState, studyId, editEntry.id, { text: note });
        }
        studiesSave(studiesState);
        closeNoteSheet();
        showSaveToast('Actualizado ✓');
        // Refresca el study sheet si está abierto
        const ssSheet = document.getElementById('study-sheet');
        if (!ssSheet.classList.contains('ss-hidden')) {
            const updatedStudy = studiesState.studies.find(s => s.id === studyId);
            if (updatedStudy) renderStudyEntries(updatedStudy);
        }
        reapplyStudyMarkers();
        return;
    }

    const activeStudy = studiesGetActive(studiesState);

    if (verseDataStr) {
        const verseData = JSON.parse(verseDataStr);
        const entry = {
            type: 'verse',
            ref: verseData.ref,
            bookId: verseData.bookId,
            chapN: verseData.chapN,
            verseN: verseData.verseN,
            verseEnd: verseData.verseEnd || null,
            text: verseData.text,
            translationId: elements.translationSelect.value,
            note: note
        };
        studiesState = studiesAddEntry(studiesState, activeStudy.id, entry);
    } else if (note) {
        const entry = {
            type: 'note',
            text: note,
            note: ''
        };
        studiesState = studiesAddEntry(studiesState, activeStudy.id, entry);
    } else {
        showSaveToast('Escribe algo para guardar');
        return;
    }
    
    studiesSave(studiesState);
    closeNoteSheet();
    showSaveToast('Guardado ✓');
    reapplyStudyMarkers();
    studyNavUpdate();
}

function handleSaveVerse() {
    if (!selectedVerseEl) return;
    const { verseN: startN, chapN } = getVerseInfo(selectedVerseEl);

    let ref, verseN, verseEnd, text;
    if (selectedVerseEndEl) {
        const { verseN: endN } = getVerseInfo(selectedVerseEndEl);
        verseN   = Math.min(startN, endN);
        verseEnd = Math.max(startN, endN);
        ref      = `${currentBook.name} ${chapN}:${verseN}-${verseEnd}`;
        const chapData = currentBook.chapters.find(c => c.n === chapN);
        const verses   = (chapData?.v || []).filter(v => parseInt(v.n) >= verseN && parseInt(v.n) <= verseEnd);
        text = verses.map(v => `${v.n} ${v.t}`).join(' ');
    } else {
        verseN   = startN;
        verseEnd = null;
        ref      = `${currentBook.name} ${chapN}:${verseN}`;
        const vtEl = selectedVerseEl.querySelector('.v-text');
        text = vtEl ? vtEl.textContent.trim() : selectedVerseEl.textContent.replace(/^\d+\s*/, '').trim();
    }

    openNoteSheet({ ref, bookId: currentBook.id, chapN, verseN, verseEnd, text });
}

function showSaveToast(msg) {
    const toast = document.getElementById('save-toast');
    toast.textContent = msg;
    toast.classList.remove('st-hidden');
    toast.classList.add('st-visible');
    
    setTimeout(() => {
        toast.classList.remove('st-visible');
        toast.classList.add('st-hidden');
    }, 2000);
}

function showActiveStudyAlert(studyId) {
    const study = studiesState.studies.find(s => s.id === studyId);
    if (!study) return;
    openStudySheet(studyId, true);
}

// ── Detección de citas bíblicas en notas ──────────────────────

function escapeHtml(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function linkifyNoteText(text, context) {
    if (!bibleData || !text) return escapeHtml(text || '');

    const allMatches = [];

    // ── Patrón 1: referencia completa (Libro Cap:Vers) ──────────
    const fullPattern = /(\d\s+)?([A-Za-záéíóúüñÁÉÍÓÚÜÑ]+(?:\s+[A-Za-záéíóúüñÁÉÍÓÚÜÑ]+){0,3})\s+(\d+)(?:[:\s]+(?:vers(?:o|ículo|s)?\s+)?(\d+)(?:\s*[-–]\s*(\d+)|\s+al\s+(\d+))?)/gi;
    let match;
    while ((match = fullPattern.exec(text)) !== null) {
        const numPrefix = (match[1] || '').trim();
        const bookRaw   = match[2];
        const chapN     = parseInt(match[3]);
        const verseN    = parseInt(match[4]);
        const verseEnd  = match[5] ? parseInt(match[5]) : (match[6] ? parseInt(match[6]) : null);
        const bookQuery = numPrefix ? `${numPrefix} ${bookRaw}` : bookRaw;
        const books = findBooks(bookQuery);
        if (books.length > 0) {
            const book = books[0];
            const chapter = book.chapters.find(c => c.n === chapN);
            if (chapter && chapter.v.find(v => v.n == verseN)) {
                allMatches.push({ start: match.index, end: match.index + match[0].length,
                    html: `<span class="note-bible-ref" data-book-id="${book.id}" data-chap="${chapN}" data-verse="${verseN}" data-verse-end="${verseEnd || ''}">${escapeHtml(match[0])}</span>` });
                continue;
            }
        }
        fullPattern.lastIndex = match.index + 1;
    }

    if (context && context.bookId) {
        const ctxBook = bibleData.find(b => b.id === context.bookId);
        if (ctxBook) {
            // ── Patrón 2: (v.N) o (v.N-M) — verso relativo al capítulo actual ──
            if (context.chapN) {
                const relVerse = /\(v\.(\d+)(?:\s*[-–]\s*(\d+))?\)/gi;
                while ((match = relVerse.exec(text)) !== null) {
                    const vN = parseInt(match[1]);
                    const vEnd = match[2] ? parseInt(match[2]) : null;
                    const chap = ctxBook.chapters.find(c => c.n === context.chapN);
                    if (chap && chap.v.find(v => v.n == vN)) {
                        allMatches.push({ start: match.index, end: match.index + match[0].length,
                            html: `<span class="note-bible-ref" data-book-id="${ctxBook.id}" data-chap="${context.chapN}" data-verse="${vN}" data-verse-end="${vEnd || ''}">${escapeHtml(match[0])}</span>` });
                    }
                }
            }

            // ── Patrón 3: (N:V) o (N:V-M) — capítulo:verso relativo al libro actual ──
            const relChapVerse = /\((\d+):(\d+)(?:\s*[-–]\s*(\d+))?\)/gi;
            while ((match = relChapVerse.exec(text)) !== null) {
                const cN = parseInt(match[1]);
                const vN = parseInt(match[2]);
                const vEnd = match[3] ? parseInt(match[3]) : null;
                const chap = ctxBook.chapters.find(c => c.n === cN);
                if (chap && chap.v.find(v => v.n == vN)) {
                    allMatches.push({ start: match.index, end: match.index + match[0].length,
                        html: `<span class="note-bible-ref" data-book-id="${ctxBook.id}" data-chap="${cN}" data-verse="${vN}" data-verse-end="${vEnd || ''}">${escapeHtml(match[0])}</span>` });
                }
            }
        }
    }

    // Ordenar por posición y eliminar solapamientos
    allMatches.sort((a, b) => a.start - b.start);
    const filtered = [];
    let lastEnd = 0;
    for (const m of allMatches) {
        if (m.start >= lastEnd) { filtered.push(m); lastEnd = m.end; }
    }

    const parts = [];
    let pos = 0;
    for (const m of filtered) {
        parts.push(escapeHtml(text.slice(pos, m.start)));
        parts.push(m.html);
        pos = m.end;
    }
    parts.push(escapeHtml(text.slice(pos)));
    return parts.join('');
}

function attachNoteRefListeners(container) {
    container.querySelectorAll('.note-bible-ref').forEach(el => {
        el.addEventListener('click', e => {
            e.stopPropagation();
            const bookId  = parseInt(el.dataset.bookId);
            const chapN   = parseInt(el.dataset.chap);
            const verseN  = parseInt(el.dataset.verse);
            const book    = bibleData?.find(b => b.id === bookId);
            if (!book) return;
            const chapter = book.chapters.find(c => c.n === chapN);
            if (!chapter) return;
            // Cerrar cualquier modal abierto
            closeNoteBadgeModal();
            closeStudyNavModal();
            document.getElementById('study-sheet').classList.add('ss-hidden');
            document.body.classList.remove('study-sheet-open');
            pendingVerse = verseN;
            pendingVerseEnd = el.dataset.verseEnd ? parseInt(el.dataset.verseEnd) : null;
            pendingChapterN = chapN;
            cleanupPageMode();
            showChapters(book);
            showReader(book, chapter);
        });
    });
}

// ── Marcadores de estudio en el lector ────────────────────────

function applyStudyMarkers(container, fixedChapN = null) {
    if (!studiesState || !currentBook) return;

    const refsMode = localStorage.getItem('bible-study-refs-mode') || 'active';
    let allEntries = [];
    if (refsMode === 'all') {
        studiesState.studies.forEach(s => s.entries.forEach(e => allEntries.push(e)));
    } else {
        allEntries = studiesGetActive(studiesState).entries;
    }

    // Pre-asignar números a las notas en el orden global del estudio
    const noteNumberMap = {}; // entryId → número
    let noteCounter = 0;
    allEntries.forEach(e => {
        if (e.type === 'verse' && e.note && e.note.trim()) {
            noteCounter++;
            noteNumberMap[e.id] = noteCounter;
        }
    });

    const verseEntries = allEntries.filter(e => e.type === 'verse' && e.bookId === currentBook.id);
    if (!verseEntries.length) return;

    // Map: `${chapN}_${verseN}` → entries[]
    // Los rangos se expanden para marcar todos sus versos; el badge solo va en el primero
    const map = {};
    verseEntries.forEach(e => {
        const vStart = parseInt(e.verseN);
        const vEnd   = e.verseEnd ? parseInt(e.verseEnd) : vStart;
        for (let vn = vStart; vn <= vEnd; vn++) {
            const key = `${e.chapN}_${vn}`;
            if (!map[key]) map[key] = [];
            // Solo el primer verso del rango lleva el badge de nota
            map[key].push(vn === vStart ? e : { ...e, note: '' });
        }
    });

    container.querySelectorAll('.verse').forEach(verseEl => {
        const verseN = parseInt(verseEl.querySelector('.v-num')?.textContent);
        const chapN = fixedChapN ?? parseInt(verseEl.getAttribute('data-chap'));
        if (!chapN || !verseN) return;

        const key = `${chapN}_${verseN}`;
        if (!map[key]) return;

        verseEl.classList.add('verse-in-study');

        const withNotes = map[key].filter(e => e.note && e.note.trim());
        withNotes.forEach(entry => {
            const badge = document.createElement('span');
            badge.className = 'study-note-badge';
            badge.textContent = noteNumberMap[entry.id];
            badge.addEventListener('click', ev => {
                ev.stopPropagation();
                openNoteBadgeModal(entry.note, entry.ref, { bookId: entry.bookId, chapN: entry.chapN });
            });
            verseEl.appendChild(badge);
        });
    });
}

function reapplyStudyMarkers() {
    if (!currentBook || elements.viewReader.style.display !== 'block') return;
    // Limpiar marcadores existentes
    elements.versesContent.querySelectorAll('.verse-in-study').forEach(el => {
        el.classList.remove('verse-in-study');
    });
    elements.versesContent.querySelectorAll('.study-note-badge').forEach(el => el.remove());
    // Reaplicar
    const container = readingMode === 'paged'
        ? document.getElementById('pages-strip')
        : elements.versesContent;
    if (!container) return;
    applyStudyMarkers(container, readingMode === 'paged' ? currentChapter?.n : null);
}

function openNoteBadgeModal(note, ref, context) {
    document.getElementById('nbm-ref').textContent = ref || '';
    const noteEl = document.getElementById('nbm-note-text');
    noteEl.innerHTML = linkifyNoteText(note, context);
    attachNoteRefListeners(noteEl);
    document.getElementById('note-badge-modal').classList.remove('nbm-hidden');
}

function closeNoteBadgeModal() {
    document.getElementById('note-badge-modal').classList.add('nbm-hidden');
}

document.getElementById('nbm-overlay').addEventListener('click', closeNoteBadgeModal);
document.getElementById('nbm-close').addEventListener('click', closeNoteBadgeModal);

function updateRefsToggleText() {
    const btn = document.getElementById('cfg-refs-toggle');
    if (!btn) return;
    const mode = localStorage.getItem('bible-study-refs-mode') || 'active';
    btn.textContent = mode === 'all'
        ? '🔖 Todos los estudios'
        : '🔖 Estudio activo';
}

// ── Navegación por estudio ─────────────────────────────────────

let studyNavIndex = parseInt(localStorage.getItem('bible-study-nav-index') || '0');

function studyNavReset() {
    studyNavIndex = 0;
    localStorage.setItem('bible-study-nav-index', 0);
    studyNavUpdate();
}

function studyNavIsEnabled() {
    return localStorage.getItem('bible-study-nav') === 'on';
}

function studyNavEntries() {
    return studiesGetActive(studiesState).entries;
}

function studyNavUpdate() {
    const bar = document.getElementById('study-nav-bar');
    if (!studyNavIsEnabled() || elements.viewReader.style.display !== 'block') {
        bar.classList.add('snb-hidden');
        if (window.innerWidth >= 1024) closeStudyNavModal();
        return;
    }
    const entries = studyNavEntries();
    if (!entries.length) {
        bar.classList.add('snb-hidden');
        if (window.innerWidth >= 1024) closeStudyNavModal();
        return;
    }
    bar.classList.remove('snb-hidden');

    // Clamp index
    if (studyNavIndex >= entries.length) studyNavIndex = entries.length - 1;
    if (studyNavIndex < 0) studyNavIndex = 0;

    const entry = entries[studyNavIndex];
    const refEl = document.getElementById('snb-ref');
    const posEl = document.getElementById('snb-pos');

    refEl.textContent = entry.type === 'verse' ? entry.ref : '📝 Nota';
    posEl.textContent = `${studyNavIndex + 1}/${entries.length}`;

    document.getElementById('snb-prev').disabled = studyNavIndex === 0;
    document.getElementById('snb-next').disabled = studyNavIndex === entries.length - 1;

    // En pantalla grande: abrir el sidebar automáticamente o refrescar si ya está abierto
    if (window.innerWidth >= 1024) {
        const modal = document.getElementById('study-nav-modal');
        if (modal.classList.contains('snm-hidden')) {
            openStudyNavModal();
        } else {
            renderStudyNavList();
        }
    }
}

function studyNavGo(index) {
    const entries = studyNavEntries();
    if (!entries.length) return;
    studyNavIndex = Math.max(0, Math.min(index, entries.length - 1));
    localStorage.setItem('bible-study-nav-index', studyNavIndex);
    studyNavUpdate();

    const entry = entries[studyNavIndex];
    if (entry.type === 'verse') {
        studyNavNavigateToEntry(entry);
        if (entry.note && entry.note.trim()) {
            openStudyNavModal();
        }
    } else {
        openStudyNavModal();
    }
}

function studyNavNavigateToEntry(entry) {
    if (entry.type !== 'verse' || !bibleData) return;
    const book = bibleData.find(b => b.id === entry.bookId);
    if (!book) return;
    const chapter = book.chapters.find(c => c.n === entry.chapN);
    if (!chapter) return;
    pendingVerse = entry.verseN;
    pendingChapterN = entry.chapN;
    cleanupPageMode();
    showChapters(book);
    showReader(book, chapter);
}

function openStudyNavModal() {
    if (window.innerWidth >= 1024) {
        closeStudySheet();
        renderStudyNavList();
        document.body.classList.add('study-nav-open');
    } else {
        renderStudyNavModal();
    }
    document.getElementById('study-nav-modal').classList.remove('snm-hidden');
}

function closeStudyNavModal() {
    document.getElementById('study-nav-modal').classList.add('snm-hidden');
    document.body.classList.remove('study-nav-open');
}

function renderStudyNavList() {
    const entries = studyNavEntries();
    const content = document.getElementById('snm-content');
    document.getElementById('snm-pos').textContent = `${entries.length} referencias`;

    if (!entries.length) {
        content.innerHTML = '<div class="ss-empty">No hay entradas en este estudio.</div>';
        return;
    }

    content.innerHTML = entries.map((entry, i) => {
        const active = i === studyNavIndex ? 'snm-list-active' : '';
        if (entry.type === 'verse') {
            const versionTag = entry.translationId
                ? `<span class="snm-version">${entry.translationId.toUpperCase()}</span>`
                : '';
            return `<div class="snm-list-item ${active}" data-index="${i}">
                <div class="snm-ref">${escapeHtml(entry.ref)}${versionTag}</div>
                ${entry.note ? `<div class="snm-list-note">${linkifyNoteText(entry.note, { bookId: entry.bookId, chapN: entry.chapN })}</div>` : ''}
                <button class="snm-goto-btn snm-list-goto" data-index="${i}">→ Ir al versículo</button>
            </div>`;
        } else {
            return `<div class="snm-list-item snm-list-item-note ${active}" data-index="${i}">
                <div class="snm-note-label">📝 Nota libre</div>
                <div class="snm-list-note">${linkifyNoteText(entry.text)}</div>
            </div>`;
        }
    }).join('');

    content.querySelectorAll('.snm-list-goto').forEach(btn => {
        btn.addEventListener('click', () => {
            const i = parseInt(btn.dataset.index);
            const entry = entries[i];
            studyNavIndex = i;
            localStorage.setItem('bible-study-nav-index', studyNavIndex);
            studyNavUpdate();
            studyNavNavigateToEntry(entry);
        });
    });

    content.querySelectorAll('.snm-list-note').forEach(el => {
        attachNoteRefListeners(el);
    });
}

function renderStudyNavModal() {
    const entries = studyNavEntries();
    if (!entries.length) return;

    // Clamp
    if (studyNavIndex >= entries.length) studyNavIndex = entries.length - 1;
    if (studyNavIndex < 0) studyNavIndex = 0;

    const entry = entries[studyNavIndex];
    document.getElementById('snm-pos').textContent = `${studyNavIndex + 1} de ${entries.length}`;
    document.getElementById('snm-prev').disabled = studyNavIndex === 0;
    document.getElementById('snm-next').disabled = studyNavIndex === entries.length - 1;

    const content = document.getElementById('snm-content');
    if (entry.type === 'verse') {
        const versionTag = entry.translationId
            ? `<span class="snm-version">${entry.translationId.toUpperCase()}</span>`
            : '';
        content.innerHTML = `
            <div class="snm-ref">${escapeHtml(entry.ref)}${versionTag}</div>
            <div class="snm-text">${escapeHtml(entry.text)}</div>
            ${entry.note ? `<div class="snm-note-label">Nota</div><div class="snm-note">${linkifyNoteText(entry.note, { bookId: entry.bookId, chapN: entry.chapN })}</div>` : ''}
            <button id="snm-goto" class="snm-goto-btn">→ Ir al versículo</button>
        `;
        if (entry.note) attachNoteRefListeners(content.querySelector('.snm-note'));
        document.getElementById('snm-goto').addEventListener('click', () => {
            closeStudyNavModal();
            studyNavNavigateToEntry(entry);
        });
    } else {
        content.innerHTML = `
            <div class="snm-note-label">📝 Nota libre</div>
            <div class="snm-free-note">${linkifyNoteText(entry.text)}</div>
        `;
        attachNoteRefListeners(content.querySelector('.snm-free-note'));
    }
}

function studyNavInit() {
    document.getElementById('snb-prev').addEventListener('click', () => {
        studyNavGo(studyNavIndex - 1);
    });
    document.getElementById('snb-next').addEventListener('click', () => {
        studyNavGo(studyNavIndex + 1);
    });
    document.getElementById('snb-center').addEventListener('click', openStudyNavModal);

    document.getElementById('snm-overlay').addEventListener('click', closeStudyNavModal);
    document.getElementById('snm-close').addEventListener('click', closeStudyNavModal);
    document.getElementById('snm-prev').addEventListener('click', () => {
        studyNavIndex = Math.max(0, studyNavIndex - 1);
        localStorage.setItem('bible-study-nav-index', studyNavIndex);
        studyNavUpdate();
        renderStudyNavModal();
    });
    document.getElementById('snm-next').addEventListener('click', () => {
        const entries = studyNavEntries();
        studyNavIndex = Math.min(entries.length - 1, studyNavIndex + 1);
        localStorage.setItem('bible-study-nav-index', studyNavIndex);
        studyNavUpdate();
        renderStudyNavModal();
    });
}

function updateNavToggleText() {
    const btn = document.getElementById('cfg-nav-toggle');
    if (!btn) return;
    btn.textContent = studyNavIsEnabled()
        ? '🧭 Activa'
        : '🧭 Inactiva';
}

function updateAutosaveToggleText() {
    const btn = document.getElementById('cfg-autosave-toggle');
    if (!btn) return;
    const enabled = localStorage.getItem('bible-autosave-verse') === 'on';
    btn.textContent = enabled ? '💾 Activado' : '💾 Desactivado';
}

function updateRestorePositionToggleText() {
    const btn = document.getElementById('cfg-restore-toggle');
    if (!btn) return;
    const enabled = localStorage.getItem('bible-restore-position') !== 'off';
    btn.textContent = enabled ? '📍 Activado' : '📍 Desactivado';
}

// ── Modal de configuración ────────────────────────────────────

function openConfigModal() {
    updateModeToggleText();
    updateStudyAlertToggleText();
    updateRefsToggleText();
    updateNavToggleText();
    updateRestorePositionToggleText();
    updateAutosaveToggleText();
    document.getElementById('config-modal').classList.remove('cfg-hidden');
}

function closeConfigModal() {
    document.getElementById('config-modal').classList.add('cfg-hidden');
}

// ── Modal de confirmación ─────────────────────────────────────

function showConfirmModal(message, onConfirm) {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('cm-message').textContent = message;
    modal.classList.remove('cm-hidden');

    const confirmBtn = document.getElementById('cm-confirm');
    const cancelBtn = document.getElementById('cm-cancel');

    const close = () => modal.classList.add('cm-hidden');
    const onOk = () => { close(); onConfirm(); };

    confirmBtn.onclick = onOk;
    cancelBtn.onclick = close;
    document.getElementById('cm-overlay').onclick = close;
}

// ── Modal de edición/creación de estudio ─────────────────────

function openStudyEditSheet(studyId = null, options = {}) {
    const sheet = document.getElementById('study-edit-sheet');
    const study = studyId ? studiesState.studies.find(s => s.id === studyId) : null;

    document.getElementById('ses-title').textContent = study ? 'Editar estudio' : 'Nuevo estudio';
    document.getElementById('ses-name').value = study ? study.name : '';
    sheet.dataset.studyId = studyId || '';
    sheet.dataset.autoActivate = options.autoActivate ? 'true' : '';

    renderSesTagChips(study ? (study.tags || []) : []);
    sheet.classList.remove('ses-hidden');
    setTimeout(() => document.getElementById('ses-name').focus(), 100);
}

function closeStudyEditSheet() {
    document.getElementById('study-edit-sheet').classList.add('ses-hidden');
}

const DEFAULT_TAGS = ['devocional', 'predica', 'escuela', 'mensaje', 'oración', 'evangelismo', 'profecía', 'grupos pequeños', 'estudio personal', 'apologética'];

function renderSesTagChips(selectedTags) {
    const container = document.getElementById('ses-tags-existing');
    const allTags = getAllTags();
    // Merge default suggestions
    DEFAULT_TAGS.forEach(t => { if (!allTags.includes(t)) allTags.push(t); });
    // Include any selected tags not yet in allTags (e.g. just added)
    selectedTags.forEach(t => { if (!allTags.includes(t)) allTags.push(t); });

    container.innerHTML = allTags.map(tag =>
        `<span class="ses-tag-chip ${selectedTags.includes(tag) ? 'ses-tag-selected' : ''}" data-tag="${tag}">${tag}</span>`
    ).join('');
    container.querySelectorAll('.ses-tag-chip').forEach(chip =>
        chip.addEventListener('click', () => chip.classList.toggle('ses-tag-selected'))
    );
}

function addSesNewTag() {
    const input = document.getElementById('ses-new-tag');
    const tag = input.value.trim().toLowerCase();
    if (!tag) return;
    input.value = '';
    const existing = document.querySelector(`.ses-tag-chip[data-tag="${tag}"]`);
    if (existing) { existing.classList.add('ses-tag-selected'); return; }
    const container = document.getElementById('ses-tags-existing');
    const chip = document.createElement('span');
    chip.className = 'ses-tag-chip ses-tag-selected';
    chip.dataset.tag = tag;
    chip.textContent = tag;
    chip.addEventListener('click', () => chip.classList.toggle('ses-tag-selected'));
    container.appendChild(chip);
}

function getSesSelectedTags() {
    return [...document.querySelectorAll('.ses-tag-chip.ses-tag-selected')].map(c => c.dataset.tag);
}

function setupStudyEditListeners() {
    document.getElementById('ses-overlay').addEventListener('click', closeStudyEditSheet);
    document.getElementById('ses-close').addEventListener('click', closeStudyEditSheet);

    document.getElementById('ses-add-tag').addEventListener('click', addSesNewTag);
    document.getElementById('ses-new-tag').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); addSesNewTag(); }
    });

    document.getElementById('ses-save-btn').addEventListener('click', () => {
        const sheet = document.getElementById('study-edit-sheet');
        const name = document.getElementById('ses-name').value.trim();
        if (!name) { showSaveToast('Escribe un nombre'); return; }
        const tags = getSesSelectedTags();
        const studyId = sheet.dataset.studyId;
        const autoActivate = sheet.dataset.autoActivate === 'true';

        if (studyId) {
            studiesState = studiesUpdateStudy(studiesState, studyId, { name, tags });
            studiesSave(studiesState);
            renderStudiesDropdown();
            closeStudyEditSheet();
            showSaveToast('Estudio actualizado');
        } else {
            studiesState = studiesCreate(studiesState, name, tags);
            const newId = studiesState.studies[studiesState.studies.length - 1].id;
            if (autoActivate) {
                studiesState = studiesSetActive(studiesState, newId);
                studyNavReset();
                reapplyStudyMarkers();
                studyNavUpdate();
            }
            studiesSave(studiesState);
            updateStudiesButton();
            renderStudiesDropdown();
            closeStudyEditSheet();
            showSaveToast(`Estudio "${name}" creado${autoActivate ? ' y activo' : ''}`);
        }
    });
}

// ── Exportar / Importar estudios ──────────────────────────────

function setupExportImport() {
    document.getElementById('cfg-export-btn').addEventListener('click', () => {
        closeConfigModal();
        openExportSheet();
    });

    document.getElementById('sd-whatsapp-btn').addEventListener('click', () => {
        closeStudiesDropdown();
        openWaSheet();
    });

    document.getElementById('cfg-import-btn').addEventListener('click', () => {
        closeConfigModal();
        document.getElementById('sd-import-file').click();
    });

    document.getElementById('sd-import-file').addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
            try {
                const data = JSON.parse(ev.target.result);
                if (!data.studies || !Array.isArray(data.studies)) throw new Error();
                openImportSheet(data.studies);
            } catch {
                showSaveToast('Archivo inválido');
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    });

    // Export sheet listeners
    document.getElementById('exs-overlay').addEventListener('click', closeExportSheet);
    document.getElementById('exs-close').addEventListener('click', closeExportSheet);
    document.getElementById('exs-select-all').addEventListener('change', e => {
        document.querySelectorAll('.exs-check').forEach(cb => cb.checked = e.target.checked);
    });
    document.getElementById('exs-download-btn').addEventListener('click', doExport);

    // Import sheet listeners
    document.getElementById('ims-overlay').addEventListener('click', closeImportSheet);
    document.getElementById('ims-close').addEventListener('click', closeImportSheet);
    document.getElementById('ims-select-all').addEventListener('change', e => {
        document.querySelectorAll('.ims-check').forEach(cb => cb.checked = e.target.checked);
    });
    document.getElementById('ims-mode-toggle').addEventListener('click', e => {
        const btn = e.target.closest('.ims-mode-btn');
        if (!btn) return;
        document.querySelectorAll('.ims-mode-btn').forEach(b => b.classList.remove('ims-mode-active'));
        btn.classList.add('ims-mode-active');
        const hints = {
            merge: 'Fusionar: agrega los estudios sin borrar los existentes. Si hay conflicto de ID, se omite el importado.',
            replace: 'Reemplazar: si ya existe un estudio con el mismo ID, se sobreescribe con el del archivo.'
        };
        document.getElementById('ims-hint').textContent = hints[btn.dataset.mode];
        // Refresh conflict badges
        const mode = btn.dataset.mode;
        document.querySelectorAll('.io-study-conflict').forEach(el => {
            const studyId = el.dataset.studyId;
            el.style.display = (mode === 'merge' && studyId) ? '' : 'none';
        });
    });
    document.getElementById('ims-confirm-btn').addEventListener('click', doImport);
}

// ── Export ────────────────────────────────────────────────────

function openExportSheet() {
    const list = document.getElementById('exs-list');
    document.getElementById('exs-select-all').checked = true;

    list.innerHTML = studiesState.studies.map(s => {
        const tags = (s.tags || []).map(t => `<span class="sd-tag-chip">${t}</span>`).join('');
        return `
            <label class="io-study-item">
                <input type="checkbox" class="exs-check" data-study-id="${s.id}" checked>
                <div class="io-study-info">
                    <div class="io-study-name">${s.name}</div>
                    <div class="io-study-meta">${s.entries.length} entradas</div>
                    ${tags ? `<div class="io-study-tags">${tags}</div>` : ''}
                </div>
            </label>
        `;
    }).join('');

    document.getElementById('export-sheet').classList.remove('exs-hidden');
}

function closeExportSheet() {
    document.getElementById('export-sheet').classList.add('exs-hidden');
}

function doExport() {
    const selected = [...document.querySelectorAll('.exs-check:checked')].map(cb => cb.dataset.studyId);
    if (!selected.length) { showSaveToast('Selecciona al menos un estudio'); return; }

    const studies = studiesState.studies.filter(s => selected.includes(s.id));
    const payload = { version: 1, exportedAt: new Date().toISOString(), studies };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `estudios-biblia-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    closeExportSheet();
    showSaveToast(`${studies.length} estudio(s) exportado(s)`);
}

// ── Import ────────────────────────────────────────────────────

let importStudiesBuffer = [];

function openImportSheet(studies) {
    importStudiesBuffer = studies;
    const list = document.getElementById('ims-list');
    const existingIds = new Set(studiesState.studies.map(s => s.id));
    const existingNames = new Set(studiesState.studies.map(s => s.name));

    document.getElementById('ims-select-all').checked = true;
    // Reset mode to merge
    document.querySelectorAll('.ims-mode-btn').forEach(b => b.classList.remove('ims-mode-active'));
    document.querySelector('.ims-mode-btn[data-mode="merge"]').classList.add('ims-mode-active');
    document.getElementById('ims-hint').textContent = 'Fusionar: agrega los estudios sin borrar los existentes. Si hay conflicto de ID, se omite el importado.';

    list.innerHTML = studies.map((s, i) => {
        const tags = (s.tags || []).map(t => `<span class="sd-tag-chip">${t}</span>`).join('');
        const hasIdConflict = existingIds.has(s.id);
        const hasNameConflict = !hasIdConflict && existingNames.has(s.name);
        const conflictMsg = hasIdConflict
            ? '⚠️ Ya existe un estudio con este ID (se omitirá al fusionar)'
            : hasNameConflict ? '⚠️ Ya existe un estudio con este nombre' : '';
        return `
            <label class="io-study-item">
                <input type="checkbox" class="ims-check" data-idx="${i}" checked>
                <div class="io-study-info">
                    <div class="io-study-name">${s.name}</div>
                    <div class="io-study-meta">${(s.entries || []).length} entradas</div>
                    ${tags ? `<div class="io-study-tags">${tags}</div>` : ''}
                    ${conflictMsg ? `<div class="io-study-conflict" data-study-id="${hasIdConflict ? s.id : ''}">${conflictMsg}</div>` : ''}
                </div>
            </label>
        `;
    }).join('');

    document.getElementById('import-sheet').classList.remove('ims-hidden');
}

function closeImportSheet() {
    document.getElementById('import-sheet').classList.add('ims-hidden');
    importStudiesBuffer = [];
}

function doImport() {
    const selectedIdxs = [...document.querySelectorAll('.ims-check:checked')].map(cb => parseInt(cb.dataset.idx));
    if (!selectedIdxs.length) { showSaveToast('Selecciona al menos un estudio'); return; }

    const mode = document.querySelector('.ims-mode-btn.ims-mode-active').dataset.mode;
    const selected = selectedIdxs.map(i => importStudiesBuffer[i]);
    const existingIds = new Set(studiesState.studies.map(s => s.id));
    let added = 0, replaced = 0;

    selected.forEach(s => {
        const study = { ...s, tags: s.tags || [], entries: s.entries || [] };
        if (existingIds.has(s.id)) {
            if (mode === 'replace') {
                studiesState = { ...studiesState, studies: studiesState.studies.map(ex => ex.id === s.id ? study : ex) };
                replaced++;
            }
            // merge: skip
        } else {
            studiesState = { ...studiesState, studies: [...studiesState.studies, study] };
            existingIds.add(s.id);
            added++;
        }
    });

    studiesSave(studiesState);
    renderStudiesDropdown();
    closeImportSheet();
    const msg = [added && `${added} añadido(s)`, replaced && `${replaced} reemplazado(s)`].filter(Boolean).join(', ');
    showSaveToast(msg || 'Sin cambios');
}

// ── Compartir por WhatsApp ────────────────────────────────────

const WA_NUMBER = '573205731318';

function openWaSheet() {
    const list = document.getElementById('was-list');
    document.getElementById('was-select-all').checked = true;

    list.innerHTML = studiesState.studies.map(s => {
        const tags = (s.tags || []).map(t => `<span class="sd-tag-chip">${t}</span>`).join('');
        return `
            <label class="io-study-item">
                <input type="checkbox" class="was-check" data-study-id="${s.id}" checked>
                <div class="io-study-info">
                    <div class="io-study-name">${s.name}</div>
                    <div class="io-study-meta">${s.entries.length} entradas</div>
                    ${tags ? `<div class="io-study-tags">${tags}</div>` : ''}
                </div>
            </label>
        `;
    }).join('');

    document.getElementById('was-overlay').addEventListener('click', closeWaSheet);
    document.getElementById('was-close').addEventListener('click', closeWaSheet);
    document.getElementById('was-select-all').addEventListener('change', e => {
        document.querySelectorAll('.was-check').forEach(cb => cb.checked = e.target.checked);
    });
    document.getElementById('was-send-btn').onclick = doShareWhatsApp;

    document.getElementById('wa-sheet').classList.remove('was-hidden');
}

function closeWaSheet() {
    document.getElementById('wa-sheet').classList.add('was-hidden');
}

async function doShareWhatsApp() {
    const selected = [...document.querySelectorAll('.was-check:checked')].map(cb => cb.dataset.studyId);
    if (!selected.length) { showSaveToast('Selecciona al menos un estudio'); return; }

    const studies = studiesState.studies.filter(s => selected.includes(s.id));
    const payload = { version: 1, exportedAt: new Date().toISOString(), studies };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const filename = `estudios-biblia-${new Date().toISOString().slice(0,10)}.json`;
    const file = new File([blob], filename, { type: 'application/json' });

    closeWaSheet();

    // Web Share API con archivo (móvil)
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({
                files: [file],
                text: '📖 Te comparto mis estudios bíblicos. Impórtalos en la app Biblia NBV.'
            });
            return;
        } catch (e) {
            if (e.name === 'AbortError') return; // usuario canceló
        }
    }

    // Fallback: descarga el archivo y abre WhatsApp con texto
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    setTimeout(() => {
        const msg = encodeURIComponent('📖 Te comparto mis estudios bíblicos. Importa el archivo que acabo de enviar en la app Biblia NBV.');
        window.open(`https://wa.me/${WA_NUMBER}?text=${msg}`, '_blank');
    }, 800);
}

// ── Estudios compartidos ──────────────────────────────────────

const SHARED_API = 'https://api.github.com/repos/DavidGarrido/bibliaNBVOffline/contents/shared';
let sharedAllStudies = []; // lista plana de todos los estudios de todos los archivos

function setupSharedStudies() {
    document.getElementById('sd-shared-btn').addEventListener('click', () => {
        closeStudiesDropdown();
        openSharedSheet();
    });
    document.getElementById('shs-overlay').addEventListener('click', closeSharedSheet);
    document.getElementById('shs-close').addEventListener('click', closeSharedSheet);
    document.getElementById('shs-select-all').addEventListener('change', e => {
        document.querySelectorAll('.shs-check').forEach(cb => cb.checked = e.target.checked);
    });
    document.getElementById('shs-import-btn').addEventListener('click', doImportFromShared);

    const searchById = () => {
        const query = document.getElementById('shs-id-input').value.trim();
        if (!query) { renderSharedStudiesList(); return; }
        const match = sharedAllStudies.findIndex(s => s.id === query);
        if (match === -1) {
            document.getElementById('shs-list').innerHTML = '<div class="shs-error">No se encontró ningún estudio con ese ID.</div>';
            document.getElementById('shs-select-all-wrap').style.display = 'none';
            document.getElementById('shs-actions').style.display = 'none';
        } else {
            // Muestra solo el que coincide, pre-seleccionado
            const s = sharedAllStudies[match];
            const tags = (s.tags || []).map(t => `<span class="sd-tag-chip">${t}</span>`).join('');
            const existingIds = new Set(studiesState.studies.map(st => st.id));
            const conflict = existingIds.has(s.id) ? '<div class="io-study-conflict">⚠️ Ya tienes este estudio</div>' : '';
            document.getElementById('shs-list').innerHTML = `
                <label class="io-study-item">
                    <input type="checkbox" class="shs-check" data-idx="${match}" checked>
                    <div class="io-study-info">
                        <div class="io-study-name">${s.name}</div>
                        <div class="io-study-meta">${(s.entries || []).length} entradas${s._exportedAt ? ' · ' + s._exportedAt : ''}</div>
                        ${tags ? `<div class="io-study-tags">${tags}</div>` : ''}
                        ${conflict}
                    </div>
                </label>`;
            document.getElementById('shs-select-all-wrap').style.display = 'none';
            document.getElementById('shs-actions').style.display = 'block';
        }
    };
    document.getElementById('shs-id-search-btn').addEventListener('click', searchById);
    document.getElementById('shs-id-input').addEventListener('keydown', e => { if (e.key === 'Enter') searchById(); });
}

function openSharedSheet() {
    document.getElementById('shared-sheet').classList.remove('shs-hidden');
    document.getElementById('shs-select-all-wrap').style.display = 'none';
    document.getElementById('shs-actions').style.display = 'none';
    document.getElementById('shs-list').innerHTML = '<div class="shs-loading">Cargando estudios...</div>';
    loadAllSharedStudies();
}

function closeSharedSheet() {
    document.getElementById('shared-sheet').classList.add('shs-hidden');
}

async function loadAllSharedStudies() {
    const list = document.getElementById('shs-list');
    try {
        const res = await fetch(SHARED_API, { headers: { Accept: 'application/vnd.github.v3+json' } });
        if (!res.ok) throw new Error();
        const files = (await res.json()).filter(f => f.type === 'file' && f.name.endsWith('.json'));

        if (!files.length) {
            list.innerHTML = '<div class="shs-empty">No hay estudios compartidos aún.</div>';
            return;
        }

        // Fetch all files in parallel and flatten studies
        const results = await Promise.all(files.map(f => fetch(f.download_url).then(r => r.json()).catch(() => null)));
        sharedAllStudies = [];
        results.forEach(data => {
            if (data && Array.isArray(data.studies)) {
                const date = data.exportedAt ? new Date(data.exportedAt).toLocaleDateString('es') : '';
                data.studies.forEach(s => sharedAllStudies.push({ ...s, _exportedAt: date }));
            }
        });

        if (!sharedAllStudies.length) {
            list.innerHTML = '<div class="shs-empty">No hay estudios compartidos aún.</div>';
            return;
        }

        renderSharedStudiesList();
    } catch {
        list.innerHTML = '<div class="shs-error">Error al cargar. Verifica tu conexión.</div>';
    }
}

function renderSharedStudiesList() {
    const list = document.getElementById('shs-list');
    const existingIds = new Set(studiesState.studies.map(s => s.id));

    list.innerHTML = sharedAllStudies.map((s, i) => {
        const tags = (s.tags || []).map(t => `<span class="sd-tag-chip">${t}</span>`).join('');
        const conflict = existingIds.has(s.id) ? '<div class="io-study-conflict">⚠️ Ya tienes este estudio</div>' : '';
        return `
            <label class="io-study-item">
                <input type="checkbox" class="shs-check" data-idx="${i}" ${conflict ? '' : 'checked'}>
                <div class="io-study-info">
                    <div class="io-study-name">${s.name}</div>
                    <div class="io-study-meta">${(s.entries || []).length} entradas${s._exportedAt ? ' · ' + s._exportedAt : ''}</div>
                    ${tags ? `<div class="io-study-tags">${tags}</div>` : ''}
                    ${conflict}
                </div>
            </label>
        `;
    }).join('');

    document.getElementById('shs-select-all').checked = true;
    document.getElementById('shs-select-all-wrap').style.display = 'flex';
    document.getElementById('shs-actions').style.display = 'block';
}

function doImportFromShared() {
    const selectedIdxs = [...document.querySelectorAll('.shs-check:checked')].map(cb => parseInt(cb.dataset.idx));
    if (!selectedIdxs.length) { showSaveToast('Selecciona al menos un estudio'); return; }

    const existingIds = new Set(studiesState.studies.map(s => s.id));
    let added = 0;

    selectedIdxs.forEach(i => {
        const s = sharedAllStudies[i];
        if (!s || existingIds.has(s.id)) return;
        const { _exportedAt, ...study } = s;
        studiesState = { ...studiesState, studies: [...studiesState.studies, { ...study, tags: study.tags || [], entries: study.entries || [] }] };
        existingIds.add(s.id);
        added++;
    });

    studiesSave(studiesState);
    renderStudiesDropdown();
    closeSharedSheet();
    showSaveToast(added ? `${added} estudio(s) importado(s)` : 'Sin cambios (ya los tienes)');
}

// ── Referencias cruzadas ──────────────────────────────────────

let crossRefData = null;
let crossRefLoading = false;

async function loadCrossRefs() {
    if (crossRefData) return crossRefData;
    if (crossRefLoading) return null;
    crossRefLoading = true;
    try {
        const resp = await fetch('./cross-references.json');
        crossRefData = await resp.json();
    } catch (e) {
        crossRefData = null;
    }
    crossRefLoading = false;
    return crossRefData;
}

async function handleCrossRef() {
    if (!selectedVerseEl) return;
    const { verseN, chapN } = getVerseInfo(selectedVerseEl);
    const key = `${currentBook.id}_${chapN}_${verseN}`;
    const ref = `${currentBook.name} ${chapN}:${verseN}`;

    document.getElementById('crm-title').textContent = `Referencias · ${ref}`;
    document.getElementById('crm-list').innerHTML = '<div class="crm-empty">Cargando...</div>';
    document.getElementById('crossref-modal').classList.remove('crm-hidden');

    const data = await loadCrossRefs();
    const list = document.getElementById('crm-list');

    if (!data || !data[key]) {
        list.innerHTML = '<div class="crm-empty">No hay referencias cruzadas para este versículo.</div>';
        return;
    }

    const refs = data[key];
    const items = refs.map(([bid, chap, vers]) => {
        const book = bibleData.find(b => b.id === bid);
        if (!book) return null;
        const chapData = book.chapters.find(c => c.n === chap);
        const verseData = chapData?.v.find(v => v.n == vers);
        if (!verseData) return null;
        const refStr = `${book.name} ${chap}:${vers}`;
        return { book, chap, vers, ref: refStr, text: verseData.t };
    }).filter(Boolean);

    if (!items.length) {
        list.innerHTML = '<div class="crm-empty">No se pudieron cargar las referencias.</div>';
        return;
    }

    list.innerHTML = items.map((item, i) => `
        <div class="crm-item" data-idx="${i}">
            <span class="crm-item-ref">${item.ref}</span>
            <span class="crm-item-text">${item.text}</span>
        </div>
    `).join('');

    list.querySelectorAll('.crm-item').forEach((el, i) => {
        el.addEventListener('click', () => {
            const item = items[i];
            document.getElementById('crossref-modal').classList.add('crm-hidden');
            clearVerseSelection();
            pendingVerse = item.vers;
            pendingChapterN = item.chap;
            showChapters(item.book);
            showReader(item.book, item.book.chapters.find(c => c.n === item.chap));
        });
    });
}

// ── Generador de imagen de versículo ──────────────────────────

function handleVerseImage() {
    if (!selectedVerseEl) return;
    const { verseN: startN, chapN } = getVerseInfo(selectedVerseEl);
    const tid = elements.translationSelect.value.toUpperCase();

    let ref, text;
    if (selectedVerseEndEl) {
        const { verseN: endN } = getVerseInfo(selectedVerseEndEl);
        const minN = Math.min(startN, endN);
        const maxN = Math.max(startN, endN);
        ref  = `${currentBook.name} ${chapN}:${minN}-${maxN}`;
        const chapData = currentBook.chapters.find(c => c.n === chapN);
        const verses   = (chapData?.v || []).filter(v => parseInt(v.n) >= minN && parseInt(v.n) <= maxN);
        text = verses.map(v => `${v.n} ${v.t}`).join(' ');
    } else {
        ref  = `${currentBook.name} ${chapN}:${startN}`;
        const vtEl = selectedVerseEl.querySelector('.v-text');
        text = vtEl ? vtEl.textContent.trim() : selectedVerseEl.textContent.replace(/^\d+\s*/, '').trim();
    }

    document.getElementById('vim-ref').textContent = ref;
    document.getElementById('verse-img-modal').classList.remove('vim-hidden');
    generateVerseImage(ref, text, tid);
}

function canvasWrapText(ctx, text, maxWidth) {
    const words = text.split(' ');
    const lines = [];
    let line = '';
    for (const word of words) {
        const test = line ? line + ' ' + word : word;
        if (ctx.measureText(test).width > maxWidth && line) {
            lines.push(line);
            line = word;
        } else {
            line = test;
        }
    }
    if (line) lines.push(line);
    return lines;
}

async function generateVerseImage(ref, text, tid) {
    const W = 1080, H = 1920;
    const canvas = document.getElementById('vim-canvas');
    canvas.width  = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    // Fondo: blanco roto suave con toque cálido
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0,   '#faf9f7');
    grad.addColorStop(1,   '#f2ede8');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Tarjeta interior con sombra suave
    const CX = 80, CY = 80, CW = W - 160, CH = H - 160, CR = 60;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.08)';
    ctx.shadowBlur  = 80;
    ctx.shadowOffsetY = 20;
    ctx.beginPath();
    ctx.roundRect(CX, CY, CW, CH, CR);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();

    // Logo
    await new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            const maxS = 160;
            const ratio = Math.min(maxS / img.width, maxS / img.height);
            const lw = img.width * ratio, lh = img.height * ratio;
            ctx.drawImage(img, (W - lw) / 2, 200, lw, lh);
            resolve();
        };
        img.onerror = resolve;
        img.src = './logo_iglesia.jpg';
    });

    // Separador fino bajo el logo
    ctx.strokeStyle = 'rgba(0,0,0,0.07)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 100, 410);
    ctx.lineTo(W / 2 + 100, 410);
    ctx.stroke();

    // Comilla decorativa — tenue, elegante
    ctx.font = '280px Georgia, serif';
    ctx.fillStyle = 'rgba(180,150,100,0.12)';
    ctx.textAlign = 'left';
    ctx.fillText('\u201C', 100, 780);

    // Texto del versículo — ajuste automático de tamaño
    const PAD = 140;
    const maxTextW = W - PAD * 2;
    const maxTextH = 880;
    let fontSize = 58;
    let lines;
    while (fontSize >= 28) {
        ctx.font = `300 ${fontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif`;
        lines = canvasWrapText(ctx, text, maxTextW);
        if (lines.length * fontSize * 1.65 <= maxTextH) break;
        fontSize -= 3;
    }

    const lineH  = fontSize * 1.72;
    const totalH = lines.length * lineH;
    let y = H / 2 - totalH / 2 + 80;

    ctx.fillStyle = '#1c1c1e';
    ctx.textAlign = 'center';
    ctx.font = `300 ${fontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif`;
    for (const line of lines) {
        ctx.fillText(line, W / 2, y);
        y += lineH;
    }

    // Comilla de cierre
    ctx.font = '280px Georgia, serif';
    ctx.fillStyle = 'rgba(180,150,100,0.12)';
    ctx.textAlign = 'right';
    ctx.fillText('\u201D', W - 100, y + 60);

    // Punto decorativo centrado
    ctx.beginPath();
    ctx.arc(W / 2, H - 340, 5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(150,120,80,0.4)';
    ctx.fill();

    // Línea divisora — dos segmentos con punto central
    ctx.strokeStyle = 'rgba(150,120,80,0.25)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 200, H - 340);
    ctx.lineTo(W / 2 - 22, H - 340);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(W / 2 + 22, H - 340);
    ctx.lineTo(W / 2 + 200, H - 340);
    ctx.stroke();

    // Referencia
    ctx.font = `600 50px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif`;
    ctx.fillStyle = '#3a2e20';
    ctx.textAlign = 'center';
    ctx.fillText(ref, W / 2, H - 255);

    // Traducción
    ctx.font = `400 34px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif`;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillText(tid, W / 2, H - 195);

    // Nombre de la iglesia
    ctx.font = `400 26px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif`;
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillText('Iglesia Cristiana Reflexiones Bíblicas I.D.S.D.', W / 2, H - 130);
}

async function shareVerseImage() {
    const canvas = document.getElementById('vim-canvas');
    canvas.toBlob(async blob => {
        const ref = document.getElementById('vim-ref').textContent;
        const file = new File([blob], 'versiculo.png', { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            try {
                await navigator.share({ files: [file], title: ref });
                return;
            } catch (_) { /* cancelado por el usuario */ }
        }
        // Fallback: descarga directa
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${ref.replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ0-9 :]/g, '')}.png`;
        a.click();
    }, 'image/png');
}
