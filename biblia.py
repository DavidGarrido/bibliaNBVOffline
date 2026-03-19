#!/usr/bin/env python3
"""
biblia.py — consulta la Biblia desde la línea de comandos.

Uso:
    python biblia.py [versión] <cita>

Versiones disponibles: nbv, nvi, rvr1960, dhh  (por defecto: nbv)

Ejemplos:
    python biblia.py Juan 3:16
    python biblia.py nvi Juan 3:16
    python biblia.py rvr1960 "Sal 23"
    python biblia.py "Génesis 1:1-3"
    python biblia.py dhh Génesis
"""

import json
import re
import sys
import unicodedata
from pathlib import Path

VERSIONS = {'nbv', 'nvi', 'rvr1960', 'dhh'}
BASE_DIR = Path(__file__).parent


def norm(s: str) -> str:
    """Normaliza igual que normStr() en app.js."""
    s = s.lower()
    s = unicodedata.normalize('NFD', s)
    s = re.sub(r'[\u0300-\u036f]', '', s)
    s = re.sub(r'\s+', '', s)
    return s.strip()


def load_bible(version: str) -> list:
    path = BASE_DIR / f'bible-{version}.json'
    if not path.exists():
        sys.exit(f'Error: no se encontró {path}')
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def find_books(bible: list, query: str) -> list:
    q = norm(query)
    if not q:
        return []
    results = []
    for b in bible:
        n = norm(b['name'])
        if n.startswith(q) or q in n:
            results.append(b)
    return results[:5]


def parse_query(bible: list, raw: str):
    text = raw.strip()
    if not text:
        return None

    # libro cap:v1-v2  o  libro cap v1-v2
    m = re.match(r'^(.+?)\s+(\d+)[:\s]+(\d+)[\s-]+(\d+)$', text)
    if m:
        books = find_books(bible, m.group(1))
        if books:
            v1, v2 = int(m.group(3)), int(m.group(4))
            return {'type': 'range', 'books': books, 'chap': int(m.group(2)),
                    'verse_start': min(v1, v2), 'verse_end': max(v1, v2)}

    # libro cap:verso  o  libro cap verso
    m = re.match(r'^(.+?)\s+(\d+)[:\s]+(\d+)$', text)
    if m:
        books = find_books(bible, m.group(1))
        if books:
            return {'type': 'verse', 'books': books,
                    'chap': int(m.group(2)), 'verse': int(m.group(3))}

    # libro cap
    m = re.match(r'^(.+?)\s+(\d+)$', text)
    if m:
        books = find_books(bible, m.group(1))
        if books:
            return {'type': 'chapter', 'books': books, 'chap': int(m.group(2))}

    # solo libro
    books = find_books(bible, text)
    if books:
        return {'type': 'book', 'books': books}

    return None


def find_chapter(book: dict, n: int):
    for c in book['chapters']:
        if c['n'] == n:
            return c
    return None


def print_result(parsed: dict, version: str):
    t = parsed['type']

    if t == 'range':
        for book in parsed['books']:
            chap = find_chapter(book, parsed['chap'])
            if not chap:
                continue
            verses = [v for v in chap['v']
                      if parsed['verse_start'] <= int(v['n']) <= parsed['verse_end']]
            if not verses:
                continue
            ref = f"{book['name']} {parsed['chap']}:{parsed['verse_start']}-{parsed['verse_end']}"
            print(f"\n{ref}  [{version.upper()}]")
            print('─' * len(ref))
            for v in verses:
                print(f"{v['n']} {v['t']}")

    elif t == 'verse':
        for book in parsed['books']:
            chap = find_chapter(book, parsed['chap'])
            if not chap:
                continue
            verse = next((v for v in chap['v'] if int(v['n']) == parsed['verse']), None)
            ref = f"{book['name']} {parsed['chap']}:{parsed['verse']}"
            print(f"\n{ref}  [{version.upper()}]")
            print('─' * len(ref))
            if verse:
                print(verse['t'])
            else:
                print('Versículo no encontrado.')

    elif t == 'chapter':
        for book in parsed['books']:
            chap = find_chapter(book, parsed['chap'])
            if not chap:
                print(f"\n{book['name']}: capítulo {parsed['chap']} no existe "
                      f"({len(book['chapters'])} caps).")
                continue
            ref = f"{book['name']} {parsed['chap']}"
            print(f"\n{ref}  [{version.upper()}]")
            print('─' * len(ref))
            for v in chap['v']:
                print(f"{v['n']} {v['t']}")

    elif t == 'book':
        for book in parsed['books']:
            print(f"\n{book['name']}  [{version.upper()}]  — {len(book['chapters'])} capítulos")
            print('─' * 40)
            # muestra capítulo 1
            chap = book['chapters'][0]
            print(f"Capítulo 1:")
            for v in chap['v']:
                print(f"  {v['n']} {v['t']}")


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(0)

    # detectar versión como primer argumento
    if args[0].lower() in VERSIONS:
        version = args[0].lower()
        query = ' '.join(args[1:])
    else:
        version = 'nbv'
        query = ' '.join(args)

    if not query:
        print(__doc__)
        sys.exit(0)

    bible = load_bible(version)
    parsed = parse_query(bible, query)

    if not parsed:
        print(f'No se encontró ningún resultado para: "{query}"')
        sys.exit(1)

    print_result(parsed, version)


if __name__ == '__main__':
    main()
