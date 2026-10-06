const tg = window.Telegram.WebApp;
tg.expand();

// Evita que el browser restaure scroll al recargar (desplazaría la study-nav-bar fuera del viewport)
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

let bibleData = null;
let currentBook = null;
let currentChapter = null;
let translations = [];
const bibleCache = {};
let readingMode = localStorage.getItem('bible-reading-mode') || 'paged';
let chapterObserver = null;

// ── Comentarios bíblicos ──────────────────────────────────────
let commentaries = [];
let commentaryData = null;
let commentaryCache = {};

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
        back.textContent = `⬅ ${data.bookName || 'Cap.'}`;
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
    await initCommentaries();
}

async function initCommentaries() {
    try {
        const res = await fetch('commentaries.json');
        commentaries = await res.json();
    } catch (e) {
        commentaries = [];
    }

    const select = document.getElementById('cfg-commentary-select');
    if (!select) return;

    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = 'Ninguno';
    select.appendChild(noneOpt);

    commentaries.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.label;
        select.appendChild(opt);
    });

    const savedCommentary = localStorage.getItem('bible-commentary') || '';
    select.value = savedCommentary;

    select.addEventListener('change', async () => {
        const id = select.value;
        localStorage.setItem('bible-commentary', id);
        commentaryData = null;
        if (id) await loadCommentary(id);
        reapplyCommentaryNotes();
    });

    if (savedCommentary) await loadCommentary(savedCommentary);
}

async function loadCommentary(id) {
    if (commentaryCache[id]) {
        commentaryData = commentaryCache[id];
        return;
    }
    const c = commentaries.find(c => c.id === id);
    if (!c) return;
    try {
        const res = await fetch(c.file);
        commentaryData = await res.json();
        commentaryCache[id] = commentaryData;
    } catch (e) {
        commentaryData = null;
    }
}

function getCommentaryLabel() {
    const id = localStorage.getItem('bible-commentary') || '';
    const c = commentaries.find(c => c.id === id);
    return c ? c.label.split(' ')[0] : '';
}

function injectCommentaryNotes(container, bookId, fixedChapN = null) {
    if (!commentaryData || !bookId) return;
    container.querySelectorAll('.verse').forEach(verseEl => {
        const verseN = parseInt(verseEl.querySelector('.v-num')?.textContent);
        const chapN = fixedChapN ?? parseInt(verseEl.getAttribute('data-chap'));
        if (!chapN || !verseN) return;
        const key = `${bookId}_${chapN}_${verseN}`;
        const note = commentaryData[key];
        if (!note) return;
        // Evitar duplicar
        if (verseEl.nextSibling && verseEl.nextSibling.classList?.contains('commentary-note')) return;
        const noteEl = document.createElement('div');
        noteEl.className = 'commentary-note';
        noteEl.innerHTML = `<span class="cn-label">${getCommentaryLabel()}</span>${note}`;
        verseEl.after(noteEl);
        attachNoteRefListeners(noteEl);
    });
}

function removeCommentaryNotes(container) {
    container.querySelectorAll('.commentary-note').forEach(el => el.remove());
}

function reapplyCommentaryNotes() {
    if (!currentBook || elements.viewReader.style.display !== 'block') return;
    const container = readingMode === 'paged'
        ? document.getElementById('pages-strip')
        : elements.versesContent;
    if (!container) return;
    removeCommentaryNotes(container);
    if (commentaryData) {
        injectCommentaryNotes(container, currentBook.id, readingMode === 'paged' ? currentChapter?.n : null);
    }
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

    // Banner retorno si hay lectura activa
    if (!filter && currentChapter && currentChapter._bookId) {
        const readerBook = bibleData.find(b => b.id === currentChapter._bookId);
        if (readerBook) {
            const banner = document.createElement('li');
            banner.className = 'chap-return-banner books-return-banner';
            banner.innerHTML = `<span>Leyendo ${readerBook.name} ${currentChapter.n}</span><span class="chap-return-label">Volver ›</span>`;
            banner.onclick = () => returnToReader(readerBook);
            elements.booksList.appendChild(banner);
        }
    }

    const filtered = bibleData.filter(b =>
        b.name.toLowerCase().includes(filter.toLowerCase())
    );
    filtered.forEach(book => {
        const li = document.createElement('li');
        li.innerText = book.name;
        if (currentBook && book.id === currentBook.id) li.classList.add('book-item--current');
        li.onclick = () => showChapters(book);
        elements.booksList.appendChild(li);
    });
}

function showChapters(book) {
    currentBook = book;
    elements.chaptersGrid.innerHTML = '';

    // Guardar título del reader antes de que se sobreescriba
    if (elements.viewReader.style.display === 'block') {
        lastReaderTitle = document.getElementById('tb-title').textContent;
    }

    // Banner "seguir leyendo" si hay capítulo activo de este libro
    const prevChapter = currentChapter;
    if (prevChapter && prevChapter._bookId === book.id) {
        const banner = document.createElement('div');
        banner.className = 'chap-return-banner';
        banner.innerHTML = `<span>Leyendo ${prevChapter.n}</span><span class="chap-return-label">Volver ›</span>`;
        banner.onclick = () => returnToReader(book);
        elements.chaptersGrid.appendChild(banner);
    }

    book.chapters.forEach(chap => {
        const btn = document.createElement('div');
        btn.className = 'chapter-btn';
        if (prevChapter && prevChapter._bookId === book.id && chap.n === prevChapter.n) btn.classList.add('chapter-btn--current');
        btn.innerText = chap.n;
        btn.onclick = () => showReader(book, chap);
        elements.chaptersGrid.appendChild(btn);
    });
    switchView('chapters');
    updateTopBar('chapters', { bookName: book.name });
}

function returnToReader(book) {
    switchView('reader');
    const title = document.getElementById('tb-title');
    const back = document.getElementById('tb-back');
    if (title && lastReaderTitle) title.textContent = lastReaderTitle;
    if (back) {
        back.textContent = `⬅ ${book.name}`;
        back.classList.remove('tb-hidden');
        back.onclick = () => { cleanupPageMode(); showChapters(book); };
    }
}

const HIST_KEY = 'bible-visit-history';

function histPush(book, chapter) {
    const verseN = pendingVerse || null;
    const ref = verseN ? `${book.name} ${chapter.n}:${verseN}` : `${book.name} ${chapter.n}`;
    const entry = { ref, bookId: book.id, chapN: chapter.n, verseN };
    let hist = histLoad();
    hist = hist.filter(h => !(h.bookId === entry.bookId && h.chapN === entry.chapN && h.verseN === entry.verseN));
    hist.push(entry);
    if (hist.length > 10) hist.shift();
    localStorage.setItem(HIST_KEY, JSON.stringify(hist));
}

function histLoad() {
    try { return JSON.parse(localStorage.getItem(HIST_KEY)) || []; } catch { return []; }
}

function openHistModal() {
    const hist = histLoad();
    const list = document.getElementById('snbh-list');
    list.innerHTML = hist.length
        ? hist.map(h => `<div class="snbh-item" data-book-id="${h.bookId}" data-chap="${h.chapN}"${h.verseN ? ` data-verse="${h.verseN}"` : ''}>
            <span class="snbh-item-ref">${h.ref}</span>
            <span class="snbh-item-arrow">→</span>
          </div>`).join('')
        : '<div style="padding:20px;color:var(--airbnb-foggy);text-align:center;font-size:14px">Sin historial aún</div>';
    list.querySelectorAll('.snbh-item').forEach(el => {
        el.addEventListener('click', () => {
            const bookId = parseInt(el.dataset.bookId);
            const chapN = parseInt(el.dataset.chap);
            const verseN = el.dataset.verse ? parseInt(el.dataset.verse) : null;
            const book = bibleData?.find(b => b.id === bookId);
            const chapter = book?.chapters.find(c => c.n === chapN);
            if (!book || !chapter) return;
            closeHistModal();
            if (verseN) pendingVerse = verseN;
            pendingChapterN = chapN;
            cleanupPageMode();
            showChapters(book);
            showReader(book, chapter);
        });
    });
    document.getElementById('snb-hist-modal').classList.remove('snbh-hidden');
}

function closeHistModal() {
    document.getElementById('snb-hist-modal').classList.add('snbh-hidden');
}

function showReader(book, chapter) {
    histPush(book, chapter);
    clearVerseSelection();
    chapter._bookId = book.id;
    const back = document.getElementById('tb-back');
    if (back) {
        back.textContent = `⬅ ${book.name}`;
        back.classList.remove('tb-hidden');
        back.onclick = () => { cleanupPageMode(); showChapters(book); };
    }
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
    document.getElementById('tb-title').textContent = `${chapter.n}`;
    elements.versesContent.innerHTML = '';
    elements.chapNav.style.display = 'none';

    // Fase 1: renderizar en div oculto para medir alturas (incluye notas si hay comentario)
    const measurer = document.createElement('div');
    measurer.style.visibility = 'hidden';
    chapter.v.forEach(v => {
        const p = document.createElement('div');
        p.className = 'verse';
        p.innerHTML = `<span class="v-num">${v.n}</span><span class="v-text"> ${v.t}</span>`;
        measurer.appendChild(p);
        if (commentaryData) {
            const key = `${book.id}_${chapter.n}_${v.n}`;
            const note = commentaryData[key];
            if (note) {
                const noteEl = document.createElement('div');
                noteEl.className = 'commentary-note';
                noteEl.innerHTML = `<span class="cn-label">${getCommentaryLabel()}</span>${note}`;
                measurer.appendChild(noteEl);
            }
        }
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
        // El slot de cada verso incluye la nota: su fondo es el offsetTop del siguiente verso
        const verseEls = [...measurer.querySelectorAll('.verse')];
        pageBreaks = [0];
        let pageStart = 0;
        for (let i = 0; i < verseEls.length; i++) {
            const slotEnd = verseEls[i + 1] ? verseEls[i + 1].offsetTop : measurer.scrollHeight;
            if (slotEnd - pageStart > pageHeight) {
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
        injectCommentaryNotes(strip, book.id, chapter.n);

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
        document.getElementById('tb-title').textContent = verseRange.trim().replace(/^·\s*/, '');
    } else {
        document.getElementById('tb-title').textContent = `${currentChapter.n}  ·  ${currentPageNum + 1}/${totalPageCount}`;
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
    document.getElementById('tb-title').textContent = `${chapter.n}`;
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
                    document.getElementById('tb-title').textContent = `${chapN}`;
                    savePosition(book, chap, {});
                }
            }
        });
    }, { rootMargin: '-10% 0px -80% 0px' });

    elements.versesContent.querySelectorAll('.chap-header').forEach(h => chapterObserver.observe(h));
    applyStudyMarkers(elements.versesContent);
    injectCommentaryNotes(elements.versesContent, book.id);

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
                    document.getElementById('tb-title').textContent = `${chapN}:${verseN}`;
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

// Botones de navegación de capítulo
document.getElementById('prev-chap')?.addEventListener('click', () => simulateSwipe('right'));
document.getElementById('next-chap')?.addEventListener('click', () => simulateSwipe('left'));

// Botones flotantes PC
document.getElementById('pc-prev-btn')?.addEventListener('click', () => simulateSwipe('right'));
document.getElementById('pc-next-btn')?.addEventListener('click', () => simulateSwipe('left'));

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
    if (view === 'books') { lastScrollY = 0; updateTopBar('books'); if (bibleData) renderBooks(); }
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
let lastReaderTitle = '';
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
    const items = [];

    // Si no es referencia válida, buscar palabra en la Biblia
    if (!parsed && raw.trim().length >= 2) {
        const bible = bibleCache[elements.translationSelect.value] || bibleData;
        const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

        const words = raw.trim().split(/\s+/);
        let bookScope = null;
        let scopeLabel = 'la Biblia';
        let scopeBooks = null; // null = toda la Biblia, array de ids = filtrado

        if (!qsForceFullSearch && words.length >= 2) {
            const firstWord = norm(words[0]);

            // Detectar prefijo AT / NT
            if (['at', 'antiguo'].includes(firstWord)) {
                bookScope = { searchTerm: words.slice(1).join(' '), label: 'Antiguo Testamento' };
                scopeBooks = (bible || []).filter(b => b.id <= 39).map(b => b.id);
                scopeLabel = 'el Antiguo Testamento';
            } else if (['nt', 'nuevo'].includes(firstWord)) {
                bookScope = { searchTerm: words.slice(1).join(' '), label: 'Nuevo Testamento' };
                scopeBooks = (bible || []).filter(b => b.id >= 40).map(b => b.id);
                scopeLabel = 'el Nuevo Testamento';
            } else {
                // Detectar nombre de libro como prefijo
                for (let len = Math.min(words.length - 1, 3); len >= 1; len--) {
                    const prefix = words.slice(0, len).join(' ');
                    const matchedBooks = findBooks(prefix);
                    if (matchedBooks.length > 0) {
                        bookScope = { searchTerm: words.slice(len).join(' '), label: matchedBooks.map(b => b.name).join(', ') };
                        scopeBooks = matchedBooks.map(b => b.id);
                        scopeLabel = matchedBooks.map(b => b.name).join(', ');
                        break;
                    }
                }
            }
        }

        const searchTerms = norm(bookScope ? bookScope.searchTerm : raw.trim()).split(/\s+/).filter(t => t.length > 0);

        const searchResults = [];
        if (bible && searchTerms.length > 0) {
            for (const book of bible) {
                if (scopeBooks && !scopeBooks.includes(book.id)) continue;
                for (const chapter of book.chapters) {
                    for (const verse of chapter.v) {
                        if (searchTerms.every(term => norm(verse.t).includes(term))) {
                            searchResults.push({ book, chapter, verse });
                        }
                    }
                }
            }
        }

        if (searchResults.length > 0) {
            items.push({
                type: 'word-search',
                icon: '🔍',
                title: bookScope
                    ? `"${bookScope.searchTerm}" en ${scopeLabel}`
                    : `"${raw.trim()}" en la Biblia`,
                sub: `${searchResults.length} versículos encontrados`,
                searchTerm: bookScope ? bookScope.searchTerm : raw.trim()
            });
            // Fallback antes de los resultados
            if (bookScope) {
                items.push({
                    type: 'word-search-fallback',
                    icon: '🌐',
                    title: `Buscar "${raw.trim()}" en toda la Biblia`,
                    sub: null
                });
            }
            searchResults.forEach(result => {
                const ref = `${result.book.name} ${result.chapter.n}:${result.verse.n}`;
                items.push({
                    type: 'verse',
                    icon: '📖',
                    bookName: result.book.name,
                    title: ref,
                    sub: result.verse.t,
                    verseData: { ref, bookId: result.book.id, chapN: result.chapter.n, verseN: parseInt(result.verse.n), text: result.verse.t },
                    action: () => {
                        const chapObj = result.book.chapters.find(c => c.n === result.chapter.n);
                        if (chapObj) {
                            pendingVerse = parseInt(result.verse.n);
                            pendingChapterN = result.chapter.n;
                            closeQS();
                            showChapters(result.book);
                            showReader(result.book, chapObj);
                        }
                    }
                });
            });
        }

        return items;
    }

    if (!parsed) return [];

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
                            studyNavUpdate();
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
                        studyNavUpdate();
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

        // También buscar la palabra en versículos (el término puede ser nombre de libro y palabra)
        if (raw.trim().length >= 2) {
            const searchTerms = raw.trim().toLowerCase().split(/\s+/).filter(t => t.length > 0);
            const bible = bibleCache[elements.translationSelect.value] || bibleData;
            const searchResults = [];
            if (bible) {
                for (const book of bible) {
                    for (const chapter of book.chapters) {
                        for (const verse of chapter.v) {
                            if (searchTerms.every(term => verse.t.toLowerCase().includes(term))) {
                                searchResults.push({ book, chapter, verse });
                            }
                        }
                    }
                }
            }
            if (searchResults.length > 0) {
                items.push({
                    type: 'word-search',
                    icon: '🔍',
                    title: `"${raw.trim()}" en versículos`,
                    sub: `${searchResults.length} versículos encontrados`,
                    searchTerm: raw.trim()
                });
                searchResults.forEach(result => {
                    items.push({
                        type: 'verse',
                        icon: '📖',
                        bookName: result.book.name,
                        title: `${result.book.name} ${result.chapter.n}:${result.verse.n}`,
                        sub: result.verse.t,
                        verseData: { ref: `${result.book.name} ${result.chapter.n}:${result.verse.n}`, bookId: result.book.id, chapN: result.chapter.n, verseN: parseInt(result.verse.n), text: result.verse.t },
                        action: () => {
                            const chapObj = result.book.chapters.find(c => c.n === result.chapter.n);
                            if (chapObj) {
                                pendingVerse = parseInt(result.verse.n);
                                pendingChapterN = result.chapter.n;
                                closeQS();
                                showChapters(result.book);
                                showReader(result.book, chapObj);
                            }
                        }
                    });
                });
            }
        }
    }

    return items.some(i => i.type === 'word-search') ? items : items.slice(0, 6);
}

// Estado del buscador de palabras
let qsWordSearchTerm = '';
let qsForceFullSearch = false;

function renderQSWordSearch() {
    const wordSearchDiv = document.getElementById('qs-word-search');
    const wordCount = document.getElementById('qs-word-count');
    const results = document.getElementById('qs-results');
    const items = results.querySelectorAll('.qs-item');

    // Si ya es una búsqueda de palabra (word-search), ocultar el buscador adicional
    const isWordSearch = qsSuggestions.some(item => item.type === 'word-search');
    if (isWordSearch) {
        wordSearchDiv.classList.add('qsw-hidden');
        return;
    }

    // Mostrar buscador solo si hay versículos (type === 'verse' o 'chapter' con contenido)
    const hasVerseContent = qsSuggestions.some(item => item.type === 'verse' || item.rangeText);
    if (!hasVerseContent) {
        wordSearchDiv.classList.add('qsw-hidden');
        return;
    }

    wordSearchDiv.classList.remove('qsw-hidden');

    if (!qsWordSearchTerm) {
        wordCount.textContent = '';
        items.forEach(item => item.classList.remove('qs-word-hidden'));
        return;
    }

    // Filtrar versículos por palabra
    let visibleCount = 0;
    const term = qsWordSearchTerm.toLowerCase();
    items.forEach(item => {
        const itemData = qsSuggestions[Array.from(items).indexOf(item)];
        let textToSearch = '';

        if (itemData.rangeText) {
            textToSearch = itemData.rangeText;
        } else if (itemData.sub) {
            textToSearch = itemData.sub;
        }

        const matches = textToSearch.toLowerCase().includes(term);
        if (matches) {
            item.classList.remove('qs-word-hidden');
            // Resaltar palabra encontrada
            const subEl = item.querySelector('.qs-item-sub');
            if (subEl) {
                const regex = new RegExp(`(${qsWordSearchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
                // Restaurar texto plano antes de re-aplicar highlight
                subEl.innerHTML = subEl.innerHTML.replace(/<span class="highlight">([^<]*)<\/span>/g, '$1');
                subEl.innerHTML = subEl.innerHTML.replace(regex, '<span class="highlight">$1</span>');
            }
            visibleCount++;
        } else {
            item.classList.add('qs-word-hidden');
        }
    });

    wordCount.textContent = `${visibleCount} resultado${visibleCount !== 1 ? 's' : ''}`;
}

function renderQS() {
    const input = document.getElementById('qs-input');
    const results = document.getElementById('qs-results');
    const hint = document.getElementById('qs-hint');
    qsForceFullSearch = false;
    qsSuggestions = buildQsSuggestions(input.value);
    qsActiveIdx = -1;
    qsLastTappedTitle = null;
    qsWordSearchTerm = '';
    document.getElementById('qs-word-input').value = '';
    results.innerHTML = '';
    hint.style.display = qsSuggestions.length ? 'none' : 'block';

    qsSuggestions.forEach((item, i) => {
        const div = document.createElement('div');
        div.className = 'qs-item'
            + (item.type === 'word-search' ? ' qs-word-search-header' : '')
            + (item.type === 'word-search-fallback' ? ' qs-word-search-fallback' : '');
        div.innerHTML = `
            <span class="qs-item-icon">${item.icon}</span>
            <div class="qs-item-main">
                <div class="qs-item-title">${item.title}</div>
                ${item.rangeText
                    ? `<div class="qs-item-sub qs-item-range">${item.rangeText.replace(/\n/g, '<br>')}</div>`
                    : item.sub ? `<div class="qs-item-sub qs-item-verse-text">${item.sub}</div>` : ''}
                ${item.verseData ? `<button class="qs-save-btn">💾 Guardar</button>` : ''}
            </div>`;
        div.addEventListener('click', () => {
            if (item.type === 'word-search-fallback') {
                qsForceFullSearch = true;
                renderQS();
                return;
            } else if (!item.action) {
                // Item sin acción (ej: encabezado de búsqueda de palabra)
                return;
            } else if (item.type !== 'book') {
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
                    studyNavUpdate();
                    showSaveToast('Guardado ✓');
                    saveBtn.textContent = '✓ Guardado';
                    saveBtn.disabled = true;
                }
            });
        }

        results.appendChild(div);
    });

    // Mostrar buscador de palabras si hay resultados con contenido de versículos
    renderQSWordSearch();
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

let qsDebounceTimer = null;
document.getElementById('qs-input').addEventListener('input', () => {
    clearTimeout(qsDebounceTimer);
    qsDebounceTimer = setTimeout(renderQS, 350);
});

// Buscador de palabras dentro de los resultados
document.getElementById('qs-word-input').addEventListener('input', (e) => {
    qsWordSearchTerm = e.target.value;
    renderQSWordSearch();
});

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
    // Cerrar verse-actions con ESC en PC
    if (e.key === 'Escape' && window.innerWidth >= 1024) {
        const va = document.getElementById('verse-actions');
        if (va.classList.contains('va-active')) {
            va.classList.remove('va-active');
            document.querySelectorAll('.verse-selected').forEach(el => el.classList.remove('verse-selected'));
            return;
        }
    }
    if (document.getElementById('quick-search').classList.contains('qs-hidden')) return;
    if (e.key === 'Escape') { closeQS(); return; }
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault();
        if (!qsSuggestions.length) return;
        qsActiveIdx = (qsActiveIdx + 1) % qsSuggestions.length;
        updateQsActive();
        if (qsSuggestions[qsActiveIdx].bookName) document.getElementById('qs-input').value = qsSuggestions[qsActiveIdx].bookName;
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
        e.preventDefault();
        if (!qsSuggestions.length) return;
        qsActiveIdx = (qsActiveIdx - 1 + qsSuggestions.length) % qsSuggestions.length;
        updateQsActive();
        if (qsSuggestions[qsActiveIdx].bookName) document.getElementById('qs-input').value = qsSuggestions[qsActiveIdx].bookName;
    } else if (e.key === 'Enter') {
        const target = qsActiveIdx >= 0 ? qsSuggestions[qsActiveIdx] : qsSuggestions[0];
        if (target?.action) target.action();
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

    // Quitar checkboxes en PC
    if (window.innerWidth >= 1024) {
        elements.versesContent.querySelectorAll('.verse-checkbox').forEach(cb => cb.remove());
        elements.versesContent.querySelectorAll('.verse').forEach(v => v.classList.remove('verse-checkboxes-visible'));
    }
}

function showVerseCheckboxes() {
    if (window.innerWidth < 1024) return;
    elements.versesContent.querySelectorAll('.verse').forEach(verseEl => {
        if (verseEl.querySelector('.verse-checkbox')) return;
        const vNum = verseEl.querySelector('.v-num');
        if (!vNum) return;
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'verse-checkbox';
        vNum.parentNode.insertBefore(checkbox, vNum);
        verseEl.classList.add('verse-checkboxes-visible');
    });
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
        const checkbox = el.querySelector('.verse-checkbox');
        if (vChap === chapN && verseN >= minN && verseN <= maxN) {
            el.classList.add('verse-in-range');
            if (checkbox) checkbox.checked = true;
        } else {
            if (checkbox) checkbox.checked = false;
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
    if (e.target.classList.contains('verse-checkbox')) return;
    // Ignora el click que sigue a un long-press (ya gestionado por el timer)
    if (Date.now() - verseLongPressAt < 800) return;
    const verseEl = e.target.closest('.verse');
    if (!verseEl) { clearVerseSelection(); return; }

    const isPC = window.innerWidth >= 1024;

    if (isPC) {
        // En PC: click selecciona verso y muestra checkboxes
        if (!selectedVerseEl) {
            showVerseCheckboxes();
        }
        if (selectedVerseEl && selectedVerseEl !== verseEl) {
            selectedVerseEndEl = verseEl;
            highlightVerseRange();
        } else {
            selectedVerseEl = verseEl;
            verseEl.classList.add('verse-selected');
            const checkbox = verseEl.querySelector('.verse-checkbox');
            if (checkbox) checkbox.checked = true;
        }
        updateVerseActionBar();
        document.getElementById('verse-actions').classList.add('va-active');
        return;
    }

    // Móvil: click simple solo selecciona un verso (no rango)
    if (selectedVerseEl === verseEl) {
        clearVerseSelection();
        return;
    }

    // Click en otro verso reemplaza la selección (sin rango)
    clearVerseSelection();
    selectedVerseEl = verseEl;
    verseEl.classList.add('verse-selected');
    updateVerseActionBar();
    document.getElementById('verse-actions').classList.add('va-active');

    // Mostrar toast de hint rango en móvil
    if (!isPC) {
        showSaveToast('Mantén presionado un segundo verso para seleccionar un grupo');
    }
});

// Long-press táctil para rango en móvil.
// iOS no dispara contextmenu de forma fiable y el long-press nativo
// selecciona la palabra; por eso se usa timer propio y se limpia la
// selección nativa al disparar.
let rangeModeTimeout = null;
let verseLongPressTimer = null;
let verseLongPressStartX = 0;
let verseLongPressStartY = 0;
let verseLongPressEl = null;
let verseLongPressAt = 0;
const VERSE_LONGPRESS_MS = 500;

elements.versesContent.addEventListener('touchstart', e => {
    if (window.innerWidth >= 1024 || e.touches.length !== 1) return;
    verseLongPressEl = e.target.closest ? e.target.closest('.verse') : null;
    if (!verseLongPressEl) return;
    verseLongPressStartX = e.touches[0].clientX;
    verseLongPressStartY = e.touches[0].clientY;
    clearTimeout(verseLongPressTimer);
    verseLongPressTimer = setTimeout(() => {
        if (window.getSelection) window.getSelection().removeAllRanges();
        verseLongPressAt = Date.now();
        try { navigator.vibrate && navigator.vibrate(25); } catch (err) { /* noop */ }
        // Si ya hay verso seleccionado, long-press crea rango
        if (selectedVerseEl && selectedVerseEl !== verseLongPressEl) {
            const { chapN: startChap } = getVerseInfo(selectedVerseEl);
            const { chapN: endChap } = getVerseInfo(verseLongPressEl);
            if (startChap === endChap) {
                selectedVerseEndEl = verseLongPressEl;
                highlightVerseRange();
                updateVerseActionBar();
                return;
            }
        }
        clearVerseSelection();
        selectedVerseEl = verseLongPressEl;
        verseLongPressEl.classList.add('verse-selected');
        updateVerseActionBar();
        document.getElementById('verse-actions').classList.add('va-active');
    }, VERSE_LONGPRESS_MS);
}, { passive: true });

elements.versesContent.addEventListener('touchmove', e => {
    if (!verseLongPressTimer) return;
    const dx = e.touches[0].clientX - verseLongPressStartX;
    const dy = e.touches[0].clientY - verseLongPressStartY;
    if (Math.hypot(dx, dy) > 12) clearTimeout(verseLongPressTimer); // scroll: cancela
}, { passive: true });

['touchend', 'touchcancel'].forEach(evName =>
    elements.versesContent.addEventListener(evName, () => clearTimeout(verseLongPressTimer), { passive: true }));

elements.versesContent.addEventListener('contextmenu', e => {
    if (window.innerWidth >= 1024) return; // solo móvil
    // Ya gestionado por el timer táctil: solo bloquea el menú nativo
    if (Date.now() - verseLongPressAt < 800) { e.preventDefault(); return; }
    const verseEl = e.target.closest('.verse');
    if (!verseEl) return;
    e.preventDefault();

    // Si ya hay verso seleccionado, long-press crea rango
    if (selectedVerseEl && selectedVerseEl !== verseEl) {
        const { chapN: startChap } = getVerseInfo(selectedVerseEl);
        const { chapN: endChap } = getVerseInfo(verseEl);
        if (startChap === endChap) {
            selectedVerseEndEl = verseEl;
            highlightVerseRange();
            updateVerseActionBar();
            return;
        }
    }

    clearVerseSelection();
    selectedVerseEl = verseEl;
    verseEl.classList.add('verse-selected');
    updateVerseActionBar();
    document.getElementById('verse-actions').classList.add('va-active');
});

// Checkbox click para rango en PC
elements.versesContent.addEventListener('change', e => {
    if (!e.target.classList.contains('verse-checkbox')) return;
    const checkbox = e.target;
    const verseEl = checkbox.closest('.verse');
    if (!verseEl) return;

    const isChecked = checkbox.checked;

    if (isChecked) {
        if (!selectedVerseEl) {
            selectedVerseEl = verseEl;
            verseEl.classList.add('verse-selected');
        } else {
            selectedVerseEndEl = verseEl;
            highlightVerseRange();
        }
    } else {
        if (selectedVerseEl === verseEl) {
            clearVerseSelection();
        } else if (selectedVerseEndEl === verseEl) {
            selectedVerseEndEl = null;
            document.querySelectorAll('.verse-selected').forEach(el => el.classList.remove('verse-selected'));
            if (selectedVerseEl) selectedVerseEl.classList.add('verse-selected');
        }
    }

    updateVerseActionBar();
    if (selectedVerseEl) {
        document.getElementById('verse-actions').classList.add('va-active');
    }
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
            } catch { return { id: t.id, label: t.label, text: null }; }
        }
        const book = data.find(b => b.id == bookId);
        const chap = book?.chapters.find(c => c.n == chapN);
        const verse = chap?.v.find(v => v.n == verseN);
        return { id: t.id, label: t.label, text: verse?.t || null };
    }));

    const currentTid = elements.translationSelect.value;
    content.innerHTML = results.map(r => `
        <div class="vc-item${r.text ? ' vc-selectable' : ''}${r.id === currentTid ? ' vc-current' : ''}"${r.text ? ` data-tid="${r.id}"` : ''}>
            <div class="vc-label">${r.label}${r.id === currentTid ? ' ✓' : ''}</div>
            <div class="vc-text">${r.text ?? '<em style="opacity:0.4">No disponible</em>'}</div>
        </div>`).join('')
        + '<div class="vc-hint">Toca una versión para leer en ella</div>';

    // Tocar una versión: cambia la traducción activa y cierra el comparador
    content.querySelectorAll('.vc-item.vc-selectable').forEach(el => {
        el.addEventListener('click', () => {
            const tid = el.dataset.tid;
            document.getElementById('verse-compare').classList.add('vc-hidden');
            if (tid && tid !== elements.translationSelect.value) {
                elements.translationSelect.value = tid;
                elements.translationSelect.onchange({ target: elements.translationSelect });
            }
        });
    });
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

function studiesCreate(state, name, tags = [], subscribable = false) {
    const id = 'study_' + Date.now();
    const newStudy = { id, name, tags, subscribable, createdAt: new Date().toISOString(), entries: [] };
    return { ...state, studies: [...state.studies, newStudy] };
}

function studiesUpdateStudy(state, studyId, { name, tags, subscribable }) {
    const studies = state.studies.map(s => {
        if (s.id !== studyId) return s;
        return { ...s, name: name || s.name, tags: tags || [], subscribable: !!subscribable };
    });
    return { ...state, studies };
}

function studiesSetBaseRef(state, studyId, baseRef) {
    const studies = state.studies.map(s => s.id !== studyId ? s : { ...s, baseRef });
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

// ═══════════════════════════════════════════════════════════════
// ── Fotos de notas (estilo GioBike: binario en IndexedDB) ──────
// El JSON del estudio solo guarda los ids (entry.images); el
// binario vive en IndexedDB para no reventar localStorage (~5MB).
// ═══════════════════════════════════════════════════════════════

const NOTE_PHOTOS_DB = 'biblia-fotos';
const NOTE_PHOTOS_STORE = 'fotos';
const NOTE_PHOTOS_MAX_DIM = 1024;
const NOTE_PHOTOS_QUALITY = 0.82;
const NOTE_PHOTOS_MAX_PER_ENTRY = 5;

const notePhotoDB = (() => {
    function open() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(NOTE_PHOTOS_DB, 1);
            req.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(NOTE_PHOTOS_STORE)) {
                    db.createObjectStore(NOTE_PHOTOS_STORE, { keyPath: 'id' });
                }
            };
            req.onsuccess = e => resolve(e.target.result);
            req.onerror = e => reject(e.target.error);
        });
    }
    function tx(mode) {
        return open().then(db => new Promise((resolve, reject) => {
            try {
                const t = db.transaction(NOTE_PHOTOS_STORE, mode);
                resolve({ t, store: t.objectStore(NOTE_PHOTOS_STORE), db });
            } catch (err) { db.close(); reject(err); }
        }));
    }
    return {
        async save(id, base64) {
            const { t, store, db } = await tx('readwrite');
            return new Promise((resolve, reject) => {
                store.put({ id, base64, createdAt: new Date().toISOString() });
                t.oncomplete = () => { db.close(); resolve(id); };
                t.onerror = e => { db.close(); reject(e.target.error); };
            });
        },
        async get(id) {
            const { store, db } = await tx('readonly');
            return new Promise((resolve, reject) => {
                const req = store.get(id);
                req.onsuccess = e => { db.close(); resolve(e.target.result?.base64 || null); };
                req.onerror = e => { db.close(); reject(e.target.error); };
            });
        },
        async del(id) {
            const { t, store, db } = await tx('readwrite');
            return new Promise((resolve, reject) => {
                store.delete(id);
                t.oncomplete = () => { db.close(); resolve(); };
                t.onerror = e => { db.close(); reject(e.target.error); };
            });
        },
        async delMany(ids) {
            for (const id of (ids || [])) {
                try { await this.del(id); } catch { /* noop */ }
            }
        }
    };
})();

function genNotePhotoId() {
    return 'img_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// Comprime una imagen (File o dataURL) a JPEG max 1024px.
// Retorna el cuerpo base64 (sin prefijo data:), como GioBike.
function resizeNoteImage(source, maxDim = NOTE_PHOTOS_MAX_DIM) {
    return new Promise((resolve, reject) => {
        const loadSrc = (src, cb) => {
            if (typeof src === 'string') { cb(src); return; }
            const fr = new FileReader();
            fr.onload = e => cb(e.target.result);
            fr.onerror = reject;
            fr.readAsDataURL(src);
        };
        loadSrc(source, dataUrl => {
            const img = new Image();
            img.onload = () => {
                const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/jpeg', NOTE_PHOTOS_QUALITY).split(',')[1]);
            };
            img.onerror = reject;
            img.src = dataUrl;
        });
    });
}

function notePhotoSrc(base64) {
    return 'data:image/jpeg;base64,' + base64;
}

// Rellena los contenedores .entry-photos[data-ids] con thumbnails.
// Cada img abre el visor fullscreen al tocarla.
async function hydrateEntryPhotos(root) {
    if (!root) return;
    const boxes = root.querySelectorAll('.entry-photos[data-ids]');
    for (const box of boxes) {
        if (box.dataset.done) continue;
        box.dataset.done = '1';
        let ids = [];
        try { ids = JSON.parse(box.dataset.ids || '[]'); } catch { ids = []; }
        if (!ids.length) { box.remove(); continue; }
        for (const id of ids) {
            try {
                const b64 = await notePhotoDB.get(id);
                if (!b64) continue;
                const img = document.createElement('img');
                img.src = notePhotoSrc(b64);
                img.className = 'entry-photo-thumb';
                img.alt = 'Foto de la nota';
                img.loading = 'lazy';
                img.addEventListener('click', () => openPhotoViewer(notePhotoSrc(b64)));
                box.appendChild(img);
            } catch { /* foto ilegible: se omite */ }
        }
        if (!box.children.length) box.remove();
    }
}

function entryPhotosHtml(entry) {
    const ids = entry.images || [];
    if (!ids.length) return '';
    return `<div class="entry-photos" data-ids='${JSON.stringify(ids)}'></div>`;
}

let photoViewerSrc = '';

function openPhotoViewer(src) {
    photoViewerSrc = src || '';
    const viewer = document.getElementById('photo-viewer');
    document.getElementById('photo-viewer-img').src = photoViewerSrc;
    const ocrBtn = document.getElementById('photo-viewer-ocr');
    if (ocrBtn) ocrBtn.disabled = false;
    viewer.classList.remove('pv-hidden');
}

function closePhotoViewer() {
    const viewer = document.getElementById('photo-viewer');
    viewer.classList.add('pv-hidden');
    document.getElementById('photo-viewer-img').src = '';
    photoViewerSrc = '';
}

// ── OCR de fotos (Tesseract.js, español) ───────────────────────
// Lazy-load desde CDN (solo online); el texto queda editable antes
// de insertarse en la nota.
let tesseractPromise = null;

function ensureTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (tesseractPromise) return tesseractPromise;
    tesseractPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
        s.onload = () => resolve(window.Tesseract);
        s.onerror = () => reject(new Error('cdn'));
        document.head.appendChild(s);
    }).catch(err => { tesseractPromise = null; throw err; });
    return tesseractPromise;
}

function setOcrStatus(msg) {
    const el = document.getElementById('ocr-status');
    if (el) el.textContent = msg || '';
}

function openOcrModal() {
    document.getElementById('ocr-modal').classList.remove('ocr-hidden');
}

function closeOcrModal() {
    document.getElementById('ocr-modal').classList.add('ocr-hidden');
}

async function runViewerOcr() {
    if (!photoViewerSrc) return;
    const btn = document.getElementById('photo-viewer-ocr');
    document.getElementById('ocr-text').value = '';
    openOcrModal();
    setOcrStatus('Cargando motor OCR… (la primera vez requiere internet)');
    if (btn) btn.disabled = true;
    try {
        await ensureTesseract();
        setOcrStatus('Leyendo la imagen… esto puede tardar unos segundos');
        const worker = await window.Tesseract.createWorker('spa');
        const { data: { text } } = await worker.recognize(photoViewerSrc);
        await worker.terminate();
        const clean = (text || '').trim();
        document.getElementById('ocr-text').value = clean;
        setOcrStatus(clean
            ? 'Revisa el texto antes de insertarlo en la nota'
            : 'No se detectó texto en la imagen');
    } catch {
        setOcrStatus('No se pudo hacer el OCR. Revisa tu conexión e inténtalo de nuevo.');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function ocrCopyText() {
    const text = document.getElementById('ocr-text').value.trim();
    if (!text) { showSaveToast('Nada que copiar'); return; }
    try {
        await navigator.clipboard.writeText(text);
        showSaveToast('Texto copiado ✓');
    } catch {
        showSaveToast('No se pudo copiar');
    }
}

function ocrInsertIntoNote() {
    const text = document.getElementById('ocr-text').value.trim();
    if (!text) { showSaveToast('Nada que insertar'); return; }
    const sheet = document.getElementById('note-sheet');
    if (sheet.classList.contains('ns-hidden')) {
        showSaveToast('Abre una nota para insertarlo (o usa Copiar)');
        return;
    }
    const input = document.getElementById('ns-note-input');
    input.value = input.value.trim() ? input.value.trim() + '\n\n' + text : text;
    closeOcrModal();
    closePhotoViewer();
    showSaveToast('Texto insertado ✓');
    setTimeout(() => input.focus(), 100);
}

// ── Transcripción de audio (MediaRecorder + Whisper en worker) ─
// El worker necesita el binding [ai] y `wrangler deploy`. El audio se
// parte en trozos de 8MB y se envía secuencialmente.
const STT_PART_BYTES = 8 * 1024 * 1024;
let sttStream = null;
let sttRecorder = null;
let sttChunks = [];
let sttTimerInt = null;
let sttStartTs = 0;

function sttPickMime() {
    if (!window.MediaRecorder) return '';
    const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    for (const m of cands) {
        try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (err) { /* noop */ }
    }
    return '';
}

function sttFmt(ms) {
    const s = Math.floor(ms / 1000);
    const hh = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

async function sttStart() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        showSaveToast('Tu navegador no soporta grabación de audio');
        return;
    }
    try {
        sttStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
        showSaveToast('Permiso de micrófono denegado');
        return;
    }
    sttChunks = [];
    const mime = sttPickMime();
    try {
        sttRecorder = mime ? new MediaRecorder(sttStream, { mimeType: mime }) : new MediaRecorder(sttStream);
    } catch (err) {
        sttStream.getTracks().forEach(t => t.stop());
        sttStream = null;
        showSaveToast('No se pudo iniciar la grabación');
        return;
    }
    sttRecorder.ondataavailable = e => { if (e.data && e.data.size) sttChunks.push(e.data); };
    sttRecorder.onstop = () => {
        if (sttStream) { sttStream.getTracks().forEach(t => t.stop()); sttStream = null; }
    };
    sttRecorder.start(1000);
    sttStartTs = Date.now();
    document.getElementById('stt-rec-timer').textContent = '00:00';
    clearInterval(sttTimerInt);
    sttTimerInt = setInterval(() => {
        document.getElementById('stt-rec-timer').textContent = sttFmt(Date.now() - sttStartTs);
    }, 500);
    document.getElementById('stt-rec-modal').classList.remove('ncm-hidden');
}

function sttCloseRecModal() {
    document.getElementById('stt-rec-modal').classList.add('ncm-hidden');
    clearInterval(sttTimerInt);
}

async function sttFinish(cancel) {
    const rec = sttRecorder;
    sttRecorder = null;
    sttCloseRecModal();
    if (!rec) return;
    const prevStop = rec.onstop;
    const done = new Promise(res => {
        rec.onstop = e => { try { prevStop && prevStop(e); } catch (err) { /* noop */ } res(); };
    });
    try { if (rec.state !== 'inactive') rec.stop(); } catch (err) { /* noop */ }
    await done;
    if (cancel) { sttChunks = []; return; }
    const blob = new Blob(sttChunks, { type: rec.mimeType || 'audio/webm' });
    sttChunks = [];
    if (!blob.size) { showSaveToast('Grabación vacía'); return; }
    sttTranscribe(blob);
}

async function sttTranscribe(blob) {
    document.getElementById('stt-text').value = '';
    document.getElementById('stt-modal').classList.remove('ocr-hidden');
    const setStatus = msg => { document.getElementById('stt-status').textContent = msg; };
    const parts = [];
    for (let off = 0; off < blob.size; off += STT_PART_BYTES) {
        parts.push(blob.slice(off, off + STT_PART_BYTES, blob.type));
    }
    const texts = [];
    for (let i = 0; i < parts.length; i++) {
        setStatus(`Transcribiendo parte ${i + 1}/${parts.length}…`);
        let res;
        try {
            res = await fetch(AI_WORKER_TRANSCRIBE_URL + '?lang=es', {
                method: 'POST',
                headers: { 'Content-Type': parts[i].type || 'audio/webm' },
                body: parts[i],
            });
        } catch (err) {
            setStatus('Sin conexión con el servidor de IA. Inténtalo de nuevo.');
            return;
        }
        let data = null;
        try { data = await res.json(); } catch (err) { /* noop */ }
        if (!res.ok) {
            setStatus(data?.error || `Error del servidor (${res.status})`);
            return;
        }
        texts.push((data?.text || '').trim());
    }
    const full = texts.filter(Boolean).join(' ');
    document.getElementById('stt-text').value = full;
    setStatus(full
        ? 'Revisa la transcripción antes de insertarla en la nota'
        : 'No se detectó habla en el audio');
}

function closeSttModal() {
    document.getElementById('stt-modal').classList.add('ocr-hidden');
}

async function sttCopyText() {
    const text = document.getElementById('stt-text').value.trim();
    if (!text) { showSaveToast('Nada que copiar'); return; }
    try {
        await navigator.clipboard.writeText(text);
        showSaveToast('Transcripción copiada ✓');
    } catch (err) {
        showSaveToast('No se pudo copiar');
    }
}

function sttInsertIntoNote() {
    const text = document.getElementById('stt-text').value.trim();
    if (!text) { showSaveToast('Nada que insertar'); return; }
    const sheet = document.getElementById('note-sheet');
    if (sheet.classList.contains('ns-hidden')) {
        showSaveToast('Abre una nota para insertarla (o usa Copiar)');
        return;
    }
    const input = document.getElementById('ns-note-input');
    input.value = input.value.trim() ? input.value.trim() + '\n\n' + text : text;
    closeSttModal();
    showSaveToast('Transcripción insertada ✓');
    setTimeout(() => input.focus(), 100);
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
    const urlStudyId = new URLSearchParams(window.location.search).get('study');
    if (urlStudyId) {
        handleStudyFromUrl(urlStudyId);
    } else if (localStorage.getItem('bible-study-alert') !== 'off') {
        showActiveStudyAlert(studiesState.activeStudyId || 'general');
    }

    // Comprobar actualizaciones de estudios suscritos
    checkStudyUpdates();
}

async function handleStudyFromUrl(studyId) {
    const activateAndOpen = () => {
        studiesState = studiesSetActive(studiesState, studyId);
        studiesSave(studiesState);
        updateStudiesButton();
        renderStudiesDropdown();
        studyNavReset();
        reapplyStudyMarkers();
        studyNavUpdate();
        if (studyNavEntries().length > 0) openStudyNavModal();
    };

    // ¿Ya existe localmente?
    if (studiesState.studies.find(s => s.id === studyId)) {
        activateAndOpen();
        return;
    }

    // Buscar en compartidos
    showSaveToast('Buscando estudio compartido...');
    try {
        const res = await fetch(SHARED_API, { headers: { Accept: 'application/vnd.github.v3+json' } });
        if (!res.ok) throw new Error();
        const files = (await res.json()).filter(f => f.type === 'file' && f.name.endsWith('.json'));
        const results = await Promise.all(files.map(f => fetch(f.download_url).then(r => r.json()).catch(() => null)));

        let found = null;
        for (const data of results) {
            if (data && Array.isArray(data.studies)) {
                const match = data.studies.find(s => s.id === studyId);
                if (match) { found = match; break; }
            }
        }

        if (!found) {
            showSaveToast('Estudio no encontrado en compartidos');
            return;
        }

        const { _exportedAt, ...study } = found;
        studiesState = { ...studiesState, studies: [...studiesState.studies, { ...study, tags: study.tags || [], entries: study.entries || [] }] };
        studiesSave(studiesState);
        renderStudiesDropdown();
        showSaveToast(`Estudio "${study.name}" importado ✓`);
        activateAndOpen();
    } catch {
        showSaveToast('Error al buscar el estudio compartido');
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
    
    // Botón Mis estudios
    document.getElementById('sd-my-studies-btn').addEventListener('click', () => {
        closeStudiesDropdown();
        openStudiesListModal();
    });

    // Botón Ver otros estudios
    document.getElementById('sd-other-studies-btn')?.addEventListener('click', () => {
        closeStudiesDropdown();
        openStudiesListModal();
    });
    document.getElementById('slm-overlay').addEventListener('click', closeStudiesListModal);
    document.getElementById('slm-close').addEventListener('click', closeStudiesListModal);

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

    // Fotos de la nota: galería + cámara (estilo GioBike)
    document.getElementById('ns-photo-file').addEventListener('change', e => {
        noteSheetAddFiles(e.target.files);
        e.target.value = '';
    });
    document.getElementById('ns-photo-cam').addEventListener('click', () => {
        if (!navigator.mediaDevices?.getUserMedia) {
            showSaveToast('Tu navegador no soporta la cámara, usa Galería');
            return;
        }
        noteCamOpen();
    });
    document.getElementById('note-cam-close').addEventListener('click', noteCamClose);
    document.getElementById('note-cam-overlay').addEventListener('click', noteCamClose);
    document.getElementById('note-cam-switch').addEventListener('click', noteCamSwitch);
    document.getElementById('note-cam-capture').addEventListener('click', noteCamCapture);

    // Visor fullscreen de fotos
    document.getElementById('photo-viewer-close').addEventListener('click', closePhotoViewer);
    document.getElementById('photo-viewer-overlay').addEventListener('click', closePhotoViewer);
    document.getElementById('photo-viewer-ocr').addEventListener('click', runViewerOcr);

    // Modal OCR
    document.getElementById('ocr-close').addEventListener('click', closeOcrModal);
    document.getElementById('ocr-overlay').addEventListener('click', closeOcrModal);
    document.getElementById('ocr-copy').addEventListener('click', ocrCopyText);
    document.getElementById('ocr-insert').addEventListener('click', ocrInsertIntoNote);

    // Grabación y transcripción de audio
    document.getElementById('ns-audio-rec').addEventListener('click', sttStart);
    document.getElementById('stt-rec-close').addEventListener('click', () => sttFinish(true));
    document.getElementById('stt-rec-overlay').addEventListener('click', () => sttFinish(true));
    document.getElementById('stt-rec-cancel').addEventListener('click', () => sttFinish(true));
    document.getElementById('stt-rec-stop').addEventListener('click', () => sttFinish(false));
    document.getElementById('stt-close').addEventListener('click', closeSttModal);
    document.getElementById('stt-overlay').addEventListener('click', closeSttModal);
    document.getElementById('stt-copy').addEventListener('click', sttCopyText);
    document.getElementById('stt-insert').addEventListener('click', sttInsertIntoNote);

    // Autocomplete @version: en el textarea
    const noteInput    = document.getElementById('ns-note-input');
    const acContainer  = document.getElementById('ns-autocomplete');

    function hideNoteAc() {
        acContainer.classList.add('ns-ac-hidden');
        acContainer.innerHTML = '';
    }

    // Inserta `text` reemplazando lo que matcheó el regex antes del cursor
    function noteAcInsert(pattern, text) {
        const val = noteInput.value;
        const pos = noteInput.selectionStart;
        const textBefore = val.slice(0, pos);
        const m = textBefore.match(pattern);
        if (!m) return;
        const start = pos - m[0].length;
        noteInput.value = val.slice(0, start) + text + val.slice(pos);
        const newPos = start + text.length;
        noteInput.setSelectionRange(newPos, newPos);
        hideNoteAc();
    }

    function showNoteAcItems(items) {
        // items: [{ label, insert, pattern }]
        acContainer.innerHTML = items.map((it, i) =>
            `<span class="ns-ac-item" data-i="${i}">${it.label}</span>`
        ).join('');
        acContainer.classList.remove('ns-ac-hidden');

        acContainer.querySelectorAll('.ns-ac-item').forEach(el => {
            el.addEventListener('pointerdown', e => {
                e.preventDefault();
                const it = items[parseInt(el.dataset.i)];
                noteAcInsert(it.pattern, it.insert);
            });
        });
    }

    noteInput.addEventListener('input', () => {
        const pos = noteInput.selectionStart;
        const textBefore = noteInput.value.slice(0, pos);

        // ── @version: ──────────────────────────────────────────
        let m = textBefore.match(/@version:([a-z0-9]*)$/i);
        if (m) {
            const partial = m[1].toLowerCase();
            const items = translations
                .filter(t => t.id.startsWith(partial))
                .map(t => ({ label: t.id.toUpperCase(), insert: `@version:${t.id}`, pattern: /@version:([a-z0-9]*)$/i }));
            if (items.length) { showNoteAcItems(items); return; }
        }

        // ── @entrada: ──────────────────────────────────────────
        m = textBefore.match(/@entrada:(\d*)$/i);
        if (m && studiesState) {
            const partial = m[1];
            const entries = studiesGetActive(studiesState).entries;
            const items = entries
                .map((e, i) => ({ n: i + 1, label: e.type === 'verse' ? `${i + 1} ${e.ref}` : `${i + 1} 📝 Nota` }))
                .filter(it => partial === '' || String(it.n).startsWith(partial))
                .map(it => ({ label: it.label, insert: `@entrada:${it.n}`, pattern: /@entrada:(\d*)$/i }));
            if (items.length) { showNoteAcItems(items); return; }
        }

        // ── @estudio: ──────────────────────────────────────────
        m = textBefore.match(/@estudio:([^\s]*)$/i);
        if (m && studiesState) {
            const partial = m[1].replace(/_/g, ' ').toLowerCase();
            const items = studiesState.studies
                .filter(s => s.name.toLowerCase().startsWith(partial))
                .map(s => ({
                    label: s.name,
                    insert: `@estudio:${s.name.replace(/\s+/g, '_')}`,
                    pattern: /@estudio:([^\s]*)$/i
                }));
            if (items.length) { showNoteAcItems(items); return; }
        }

        hideNoteAc();
    });

    noteInput.addEventListener('blur', () => setTimeout(hideNoteAc, 150));
    
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
    const header = document.getElementById('sd-header');
    const activeStudy = studiesGetActive(studiesState);
    header.innerHTML = `<span class="sd-header-name">${activeStudy.name} ›</span><span class="sd-header-sub">Estudio activo</span>`;
    updateModeToggleText();
    const btn = document.getElementById('sd-my-studies-btn');
    if (btn) btn.textContent = `📓 Mis estudios (${studiesState.studies.length})`;
}

function openStudiesListModal() {
    document.getElementById('studies-list-modal').classList.remove('slm-hidden');
    renderStudiesModal(null);
}

function closeStudiesListModal() {
    document.getElementById('studies-list-modal').classList.add('slm-hidden');
}

function renderStudiesModal(filterTag) {
    const allTags = getAllTags();
    const tagsEl = document.getElementById('slm-tags');
    const listEl = document.getElementById('slm-list');
    const titleEl = document.getElementById('slm-title');

    titleEl.textContent = `Mis estudios (${studiesState.studies.length})`;

    // Chips de filtro
    tagsEl.innerHTML = [
        `<span class="slm-tag-chip ${!filterTag ? 'slm-tag-active' : ''}" data-tag="">Todas</span>`,
        ...allTags.map(t => `<span class="slm-tag-chip ${filterTag === t ? 'slm-tag-active' : ''}" data-tag="${t}">${t}</span>`)
    ].join('');
    tagsEl.querySelectorAll('.slm-tag-chip').forEach(chip => {
        chip.addEventListener('click', () => renderStudiesModal(chip.dataset.tag || null));
    });

    // Lista de estudios
    const filtered = studiesState.studies.filter(s => !filterTag || (s.tags || []).includes(filterTag));
    listEl.innerHTML = '';
    filtered.forEach(study => {
        const isActive = study.id === (studiesState.activeStudyId || 'general');
        const tagsHtml = (study.tags || []).length
            ? `<div class="slm-study-tags">${(study.tags || []).map(t => `<span class="sd-tag-chip">${t}</span>`).join('')}</div>`
            : '';
        const item = document.createElement('div');
        item.className = `slm-study-item${isActive ? ' slm-active' : ''}`;
        item.innerHTML = `
            <div class="slm-study-name">${study.name}</div>
            <div class="slm-study-meta">${study.entries.length} entradas</div>
            ${tagsHtml}
        `;
        item.addEventListener('click', () => {
            closeStudiesListModal();
            openStudySheet(study.id);
        });
        listEl.appendChild(item);
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

    // Mostrar ID del estudio + botón suscripción
    const idEl = document.getElementById('ss-study-id');
    const subbed = isStudySubscribed(studyId);
    const notifyBtn = study.subscribable
        ? `<button class="ss-notify-btn ${subbed ? 'subscribed' : ''}" title="${subbed ? 'Cancelar notificaciones' : 'Activar notificaciones'}">${subbed ? '🔔' : '🔕'}</button>`
        : '';
    idEl.innerHTML = `ID: <span class="ss-study-id-value">${studyId}</span><button class="ss-copy-id-btn" title="Copiar ID">📋</button>${notifyBtn}`;
    if (study.subscribable) {
        idEl.querySelector('.ss-notify-btn').addEventListener('click', () => {
            const nowSubbed = toggleStudySubscription(studyId, (study.entries || []).length);
            const btn = idEl.querySelector('.ss-notify-btn');
            btn.textContent = nowSubbed ? '🔔' : '🔕';
            btn.title = nowSubbed ? 'Cancelar notificaciones' : 'Activar notificaciones';
            btn.classList.toggle('subscribed', nowSubbed);
            showSaveToast(nowSubbed ? 'Notificaciones activadas 🔔' : 'Notificaciones desactivadas');
        });
    }
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
            }
            closeStudySheet();
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
                    if (studyNavEntries().length > 0) openStudyNavModal();
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
            if (studyNavEntries().length > 0) openStudyNavModal();
        });
        document.getElementById('ss-new-study-btn').addEventListener('click', () => {
            closeStudySheet();
            openStudyEditSheet(null, { autoActivate: true });
        });
    } else {
        const isActive = study.id === studiesState.activeStudyId;
        const otherStudies = studiesState.studies.filter(s => s.id !== study.id);
        const moreStudiesBtn = otherStudies.length > 0
            ? `<button id="ss-more-studies-btn" class="ss-secondary-btn">Ver otros estudios (${otherStudies.length})</button>`
            : '';
        if (isActive) {
            actions.innerHTML = `
                <button id="ss-continue-btn" class="primary-btn">Continuar en este estudio</button>
                ${moreStudiesBtn}
            `;
            document.getElementById('ss-continue-btn').addEventListener('click', () => {
                if (window.innerWidth >= 1024) {
                    renderStudyEntries(study);
                    actions.innerHTML = '';
                }
                closeStudySheet();
            });
        } else {
            actions.innerHTML = `
                <button id="ss-continue-btn" class="primary-btn">Continuar en este estudio</button>
                ${moreStudiesBtn}
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
                }
                closeStudySheet();
                if (studyNavEntries().length > 0) openStudyNavModal();
            });
            document.getElementById('ss-cancel-btn').addEventListener('click', closeStudySheet);
        }

        // Event listener para "Ver otros estudios"
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
                    if (studyNavEntries().length > 0) openStudyNavModal();
                });
            });
        });
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
                    ${entry.note ? `<div class="ss-entry-note">${linkifyNoteText(entry.note, { bookId: entry.bookId, chapN: entry.chapN, verseN: entry.verseN })}</div>` : ''}
                    ${entryPhotosHtml(entry)}
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
                    ${entryPhotosHtml(entry)}
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

    // Fotos de notas (IndexedDB, async)
    hydrateEntryPhotos(content);

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
                const doomed = study.entries.find(e => e.id === btn.dataset.entryId);
                studiesState = studiesDeleteEntry(studiesState, study.id, btn.dataset.entryId);
                studiesSave(studiesState);
                if (doomed?.images?.length) notePhotoDB.delMany(doomed.images).catch(() => {});
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

// Fotos en staging del note-sheet: [{ id (existente en IDB) | null,
// dataUrl (nueva por guardar) | null, removed }]
let noteSheetPhotos = [];
let noteSheetRemovedIds = [];

function noteSheetResetPhotos(existingIds) {
    noteSheetPhotos = (existingIds || []).map(id => ({ id, dataUrl: null, removed: false }));
    noteSheetRemovedIds = [];
    renderNsPhotos();
}

function noteSheetVisiblePhotos() {
    return noteSheetPhotos.filter(p => !p.removed);
}

function renderNsPhotos() {
    const box = document.getElementById('ns-photos-preview');
    if (!box) return;
    box.innerHTML = '';
    noteSheetVisiblePhotos().forEach((p, idx) => {
        const wrap = document.createElement('div');
        wrap.className = 'ns-photo-item';
        const img = document.createElement('img');
        img.alt = 'Foto ' + (idx + 1);
        if (p.dataUrl) {
            img.src = p.dataUrl;
        } else if (p.id) {
            img.alt = 'Cargando…';
            notePhotoDB.get(p.id).then(b64 => {
                if (b64) { img.src = notePhotoSrc(b64); }
                else { img.alt = 'No disponible'; }
            }).catch(() => { img.alt = 'No disponible'; });
        }
        img.addEventListener('click', () => {
            if (img.src && img.src.startsWith('data:')) openPhotoViewer(img.src);
        });
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'ns-photo-del';
        del.textContent = '✕';
        del.title = 'Quitar foto';
        del.addEventListener('click', () => {
            p.removed = true;
            if (p.id) noteSheetRemovedIds.push(p.id);
            renderNsPhotos();
        });
        wrap.appendChild(img);
        wrap.appendChild(del);
        box.appendChild(wrap);
    });
    const count = document.getElementById('ns-photo-count');
    if (count) count.textContent = noteSheetVisiblePhotos().length
        ? `${noteSheetVisiblePhotos().length}/${NOTE_PHOTOS_MAX_PER_ENTRY} fotos` : '';
}

async function noteSheetAddFiles(fileList) {
    const files = [...(fileList || [])].filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    const room = NOTE_PHOTOS_MAX_PER_ENTRY - noteSheetVisiblePhotos().length;
    if (room <= 0) { showSaveToast(`Máximo ${NOTE_PHOTOS_MAX_PER_ENTRY} fotos por nota`); return; }
    for (const file of files.slice(0, room)) {
        try {
            const body = await resizeNoteImage(file);
            noteSheetPhotos.push({ id: null, dataUrl: notePhotoSrc(body), removed: false });
        } catch {
            showSaveToast('No se pudo leer una imagen');
        }
    }
    if (files.length > room) showSaveToast(`Solo se agregaron ${room} (máx. ${NOTE_PHOTOS_MAX_PER_ENTRY})`);
    renderNsPhotos();
}

// ── Cámara del note-sheet (modal propio, como GioBike) ──────────
let noteCamStream = null;
let noteCamDevices = [];
let noteCamIndex = 0;

async function noteCamOpen() {
    document.getElementById('note-cam-modal').classList.remove('ncm-hidden');
    await noteCamStart();
}

function noteCamClose() {
    document.getElementById('note-cam-modal').classList.add('ncm-hidden');
    if (noteCamStream) {
        noteCamStream.getTracks().forEach(t => t.stop());
        noteCamStream = null;
    }
}

async function noteCamStart() {
    const video = document.getElementById('note-cam-video');
    try {
        if (noteCamStream) noteCamStream.getTracks().forEach(t => t.stop());
        const devices = (await navigator.mediaDevices.enumerateDevices())
            .filter(d => d.kind === 'videoinput');
        noteCamDevices = devices;
        const constraints = devices.length && noteCamIndex < devices.length
            ? { video: { deviceId: { exact: devices[noteCamIndex].deviceId } } }
            : { video: { facingMode: 'environment' } };
        noteCamStream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = noteCamStream;
        document.getElementById('note-cam-switch').style.display =
            devices.length > 1 ? '' : 'none';
    } catch {
        showSaveToast('No se pudo abrir la cámara');
        noteCamClose();
    }
}

function noteCamSwitch() {
    if (!noteCamDevices.length) return;
    noteCamIndex = (noteCamIndex + 1) % noteCamDevices.length;
    noteCamStart();
}

async function noteCamCapture() {
    const video = document.getElementById('note-cam-video');
    if (!video.videoWidth) return;
    if (NOTE_PHOTOS_MAX_PER_ENTRY - noteSheetVisiblePhotos().length <= 0) {
        showSaveToast(`Máximo ${NOTE_PHOTOS_MAX_PER_ENTRY} fotos por nota`);
        return;
    }
    const canvas = document.getElementById('note-cam-canvas');
    const scale = Math.min(1, NOTE_PHOTOS_MAX_DIM / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', NOTE_PHOTOS_QUALITY);
    noteSheetPhotos.push({ id: null, dataUrl, removed: false });
    renderNsPhotos();
    noteCamClose();
    showSaveToast('Foto agregada 📷');
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
            noteSheetResetPhotos(editEntry.images);
        } else {
            refEl.style.display = 'none';
            textEl.style.display = 'none';
            noteInput.value = editEntry.text || '';
            noteInput.placeholder = 'Texto de la nota';
            noteSheetResetPhotos(editEntry.images);
        }
    } else if (verseData) {
        title.textContent = 'Guardar versículo';
        refEl.textContent = verseData.ref;
        refEl.style.display = 'block';
        textEl.textContent = verseData.text;
        textEl.style.display = 'block';
        noteInput.placeholder = 'Escribe una nota (opcional)';
        noteSheetResetPhotos([]);
    } else {
        title.textContent = 'Nueva nota';
        refEl.style.display = 'none';
        textEl.style.display = 'none';
        noteInput.placeholder = 'Escribe una nota (opcional)';
        noteSheetResetPhotos([]);
    }

    // Base ref checkbox
    const baseRow = document.getElementById('ns-base-ref-row');
    const baseCheck = document.getElementById('ns-base-ref-check');
    const baseLabel = document.getElementById('ns-base-ref-label');
    if (verseData && !editEntry) {
        const activeStudy = studiesGetActive(studiesState);
        baseCheck.checked = false;
        if (activeStudy.baseRef) {
            baseLabel.textContent = `Reemplazar texto base (actual: ${activeStudy.baseRef})`;
        } else {
            baseLabel.textContent = 'Establecer como texto base';
        }
        baseRow.style.display = '';
    } else {
        baseRow.style.display = 'none';
        baseCheck.checked = false;
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

async function handleSaveNote() {
    const sheet = document.getElementById('note-sheet');
    const noteInput = document.getElementById('ns-note-input');
    const note = noteInput.value.trim();
    const verseDataStr = sheet.dataset.verseData;
    const editEntryStr = sheet.dataset.editEntry;

    // ── Persiste fotos del staging en IndexedDB ──────────────
    const keptIds = noteSheetPhotos.filter(p => p.id && !p.removed).map(p => p.id);
    const newIds = [];
    for (const p of noteSheetPhotos.filter(p => !p.id && !p.removed && p.dataUrl)) {
        const body = p.dataUrl.includes(',') ? p.dataUrl.split(',')[1] : p.dataUrl;
        const id = genNotePhotoId();
        try { await notePhotoDB.save(id, body); newIds.push(id); }
        catch { /* sin espacio: se omite la foto */ }
    }
    const finalImageIds = [...keptIds, ...newIds];
    if (noteSheetRemovedIds.length) {
        notePhotoDB.delMany(noteSheetRemovedIds).catch(() => {});
        noteSheetRemovedIds = [];
    }

    // ── Modo edición ──────────────────────────────────────────
    if (editEntryStr) {
        const editEntry = JSON.parse(editEntryStr);
        const studyId = sheet.dataset.editStudyId;
        if (editEntry.type === 'verse') {
            studiesState = studiesUpdateEntry(studiesState, studyId, editEntry.id, { note, images: finalImageIds });
        } else {
            if (!note && !finalImageIds.length) { showSaveToast('Escribe algo o agrega una foto'); return; }
            studiesState = studiesUpdateEntry(studiesState, studyId, editEntry.id, { text: note, images: finalImageIds });
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
            note: note,
            images: finalImageIds
        };
        studiesState = studiesAddEntry(studiesState, activeStudy.id, entry);
    } else if (note || finalImageIds.length) {
        const entry = {
            type: 'note',
            text: note,
            note: '',
            images: finalImageIds
        };
        studiesState = studiesAddEntry(studiesState, activeStudy.id, entry);
    } else {
        showSaveToast('Escribe algo para guardar');
        return;
    }
    
    const baseCheck = document.getElementById('ns-base-ref-check');
    if (baseCheck && baseCheck.checked && verseDataStr) {
        const verseData = JSON.parse(verseDataStr);
        studiesState = studiesSetBaseRef(studiesState, studiesGetActive(studiesState).id, verseData.ref);
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

    // ── Patrón @version:XXXX ─────────────────────────────────────
    if (context && context.bookId && context.chapN && context.verseN) {
        const versionPattern = /@version:([a-z0-9]+)/gi;
        while ((match = versionPattern.exec(text)) !== null) {
            const versionId = match[1].toLowerCase();
            const translation = translations.find(t => t.id === versionId);
            if (translation) {
                allMatches.push({ start: match.index, end: match.index + match[0].length,
                    html: `<span class="note-version-ref" data-version="${versionId}" data-book-id="${context.bookId}" data-chap="${context.chapN}" data-verse="${context.verseN}">${escapeHtml(match[0])}</span>` });
            }
        }
    }

    // ── Patrón @entrada:N ─────────────────────────────────────────
    if (studiesState) {
        const entryPattern = /@entrada:(\d+)/gi;
        while ((match = entryPattern.exec(text)) !== null) {
            const n = parseInt(match[1]);
            const entries = studiesGetActive(studiesState).entries;
            const entry = entries[n - 1];
            if (entry) {
                const preview = entry.type === 'verse' ? entry.ref : '📝 Nota';
                allMatches.push({ start: match.index, end: match.index + match[0].length,
                    html: `<span class="note-entry-ref" data-index="${n - 1}" title="${escapeHtml(preview)}">${escapeHtml(match[0])}</span>` });
            }
        }
    }

    // ── Patrón @estudio:nombre ───────────────────────────────────
    if (studiesState) {
        const studyPattern = /@estudio:([^\s]+)/gi;
        while ((match = studyPattern.exec(text)) !== null) {
            const nameRaw = match[1].replace(/_/g, ' ');
            const study = studiesState.studies.find(s => s.name.toLowerCase() === nameRaw.toLowerCase());
            if (study) {
                allMatches.push({ start: match.index, end: match.index + match[0].length,
                    html: `<span class="note-study-ref" data-study-id="${study.id}">${escapeHtml(match[0])}</span>` });
            }
        }
    }

    // ── Patrón de suscripción ────────────────────────────────────
    const notifyPattern = /activa(?:r)?(?: las?)? notificaciones?|suscr[íi]bete(?: al? estudio)?|suscr[íi]bete(?: para(?: recibir)?(?: las?)? actualizaciones?)?|activar? notificaciones?/gi;
    while ((match = notifyPattern.exec(text)) !== null) {
        allMatches.push({ start: match.index, end: match.index + match[0].length,
            html: `<span class="note-notify-ref">${escapeHtml(match[0])}</span>` });
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

    container.querySelectorAll('.note-notify-ref').forEach(el => {
        el.addEventListener('click', e => {
            e.stopPropagation();
            const active = studiesGetActive(studiesState);
            if (!active.subscribable) return;
            const nowSubbed = toggleStudySubscription(active.id, (active.entries || []).length);
            el.classList.toggle('note-notify-ref--on', nowSubbed);
            el.title = nowSubbed ? 'Notificaciones activadas 🔔' : 'Activar notificaciones';
            showSaveToast(nowSubbed ? 'Notificaciones activadas 🔔' : 'Notificaciones desactivadas');
        });
        // Estado inicial
        const active = studiesGetActive(studiesState);
        if (active.subscribable) {
            el.classList.toggle('note-notify-ref--on', isStudySubscribed(active.id));
            el.title = isStudySubscribed(active.id) ? 'Notificaciones activadas 🔔' : 'Activar notificaciones';
        }
    });

    container.querySelectorAll('.note-version-ref').forEach(el => {
        el.addEventListener('click', async e => {
            e.stopPropagation();
            // Toggle: si ya hay popup, quitarlo
            const existing = el.nextElementSibling;
            if (existing && existing.classList.contains('note-version-popup')) {
                existing.remove();
                el.classList.remove('note-version-ref--active');
                return;
            }

            const versionId = el.dataset.version;
            const bookId    = parseInt(el.dataset.bookId);
            const chapN     = parseInt(el.dataset.chap);
            const verseN    = parseInt(el.dataset.verse);

            // Cargar traducción si no está en caché
            let versionData = bibleCache[versionId];
            if (!versionData) {
                const translation = translations.find(t => t.id === versionId);
                if (!translation) return;
                const originalText = el.textContent;
                el.textContent = '⏳';
                try {
                    const resp = await fetch(translation.file);
                    versionData = await resp.json();
                    bibleCache[versionId] = versionData;
                } catch {
                    el.textContent = originalText;
                    return;
                }
                el.textContent = originalText;
            }

            const book    = versionData.find(b => b.id === bookId);
            const chapter = book && book.chapters.find(c => c.n === chapN);
            const verse   = chapter && chapter.v.find(v => v.n == verseN);
            if (!verse) return;

            const popup = document.createElement('span');
            popup.className = 'note-version-popup';
            popup.innerHTML = `<span class="nvp-label">${versionId.toUpperCase()}</span>${escapeHtml(verse.t)}`;
            el.classList.add('note-version-ref--active');
            el.after(popup);
        });
    });

    container.querySelectorAll('.note-entry-ref').forEach(el => {
        el.addEventListener('click', e => {
            e.stopPropagation();
            const idx = parseInt(el.dataset.index);
            closeNoteBadgeModal();
            document.getElementById('study-sheet').classList.add('ss-hidden');
            document.body.classList.remove('study-sheet-open');
            studyNavIndex = idx;
            localStorage.setItem('bible-study-nav-index', idx);
            studyNavUpdate();
            openStudyNavModal();
        });
    });

    container.querySelectorAll('.note-study-ref').forEach(el => {
        el.addEventListener('click', e => {
            e.stopPropagation();
            const studyId = el.dataset.studyId;
            closeNoteBadgeModal();
            closeStudyNavModal();
            studiesState = studiesSetActive(studiesState, studyId);
            studiesSave(studiesState);
            reapplyStudyMarkers();
            studyNavUpdate();
            openStudySheet(studyId);
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
                openNoteBadgeModal(entry.note, entry.ref, { bookId: entry.bookId, chapN: entry.chapN, verseN: entry.verseN }, entry.images);
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

function openNoteBadgeModal(note, ref, context, images) {
    document.getElementById('nbm-ref').textContent = ref || '';
    const noteEl = document.getElementById('nbm-note-text');
    noteEl.innerHTML = linkifyNoteText(note, context);
    attachNoteRefListeners(noteEl);
    const oldBox = noteEl.parentElement.querySelector('.entry-photos');
    if (oldBox) oldBox.remove();
    if (images && images.length) {
        const box = document.createElement('div');
        box.className = 'entry-photos';
        box.dataset.ids = JSON.stringify(images);
        noteEl.after(box);
        hydrateEntryPhotos(noteEl.parentElement);
    }
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
    return localStorage.getItem('bible-study-nav') !== 'off';
}

function studyNavEntries() {
    const active = studiesState ? studiesGetActive(studiesState) : null;
    return active?.entries || [];
}

function studyNavHasNotifyStep() {
    return !!studiesGetActive(studiesState).subscribable;
}

function studyNavTotalSteps(entries) {
    return studyNavHasNotifyStep() ? entries.length + 1 : entries.length;
}

function studyNavUpdate() {
    const bar = document.getElementById('study-nav-bar');
    if (!studyNavIsEnabled() || elements.viewReader.style.display !== 'block') {
        bar.classList.add('snb-hidden');
        if (window.innerWidth >= 1024) closeStudyNavModal();
        return;
    }
    // La barra siempre queda visible en el lector: con 0 entradas muestra
    // el estado en vez de ocultarse (el historial ☰ queda siempre accesible).
    bar.classList.remove('snb-hidden');

    const refEl = document.getElementById('snb-ref');
    const posEl = document.getElementById('snb-pos');
    const prevBtn = document.getElementById('snb-prev');
    const nextBtn = document.getElementById('snb-next');
    const baseBtn = document.getElementById('snb-base');
    const activeStudy = studiesState ? studiesGetActive(studiesState) : null;
    const entries = activeStudy?.entries || [];

    if (!activeStudy) {
        refEl.textContent = 'Sin estudio seleccionado';
        refEl.classList.add('snb-empty');
        posEl.textContent = '';
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        baseBtn.classList.add('snb-base-hidden');
        return;
    }

    if (!entries.length) {
        studyNavIndex = 0;
        localStorage.setItem('bible-study-nav-index', 0);
        refEl.textContent = `📓 ${activeStudy.name}: 0 entradas`;
        refEl.classList.add('snb-empty');
        posEl.textContent = '0/0';
        prevBtn.disabled = true;
        nextBtn.disabled = true;
    } else {
        refEl.classList.remove('snb-empty');
        // Clamp index (allowing notify step if applicable)
        const totalSteps = studyNavTotalSteps(entries);
        if (studyNavIndex >= totalSteps) studyNavIndex = totalSteps - 1;
        if (studyNavIndex < 0) studyNavIndex = 0;

        if (studyNavIndex === entries.length) {
            refEl.textContent = '🔔 Notificaciones';
        } else {
            const entry = entries[studyNavIndex];
            refEl.textContent = entry.type === 'verse' ? entry.ref : '📝 Nota';
        }
        posEl.textContent = `${studyNavIndex + 1}/${totalSteps}`;

        prevBtn.disabled = studyNavIndex === 0;
        nextBtn.disabled = studyNavIndex === totalSteps - 1;
    }

    if (activeStudy.baseRef) {
        baseBtn.classList.remove('snb-base-hidden');
        baseBtn.title = `Texto base: ${activeStudy.baseRef}`;
    } else {
        baseBtn.classList.add('snb-base-hidden');
    }

    // En pantalla grande: abrir el sidebar automáticamente o refrescar si ya está abierto
    if (window.innerWidth >= 1024) {
        const modal = document.getElementById('study-nav-modal');
        if (modal.classList.contains('snm-hidden')) {
            openStudyNavModal();
        } else {
            renderStudyNavList();
        }
    }

    refreshSnmNext();
}

// › del modal: al llegar al final se vuelve + para crear una nota nueva
function refreshSnmNext() {
    const nextBtn = document.getElementById('snm-next');
    if (!nextBtn) return;
    const total = studyNavTotalSteps(studyNavEntries());
    const atEnd = total === 0 || studyNavIndex >= total - 1;
    nextBtn.textContent = atEnd ? '+' : '›';
    nextBtn.disabled = false;
    nextBtn.title = atEnd ? 'Nueva nota' : 'Siguiente';
}

function studyNavGo(index) {
    const entries = studyNavEntries();
    if (!entries.length) return;
    const totalSteps = studyNavTotalSteps(entries);
    studyNavIndex = Math.max(0, Math.min(index, totalSteps - 1));
    localStorage.setItem('bible-study-nav-index', studyNavIndex);
    studyNavUpdate();

    if (studyNavIndex === entries.length) {
        openStudyNavModal();
        return;
    }
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
    document.getElementById('snm-pos').textContent = `${studyNavIndex + 1} de ${entries.length}`;
    refreshSnmNext();

    if (!entries.length) {
        content.innerHTML = '<div class="ss-empty">No hay entradas en este estudio.</div>';
        return;
    }

    const entry = entries[studyNavIndex];
    if (!entry) return;

    const isPC = window.innerWidth >= 1024;

    if (entry.type === 'verse') {
        const versionTag = entry.translationId
            ? `<span class="snm-version">${entry.translationId.toUpperCase()}</span>`
            : '';

        if (isPC) {
            // PC: mostrar con textarea para editar nota
            const noteHtml = entry.note
                ? `<div class="snm-list-note">${linkifyNoteText(entry.note, { bookId: entry.bookId, chapN: entry.chapN, verseN: entry.verseN })}</div>`
                : `<textarea class="snm-note-input" data-entry-id="${entry.id}" placeholder="Agregar nota..."></textarea>`;
            const actionsHtml = entry.note
                ? `<div class="snm-entry-actions">
                    <button class="snm-edit-note" data-entry-id="${entry.id}">✏️ Editar nota</button>
                    <button class="snm-delete-note" data-entry-id="${entry.id}">🗑️ Eliminar</button>
                   </div>`
                : `<div class="snm-save-area">
                    <button class="snm-save-note" data-entry-id="${entry.id}">💾 Guardar</button>
                    <button class="snm-cancel-note" data-entry-id="${entry.id}">Cancelar</button>
                   </div>`;

            content.innerHTML = `<div class="snm-list-item snm-list-active">
                <div class="snm-ref">${escapeHtml(entry.ref)}${versionTag}</div>
                <div class="snm-entry-text">${entry.text}</div>
                ${noteHtml}
                ${entryPhotosHtml(entry)}
                ${actionsHtml}
                <button class="snm-goto-btn snm-list-goto" data-index="${studyNavIndex}">→ Ir al versículo</button>
            </div>`;
            hydrateEntryPhotos(content);
        } else {
            // Móvil: comportamiento original
            content.innerHTML = `<div class="snm-list-item snm-list-active">
                <div class="snm-ref">${escapeHtml(entry.ref)}${versionTag}</div>
                ${entry.note ? `<div class="snm-list-note">${linkifyNoteText(entry.note, { bookId: entry.bookId, chapN: entry.chapN, verseN: entry.verseN })}</div>` : ''}
                ${entryPhotosHtml(entry)}
                <button class="snm-goto-btn snm-list-goto" data-index="${studyNavIndex}">→ Ir al versículo</button>
            </div>`;
            hydrateEntryPhotos(content);
        }
    } else {
        // Nota libre
        if (isPC) {
            content.innerHTML = `<div class="snm-list-item snm-list-item-note snm-list-active">
                <div class="snm-note-label">📝 Nota libre</div>
                <div class="snm-list-note">${linkifyNoteText(entry.text)}</div>
                ${entryPhotosHtml(entry)}
                <div class="snm-entry-actions">
                    <button class="snm-edit-note" data-entry-id="${entry.id}">✏️ Editar</button>
                    <button class="snm-delete-note" data-entry-id="${entry.id}">🗑️ Eliminar</button>
                </div>
            </div>`;
            hydrateEntryPhotos(content);
        } else {
            content.innerHTML = `<div class="snm-list-item snm-list-item-note snm-list-active">
                <div class="snm-note-label">📝 Nota libre</div>
                <div class="snm-list-note">${linkifyNoteText(entry.text)}</div>
                ${entryPhotosHtml(entry)}
            </div>`;
            hydrateEntryPhotos(content);
        }
    }

    content.querySelectorAll('.snm-list-goto').forEach(btn => {
        btn.addEventListener('click', () => {
            const i = parseInt(btn.dataset.index);
            const e = entries[i];
            studyNavIndex = i;
            localStorage.setItem('bible-study-nav-index', studyNavIndex);
            studyNavUpdate();
            studyNavNavigateToEntry(e);
        });
    });

    // Event listeners para PC
    if (isPC) {
        content.querySelectorAll('.snm-note-input').forEach(textarea => {
            textarea.addEventListener('blur', () => {
                const entryId = textarea.dataset.entryId;
                const newNote = textarea.value.trim();
                const entry = entries.find(e => e.id === entryId);
                if (entry && newNote !== (entry.note || '')) {
                    entry.note = newNote || null;
                    studiesSave(studiesState);
                    studyNavUpdate();
                    renderStudyNavList();
                }
            });
        });

        content.querySelectorAll('.snm-save-note').forEach(btn => {
            btn.addEventListener('click', () => {
                const entryId = btn.dataset.entryId;
                const textarea = content.querySelector(`.snm-note-input[data-entry-id="${entryId}"]`);
                if (textarea) {
                    const newNote = textarea.value.trim();
                    const entry = entries.find(e => e.id === entryId);
                    if (entry) {
                        entry.note = newNote || null;
                        studiesSave(studiesState);
                        studyNavUpdate();
                        renderStudyNavList();
                        if (newNote) showSaveToast('Nota guardada');
                    }
                }
            });
        });

        content.querySelectorAll('.snm-cancel-note').forEach(btn => {
            btn.addEventListener('click', () => {
                const entryId = btn.dataset.entryId;
                const textarea = content.querySelector(`.snm-note-input[data-entry-id="${entryId}"]`);
                if (textarea) {
                    textarea.value = '';
                }
            });
        });

        content.querySelectorAll('.snm-edit-note').forEach(btn => {
            btn.addEventListener('click', () => {
                const entryId = btn.dataset.entryId;
                const entry = entries.find(e => e.id === entryId);
                if (entry) {
                    if (entry.type === 'verse') {
                        openNoteSheet({
                            bookId: entry.bookId,
                            chapN: entry.chapN,
                            verseN: entry.verseN,
                            ref: entry.ref,
                            text: entry.text,
                            translationId: entry.translationId
                        }, entry, entry.studyId);
                    } else {
                        openNoteSheet(null, entry, entry.studyId);
                    }
                }
            });
        });

        content.querySelectorAll('.snm-delete-note').forEach(btn => {
            btn.addEventListener('click', () => {
                const entryId = btn.dataset.entryId;
                if (confirm('¿Eliminar esta entrada del estudio?')) {
                    const active = studiesGetActive(studiesState);
                    const doomed = active.entries.find(e => e.id === entryId);
                    studiesState = studiesDeleteEntry(studiesState, active.id, entryId);
                    studiesSave(studiesState);
                    if (doomed?.images?.length) notePhotoDB.delMany(doomed.images).catch(() => {});
                    const total = studyNavTotalSteps(studyNavEntries());
                    studyNavIndex = total ? Math.min(studyNavIndex, total - 1) : 0;
                    if (studyNavIndex < 0) studyNavIndex = 0;
                    localStorage.setItem('bible-study-nav-index', studyNavIndex);
                    studyNavUpdate();
                    renderStudyNavList();
                }
            });
        });
    }

    content.querySelectorAll('.snm-list-note').forEach(el => {
        attachNoteRefListeners(el);
    });
}

function renderStudyNavModal() {
    const entries = studyNavEntries();
    if (!entries.length) return;

    const totalSteps = studyNavTotalSteps(entries);
    // Clamp
    if (studyNavIndex >= totalSteps) studyNavIndex = totalSteps - 1;
    if (studyNavIndex < 0) studyNavIndex = 0;

    document.getElementById('snm-pos').textContent = `${studyNavIndex + 1} de ${totalSteps}`;
    document.getElementById('snm-prev').disabled = studyNavIndex === 0;
    refreshSnmNext();

    // Paso de notificación (último paso virtual)
    if (studyNavIndex === entries.length) {
        const active = studiesGetActive(studiesState);
        const subbed = isStudySubscribed(active.id);
        const content = document.getElementById('snm-content');
        content.innerHTML = `
            <div class="snm-notify-step">
                <div class="snm-notify-icon">${subbed ? '🔔' : '🔕'}</div>
                <div class="snm-notify-title">${subbed ? 'Notificaciones activadas' : 'Activar notificaciones'}</div>
                <div class="snm-notify-desc">${subbed ? 'Recibirás aviso cuando haya nuevas entregas en este estudio.' : 'Suscríbete para recibir aviso cuando se publiquen nuevas entregas en este estudio.'}</div>
                <button id="snm-notify-btn" class="snm-goto-btn">${subbed ? '🔕 Desactivar' : '🔔 Activar notificaciones'}</button>
            </div>
        `;
        document.getElementById('snm-notify-btn').addEventListener('click', () => {
            const nowSubbed = toggleStudySubscription(active.id, (active.entries || []).length);
            renderStudyNavModal();
            showSaveToast(nowSubbed ? 'Notificaciones activadas 🔔' : 'Notificaciones desactivadas');
        });
        return;
    }

    const entry = entries[studyNavIndex];

    const content = document.getElementById('snm-content');
    if (entry.type === 'verse') {
        const versionTag = entry.translationId
            ? `<span class="snm-version">${entry.translationId.toUpperCase()}</span>`
            : '';
        content.innerHTML = `
            <div class="snm-ref">${escapeHtml(entry.ref)}${versionTag}</div>
            <div class="snm-text">${escapeHtml(entry.text)}</div>
            ${entry.note ? `<div class="snm-note-label">Nota</div><div class="snm-note">${linkifyNoteText(entry.note, { bookId: entry.bookId, chapN: entry.chapN, verseN: entry.verseN })}</div>` : ''}
            ${entryPhotosHtml(entry)}
            <button id="snm-goto" class="snm-goto-btn">→ Ir al versículo</button>
        `;
        if (entry.note) attachNoteRefListeners(content.querySelector('.snm-note'));
        hydrateEntryPhotos(content);
        document.getElementById('snm-goto').addEventListener('click', () => {
            closeStudyNavModal();
            studyNavNavigateToEntry(entry);
        });
    } else {
        content.innerHTML = `
            <div class="snm-note-label">📝 Nota libre</div>
            <div class="snm-free-note">${linkifyNoteText(entry.text)}</div>
            ${entryPhotosHtml(entry)}
        `;
        attachNoteRefListeners(content.querySelector('.snm-free-note'));
        hydrateEntryPhotos(content);
    }
}

function studyNavInit() {
    document.getElementById('snb-prev').addEventListener('click', () => {
        studyNavGo(studyNavIndex - 1);
    });
    document.getElementById('snb-next').addEventListener('click', () => {
        studyNavGo(studyNavIndex + 1);
    });
    document.getElementById('snb-center').addEventListener('click', () => {
        const modal = document.getElementById('study-nav-modal');
        if (modal.classList.contains('snm-hidden')) {
            openStudyNavModal();
        } else {
            closeStudyNavModal();
        }
    });
    document.getElementById('snb-hist').addEventListener('click', openHistModal);
    document.getElementById('snbh-close').addEventListener('click', closeHistModal);
    document.getElementById('snbh-overlay').addEventListener('click', closeHistModal);

    document.getElementById('snb-base').addEventListener('click', () => {
        const baseRef = studiesGetActive(studiesState).baseRef;
        if (!baseRef) return;
        const parsed = parseQuery(baseRef);
        if (!parsed || !parsed.books?.length) return;
        const book = parsed.books[0];
        const chapN = parsed.chap || 1;
        const chapter = book.chapters.find(c => c.n === chapN);
        if (!chapter) return;
        if (parsed.type === 'verse' || parsed.type === 'range') pendingVerse = parsed.verse || parsed.verseStart;
        pendingChapterN = chapN;
        cleanupPageMode();
        showChapters(book);
        showReader(book, chapter);
    });

    document.getElementById('snm-overlay').addEventListener('click', closeStudyNavModal);
    document.getElementById('snm-prev').addEventListener('click', () => {
        studyNavIndex = Math.max(0, studyNavIndex - 1);
        localStorage.setItem('bible-study-nav-index', studyNavIndex);
        studyNavUpdate();
        renderStudyNavModal();
    });
    document.getElementById('snm-next').addEventListener('click', () => {
        const entries = studyNavEntries();
        const totalSteps = studyNavTotalSteps(entries);
        if (totalSteps === 0 || studyNavIndex >= totalSteps - 1) {
            closeStudyNavModal();
            openNoteSheet();
            return;
        }
        studyNavIndex = Math.min(totalSteps - 1, studyNavIndex + 1);
        localStorage.setItem('bible-study-nav-index', studyNavIndex);
        studyNavUpdate();
        renderStudyNavModal();
    });

    // Swipe horizontal en el contenido del modal
    const content = document.getElementById('snm-content');
    let swipeStartX = null;
    content.addEventListener('pointerdown', e => { swipeStartX = e.clientX; });
    content.addEventListener('pointerup', e => {
        if (swipeStartX === null) return;
        const dx = e.clientX - swipeStartX;
        swipeStartX = null;
        if (Math.abs(dx) < 40) return;
        const entries = studyNavEntries();
        const totalSteps = studyNavTotalSteps(entries);
        if (dx < 0 && studyNavIndex < totalSteps - 1) {
            studyNavIndex++;
        } else if (dx > 0 && studyNavIndex > 0) {
            studyNavIndex--;
        } else return;
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

// ── Notificaciones de estudios ────────────────────────────────

const NOTIFY_SUBS_KEY = 'bible-notify-subs';   // { studyId: entryCount }
const NOTIFY_EMAIL_KEY = 'bible-notify-email';

function getSubscriptions() {
    try { return JSON.parse(localStorage.getItem(NOTIFY_SUBS_KEY) || '{}'); } catch { return {}; }
}

function isStudySubscribed(studyId) {
    return studyId in getSubscriptions();
}

function toggleStudySubscription(studyId, currentEntryCount) {
    const subs = getSubscriptions();
    if (studyId in subs) {
        delete subs[studyId];
        localStorage.setItem(NOTIFY_SUBS_KEY, JSON.stringify(subs));
        return false;
    } else {
        // Guardar conteo y fecha del exportedAt local para detectar ediciones también
        const localStudy = studiesState.studies.find(s => s.id === studyId);
        subs[studyId] = {
            count: currentEntryCount,
            exportedAt: localStudy?.exportedAt || null
        };
        localStorage.setItem(NOTIFY_SUBS_KEY, JSON.stringify(subs));
        return true;
    }
}

async function checkStudyUpdates() {
    const subs = getSubscriptions();
    if (!Object.keys(subs).length) return;
    try {
        const res = await fetch(SHARED_API, { headers: { Accept: 'application/vnd.github.v3+json' } });
        if (!res.ok) return;
        const files = (await res.json()).filter(f => f.type === 'file' && f.name.endsWith('.json'));
        const results = await Promise.all(files.map(f => fetch(f.download_url).then(r => r.json()).catch(() => null)));

        const updatedStudies = [];
        results.forEach(data => {
            if (!data || !Array.isArray(data.studies)) return;
            data.studies.forEach(s => {
                if (!(s.id in subs)) return;
                const remoteCount = (s.entries || []).length;
                const remoteExportedAt = data.exportedAt || null;

                const localStudy = studiesState.studies.find(ls => ls.id === s.id);
                const localCount = localStudy ? (localStudy.entries || []).length : 0;
                const localExportedAt = localStudy?.exportedAt || null;

                const hasNewEntries = remoteCount > localCount;
                const hasEdits = remoteExportedAt && localExportedAt && remoteExportedAt !== localExportedAt && remoteCount === localCount;

                if (hasNewEntries) {
                    updatedStudies.push({ id: s.id, name: s.name, delta: remoteCount - localCount, type: 'new' });
                } else if (hasEdits) {
                    updatedStudies.push({ id: s.id, name: s.name, delta: 0, type: 'edit' });
                }
            });
        });

        if (updatedStudies.length) {
            const names = updatedStudies.map(s =>
                s.type === 'new'
                    ? `${s.name} (+${s.delta} entrada${s.delta !== 1 ? 's' : ''})`
                    : `${s.name} (actualizado)`
            ).join(', ');
            showStudyUpdateBanner(`🔔 Cambios en: ${names}`);
        }
    } catch { /* sin conexión, ignorar */ }
}

function showStudyUpdateBanner(text) {
    const banner = document.getElementById('study-update-banner');
    const textEl = document.getElementById('study-update-text');
    if (!banner || !textEl) return;
    textEl.textContent = text;
    banner.classList.remove('study-update-banner--hidden');
}

function hideStudyUpdateBanner() {
    const banner = document.getElementById('study-update-banner');
    if (banner) banner.classList.add('study-update-banner--hidden');
}

function updateNotifyEmailDisplay() {
    const input = document.getElementById('cfg-notify-email');
    const status = document.getElementById('cfg-notify-status');
    if (!input) return;
    const saved = localStorage.getItem(NOTIFY_EMAIL_KEY) || '';
    input.value = saved;
    if (status) status.textContent = saved ? `✅ Email guardado: ${saved}` : '';
}

// ── Modal de configuración ────────────────────────────────────

function openConfigModal() {
    updateModeToggleText();
    updateStudyAlertToggleText();
    updateRefsToggleText();
    updateNavToggleText();
    updateRestorePositionToggleText();
    updateAutosaveToggleText();
    updateNotifyEmailDisplay();
    document.getElementById('config-modal').classList.remove('cfg-hidden');
}

// ── Configuración de IA ───────────────────────────────────────

const AI_WORKER_URL = 'https://biblia-nbv-ai.www-davidalexander.workers.dev/bible';
const AI_WORKER_TRANSCRIBE_URL = AI_WORKER_URL.replace(/\/bible$/, '/transcribe');

// ── Sheet IA ─────────────────────────────────────────────────

let aiVerseContexts = []; // Array de contextos (versículos)
let aiConversation = [];  // Historial de mensajes
let aiMinimized = false;
let aiLastNoteText = '';  // Texto plano de la última respuesta para guardar como nota

function updateAIContextDisplay() {
    const ctxEl = document.getElementById('ais-verse-ctx');
    if (aiVerseContexts.length === 0) {
        ctxEl.innerHTML = '';
        return;
    }
    let label;
    if (aiVerseContexts.length === 1) {
        const ctx = aiVerseContexts[0];
        label = '<strong>Contexto:</strong> ' + ctx.ref + ' — "' + ctx.text + '"';
    } else {
        label = '<strong>Contexto (' + aiVerseContexts.length + ' versículos):</strong> ' + aiVerseContexts.map(function (c) { return c.ref; }).join(', ');
    }
    ctxEl.innerHTML = '<span class="ais-ctx-text">' + label + '</span><button class="ais-ctx-clear" title="Limpiar contexto" onclick="clearAIContext()">✕</button>';
}

function clearAIContext() {
    aiVerseContexts = [];
    updateAIContextDisplay();
    minimizeAISheet();
}

function addAIContext(ref, text, bookId, chapN, verseN) {
    // Evitar duplicados
    var exists = aiVerseContexts.some(function (c) { return c.ref === ref; });
    if (!exists) {
        aiVerseContexts.push({ ref: ref, text: text, bookId: bookId, chapN: chapN, verseN: verseN });
    }
    updateAIContextDisplay();
}

function buildSystemPrompt() {
    var ctxText = aiVerseContexts.map(function (c) { return c.ref + ' — "' + c.text + '"'; }).join('; ');
    return 'Eres un pastor y teologo cristiano evangelico. Respondes UNICAMENTE preguntas que tengan relacion directa con la Biblia, la fe cristiana o los versiculos de contexto. Si la pregunta no tiene relacion biblica responde exactamente: "No es posible responder esta pregunta porque no tiene relacion con la Biblia." y nada mas. Usa exclusivamente la Biblia como autoridad. No des consejos psicologicos, filosoficos ni seculares. Responde siempre en espanol. Se conciso: maximo 3 parrafos. Los versiculos de contexto son: ' + ctxText;
}

function showAISheet() {
    document.getElementById('ai-sheet').classList.remove('ais-hidden');
    document.getElementById('ai-minimized-indicator').classList.add('ais-min-hidden');
    aiMinimized = false;
}

function minimizeAISheet() {
    document.getElementById('ai-sheet').classList.add('ais-hidden');
    document.getElementById('ai-minimized-indicator').classList.remove('ais-min-hidden');
    aiMinimized = true;
}

document.getElementById('va-ai').addEventListener('click', function () {
    if (!selectedVerseEl) return;
    const { verseN, chapN } = getVerseInfo(selectedVerseEl);
    const ref = currentBook.name + ' ' + chapN + ':' + verseN;
    const verseText = selectedVerseEl.querySelector('.v-text')?.textContent || '';

    var sheetVisible = !document.getElementById('ai-sheet').classList.contains('ais-hidden');

    // Si es una conversación nueva (sin conversación Y sheet oculto), reiniciar todo
    if (aiConversation.length === 0 && !sheetVisible && !aiMinimized) {
        aiVerseContexts = [];
        aiConversation = [];
        aiLastNoteText = '';
        document.getElementById('ais-save-area').classList.add('ais-save-hidden');
        document.getElementById('ais-response').classList.add('ais-response-hidden');
        document.getElementById('ais-response').innerHTML = '';
    }

    // Añadir al contexto
    addAIContext(ref, verseText, currentBook.id, chapN, verseN);

    // Limpiar pregunta anterior pero mantener respuesta previa
    document.getElementById('ais-question').value = '';

    // Si el sheet está minimizado, restaurar; si ya está abierto, solo actualizar contexto
    if (!sheetVisible) {
        showAISheet();
    }
});

// Botón flotante para restaurar cuando está minimizado
// ── Botón flotante IA: draggable ─────────────────────────────
(function () {
    const btn = document.getElementById('ai-minimized-indicator');
    let dragging = false, startX, startY, origLeft, origTop, moved;

    function applyPos(left, top) {
        const maxX = window.innerWidth - btn.offsetWidth;
        const maxY = window.innerHeight - btn.offsetHeight;
        left = Math.max(0, Math.min(left, maxX));
        top  = Math.max(0, Math.min(top,  maxY));
        btn.style.right  = 'auto';
        btn.style.bottom = 'auto';
        btn.style.left   = left + 'px';
        btn.style.top    = top  + 'px';
        localStorage.setItem('ai-btn-pos', JSON.stringify({ left, top }));
    }

    // Restaurar posición guardada
    try {
        const saved = JSON.parse(localStorage.getItem('ai-btn-pos'));
        if (saved) applyPos(saved.left, saved.top);
    } catch (e) {}

    function onStart(cx, cy) {
        dragging = true;
        moved = false;
        const rect = btn.getBoundingClientRect();
        origLeft = rect.left;
        origTop  = rect.top;
        startX = cx;
        startY = cy;
    }
    function onMove(cx, cy) {
        if (!dragging) return;
        const dx = cx - startX, dy = cy - startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
        if (moved) applyPos(origLeft + dx, origTop + dy);
    }
    function onEnd() {
        dragging = false;
    }

    btn.addEventListener('mousedown',  e => { onStart(e.clientX, e.clientY); });
    window.addEventListener('mousemove', e => { onMove(e.clientX, e.clientY); });
    window.addEventListener('mouseup',   () => onEnd());

    btn.addEventListener('touchstart', e => { const t = e.touches[0]; onStart(t.clientX, t.clientY); }, { passive: true });
    window.addEventListener('touchmove', e => { if (dragging) { e.preventDefault(); const t = e.touches[0]; onMove(t.clientX, t.clientY); } }, { passive: false });
    window.addEventListener('touchend',  () => onEnd());

    // Solo abrir el sheet si no hubo movimiento real
    btn.addEventListener('click', e => { if (moved) { moved = false; e.stopImmediatePropagation(); } });
})();

document.getElementById('ai-minimized-indicator').addEventListener('click', showAISheet);

document.getElementById('ais-close').addEventListener('click', function () {
    minimizeAISheet();
});
document.getElementById('ais-overlay').addEventListener('click', function () {
    minimizeAISheet();
});

document.getElementById('ais-save-note').addEventListener('click', function () {
    if (!aiLastNoteText) return;
    minimizeAISheet();
    openNoteSheet(null);
    document.getElementById('ns-title').textContent = 'Guardar respuesta IA';
    document.getElementById('ns-note-input').value = aiLastNoteText;
});

document.getElementById('ais-add-to-current').addEventListener('click', function () {
    if (!aiLastNoteText) return;
    const entries = studyNavEntries();
    const entry = entries[studyNavIndex];
    if (!entry) {
        showSaveToast('No hay entrada activa');
        return;
    }
    minimizeAISheet();
    entry.note = entry.note ? entry.note + '\n\n---\n\n' + aiLastNoteText : aiLastNoteText;
    studiesSave(studiesState);
    studyNavUpdate();
    renderStudyNavList();
    showSaveToast('Nota agregada');
});

document.getElementById('ais-send').addEventListener('click', askAI);
document.getElementById('ais-question').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        askAI();
    }
});

async function askAI() {
    const question = document.getElementById('ais-question').value.trim();
    if (!question || aiVerseContexts.length === 0) return;

    const sendBtn = document.getElementById('ais-send');
    sendBtn.disabled = true;
    sendBtn.textContent = 'Consultando…';

    const messages = [{ role: 'system', content: buildSystemPrompt() }];
    aiConversation.forEach(msg => messages.push(msg));
    messages.push({ role: 'user', content: question });

    try {
        const res = await fetch(AI_WORKER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages }),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Error del servidor');

        const reply = data.reply;
        document.getElementById('ais-response').innerHTML = linkifyAIResponse(reply);
        setupAIResponseLinks();
        aiConversation.push({ role: 'user', content: question });
        aiConversation.push({ role: 'assistant', content: reply });
        aiLastNoteText = '🤖 ' + aiVerseContexts.map(c => c.ref).join(', ') + '\n\nPregunta: ' + question + '\n\nRespuesta:\n' + reply;
        document.getElementById('ais-save-area').classList.remove('ais-save-hidden');
        document.getElementById('ais-question').value = '';
        document.getElementById('ais-response').classList.remove('ais-response-hidden');
    } catch (e) {
        document.getElementById('ais-response').textContent = 'Error: ' + e.message;
        document.getElementById('ais-response').classList.remove('ais-response-hidden');
    }

    sendBtn.disabled = false;
    sendBtn.textContent = 'Preguntar';
}

// Detectar referencias bíblicas en la respuesta y hacerlas clicables
function linkifyAIResponse(text) {
    if (!text || !bibleData) return text;
    // Regex: libro capítulo:verso o libro capítulo:verso-verso
    // Acepta abreviaciones comunes
    const bookPatterns = [
        'Génesis', 'Exodo', 'Levítico', 'Números', 'Deuteronomio', 'Josué', 'Jueces', 'Ruth', '1 Samuel', '2 Samuel', '1 Reyes', '2 Reyes', '1 Crónicas', '2 Crónicas', 'Esdras', 'Nehemías', 'Tobías', 'Judit', 'Ester', 'Job', 'Salmos', 'Proverbios', 'Eclesiastés', 'Cantares', 'Isaías', 'Jeremías', 'Lamentaciones', 'Baruc', 'Ezequiel', 'Daniel', 'Oseas', 'Joel', 'Amós', 'Abdías', 'Jonás', 'Miqueas', 'Nahum', 'Habacuc', 'Sofonías', 'Hageo', 'Zacarías', 'Malaquías', 'Mateo', 'Marcos', 'Lucas', 'Juan', 'Hechos', 'Romanos', '1 Corintios', '2 Corintios', 'Gálatas', 'Efesios', 'Filipenses', 'Colosenses', '1 Tesalonicenses', '2 Tesalonicenses', '1 Timoteo', '2 Timoteo', 'Tito', 'Filemón', 'Hebreos', 'Santiago', '1 Pedro', '2 Pedro', '1 Juan', '2 Juan', '3 Juan', 'Judas', 'Apocalipsis',
        'Gen', 'Ex', 'Lev', 'Num', 'Dt', 'Jos', 'Jue', 'Ruth', '1 Sam', '2 Sam', '1 Rey', '2 Rey', '1 Cr', '2 Cr', 'Esd', 'Neh', 'Tob', 'Jdt', 'Est', 'Job', 'Sal', 'Prov', 'Ecl', 'Cant', 'Is', 'Jer', 'Lam', 'Bar', 'Ez', 'Dan', 'Os', 'Jl', 'Am', 'Abd', 'Jon', 'Miq', 'Nah', 'Hab', 'Sof', 'Hag', 'Zac', 'Mal', 'Mt', 'Mc', 'Lc', 'Jn', 'Hch', 'Rom', '1 Co', '2 Co', 'Gál', 'Ef', 'Flp', 'Col', '1 Tes', '2 Tes', '1 Tim', '2 Tim', 'Tit', 'Flm', 'Heb', 'Stg', '1 Pe', '2 Pe', '1 Jn', '2 Jn', '3 Jn', 'Jud', 'Ap'
    ].join('|');
    const regex = new RegExp('(' + bookPatterns + ')\\s+(\\d+)(?::(\\d+)(?:-(\\d+))?)?', 'gi');
    return text.replace(regex, function (match, book, chap, verse, verseEnd) {
        const parsed = parseQuery(book + ' ' + chap + (verse ? ':' + verse + (verseEnd ? '-' + verseEnd : '') : ''));
        if (parsed && parsed.books && parsed.books[0]) {
            const b = parsed.books[0];
            const ref = b.name + ' ' + chap + ':' + (verse || '1') + (verseEnd ? '-' + verseEnd : '');
            return '<span class="ais-ref" data-book="' + b.id + '" data-chap="' + chap + '" data-verse="' + (verse || '1') + '" data-verse-end="' + (verseEnd || '') + '">' + ref + '</span>';
        }
        return match;
    });
}

function setupAIResponseLinks() {
    const responseEl = document.getElementById('ais-response');
    responseEl.querySelectorAll('.ais-ref').forEach(function (el) {
        el.addEventListener('click', function () {
            const bookId = parseInt(this.dataset.book);
            const chap = parseInt(this.dataset.chap);
            const verse = parseInt(this.dataset.verse);
            const book = bibleData.find(function (b) { return b.id === bookId; });
            if (!book) return;
            const chapter = book.chapters.find(function (c) { return c.n === chap; });
            if (!chapter) return;
            // Usar el mismo patrón que studyNavNavigateToEntry
            pendingVerse = verse;
            pendingChapterN = chap;
            minimizeAISheet();
            cleanupPageMode();
            showChapters(book);
            showReader(book, chapter);
        });
    });
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
    const sesSubEl = document.getElementById('ses-subscribable');
    if (sesSubEl) sesSubEl.checked = study ? !!study.subscribable : false;
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
        const subscribable = document.getElementById('ses-subscribable')?.checked ?? false;
        const studyId = sheet.dataset.studyId;
        const autoActivate = sheet.dataset.autoActivate === 'true';

        if (studyId) {
            studiesState = studiesUpdateStudy(studiesState, studyId, { name, tags, subscribable });
            studiesSave(studiesState);
            renderStudiesDropdown();
            closeStudyEditSheet();
            showSaveToast('Estudio actualizado');
        } else {
            studiesState = studiesCreate(studiesState, name, tags, subscribable);
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

    // Guardar email de notificaciones
    document.getElementById('cfg-notify-save').addEventListener('click', () => {
        const input = document.getElementById('cfg-notify-email');
        const status = document.getElementById('cfg-notify-status');
        const email = (input.value || '').trim();
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            if (status) status.textContent = '⚠️ Email no válido.';
            return;
        }
        localStorage.setItem(NOTIFY_EMAIL_KEY, email);
        if (status) status.textContent = email ? `✅ Email guardado: ${email}` : '❌ Email eliminado.';
    });

    // Banner de actualización
    document.getElementById('study-update-open').addEventListener('click', () => {
        hideStudyUpdateBanner();
        openSharedSheet();
    });
    document.getElementById('study-update-dismiss').addEventListener('click', hideStudyUpdateBanner);

    document.getElementById('sd-import-file').addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
            try {
                const data = JSON.parse(ev.target.result);
                if (!data.studies || !Array.isArray(data.studies)) throw new Error();
                openImportSheet(data.studies, data.photos);
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
        document.getElementById('ims-mode-hint').textContent = hints[btn.dataset.mode];
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

async function doExport() {
    const selected = [...document.querySelectorAll('.exs-check:checked')].map(cb => cb.dataset.studyId);
    if (!selected.length) { showSaveToast('Selecciona al menos un estudio'); return; }

    const studies = studiesState.studies.filter(s => selected.includes(s.id));
    // Fotos referenciadas (binario de IndexedDB, no cabe en localStorage)
    const photoIds = new Set();
    studies.forEach(s => (s.entries || []).forEach(e => (e.images || []).forEach(id => photoIds.add(id))));
    const photos = {};
    for (const id of photoIds) {
        try {
            const b64 = await notePhotoDB.get(id);
            if (b64) photos[id] = b64;
        } catch { /* se omite */ }
    }
    const payload = { version: 1, exportedAt: new Date().toISOString(), studies, photos };
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
let importPhotosBuffer = {};

function openImportSheet(studies, photos) {
    importStudiesBuffer = studies;
    importPhotosBuffer = photos || {};
    const list = document.getElementById('ims-list');
    const existingIds = new Set(studiesState.studies.map(s => s.id));
    const existingNames = new Set(studiesState.studies.map(s => s.name));

    document.getElementById('ims-select-all').checked = true;
    // Reset mode to merge
    document.querySelectorAll('.ims-mode-btn').forEach(b => b.classList.remove('ims-mode-active'));
    document.querySelector('.ims-mode-btn[data-mode="merge"]').classList.add('ims-mode-active');
    document.getElementById('ims-mode-hint').textContent = 'Fusionar: agrega los estudios sin borrar los existentes. Si hay conflicto de ID, se omite el importado.';

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
    importPhotosBuffer = {};
}

async function doImport() {
    const selectedIdxs = [...document.querySelectorAll('.ims-check:checked')].map(cb => parseInt(cb.dataset.idx));
    if (!selectedIdxs.length) { showSaveToast('Selecciona al menos un estudio'); return; }

    const mode = document.querySelector('.ims-mode-btn.ims-mode-active').dataset.mode;
    const selected = selectedIdxs.map(i => importStudiesBuffer[i]);
    const existingIds = new Set(studiesState.studies.map(s => s.id));
    let added = 0, replaced = 0, lastId = null;

    // Restaura las fotos del archivo a IndexedDB (ignora las que ya existen)
    for (const [id, b64] of Object.entries(importPhotosBuffer || {})) {
        try {
            const exists = await notePhotoDB.get(id);
            if (!exists && b64) await notePhotoDB.save(id, b64);
        } catch { /* se omite */ }
    }

    selected.forEach(s => {
        const study = { ...s, tags: s.tags || [], entries: s.entries || [] };
        if (existingIds.has(s.id)) {
            if (mode === 'replace') {
                studiesState = { ...studiesState, studies: studiesState.studies.map(ex => ex.id === s.id ? study : ex) };
                replaced++;
                lastId = s.id;
            }
            // merge: skip
        } else {
            studiesState = { ...studiesState, studies: [...studiesState.studies, study] };
            existingIds.add(s.id);
            added++;
            lastId = s.id;
        }
    });

    if (lastId) studiesState = studiesSetActive(studiesState, lastId);
    studiesSave(studiesState);
    studyNavReset();
    studyNavUpdate();
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
                data.studies.forEach(s => sharedAllStudies.push({ ...s, _exportedAt: date, _exportedAtRaw: data.exportedAt || null }));
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
    let added = 0, lastId = null;

    selectedIdxs.forEach(i => {
        const s = sharedAllStudies[i];
        if (!s || existingIds.has(s.id)) return;
        const { _exportedAt, _exportedAtRaw, ...study } = s;
        studiesState = { ...studiesState, studies: [...studiesState.studies, { ...study, tags: study.tags || [], entries: study.entries || [], exportedAt: _exportedAtRaw || null }] };
        existingIds.add(s.id);
        added++;
        lastId = s.id;
    });

    if (lastId) studiesState = studiesSetActive(studiesState, lastId);
    studiesSave(studiesState);
    studyNavReset();
    studyNavUpdate();
    renderStudiesDropdown();
    closeSharedSheet();
    showSaveToast(added ? `${added} estudio(s) importado(s)` : 'Sin cambios (ya los tienes)');
}

// ── Instalación PWA ───────────────────────────────────────────

(function () {
    const banner     = document.getElementById('pwa-banner');
    const bannerText = banner.querySelector('.pwa-banner-text');
    const installBtn = document.getElementById('pwa-install-btn');
    const dismissBtn = document.getElementById('pwa-dismiss-btn');

    // Ya corre como PWA → no mostrar nada
    if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) return;

    // Usuario ya descartó el banner en esta sesión
    if (sessionStorage.getItem('pwa-banner-dismissed')) return;

    let deferredPrompt = null;

    function showInstallBanner() {
        bannerText.textContent = '📲 Agrega esta app a tus aplicaciones';
        installBtn.textContent = 'Instalar';
        installBtn.onclick = async () => {
            if (!deferredPrompt) return;
            deferredPrompt.prompt();
            await deferredPrompt.userChoice;
            deferredPrompt = null;
            banner.classList.add('pwa-banner-hidden');
        };
        banner.classList.remove('pwa-banner-hidden');
    }

    function showOpenBanner() {
        bannerText.textContent = '✅ Ya tienes la app instalada';
        installBtn.textContent = 'Abrir';
        installBtn.onclick = () => { window.location.href = './'; };
        banner.classList.remove('pwa-banner-hidden');
    }

    // Detectar si ya está instalada
    if (navigator.getInstalledRelatedApps) {
        navigator.getInstalledRelatedApps().then(apps => {
            if (apps && apps.length > 0) {
                showOpenBanner();
            }
        }).catch(() => {});
    }

    window.addEventListener('beforeinstallprompt', e => {
        e.preventDefault();
        deferredPrompt = e;
        showInstallBanner();
    });

    dismissBtn.addEventListener('click', () => {
        banner.classList.add('pwa-banner-hidden');
        sessionStorage.setItem('pwa-banner-dismissed', '1');
    });

    window.addEventListener('appinstalled', () => {
        banner.classList.add('pwa-banner-hidden');
        deferredPrompt = null;
    });
})();

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

// ── Modal Landing ─────────────────────────────────────────────
const landingModal = (function () {
    const TUTORIAL_KEY = 'tutorial-enabled';
    const modal          = document.getElementById('landing-modal');
    const overlay        = document.getElementById('lm-overlay');
    const closeBtn       = document.getElementById('lm-close');
    const continueTop    = document.getElementById('lm-continue-top');
    const continueBottom = document.getElementById('lm-continue-bottom');

    function open() {
        modal.classList.remove('lm-hidden');
    }

    function close() {
        modal.classList.add('lm-hidden');
        localStorage.setItem(TUTORIAL_KEY, 'false');
        // Sincronizar toggle en ajustes si está visible
        const toggle = document.getElementById('cfg-tutorial-toggle');
        if (toggle) renderTutorialToggle(toggle);
    }

    function isEnabled() {
        return localStorage.getItem(TUTORIAL_KEY) !== 'false';
    }

    function renderTutorialToggle(btn) {
        btn.textContent = isEnabled() ? 'Activado' : 'Desactivado';
        btn.classList.toggle('cfg-toggle-on', isEnabled());
    }

    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', close);
    continueTop.addEventListener('click', close);
    continueBottom.addEventListener('click', close);

    // Mostrar si está habilitado
    if (isEnabled()) open();

    // Toggle en ajustes
    document.getElementById('cfg-tutorial-toggle').addEventListener('click', function () {
        const next = !isEnabled();
        localStorage.setItem(TUTORIAL_KEY, next ? 'true' : 'false');
        renderTutorialToggle(this);
    });

    // Inicializar estado visual del toggle
    renderTutorialToggle(document.getElementById('cfg-tutorial-toggle'));

    return { open, close, isEnabled };
})();
