#!/usr/bin/env python3
"""
Convierte BE-Scofield.cmt.mybible (SQLite) a commentary-scofield.json
Formato de salida: { "bookId_cap_vers": "texto...", ... }
"""
import sqlite3, json, re
from pathlib import Path

DB = Path(__file__).parent / 'BE-Scofield.cmt.mybible'
OUT = Path(__file__).parent.parent / 'commentary-scofield.json'

def clean(html):
    # Eliminar el versículo inicial (antes del primer <br/><br/>)
    sep = '<br/><br/>'
    idx = html.find(sep)
    if idx != -1:
        html = html[idx + len(sep):]
    # Eliminar tags HTML
    text = re.sub(r'<[^>]+>', ' ', html)
    # Decodificar entidades básicas
    text = text.replace('&nbsp;', ' ').replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"')
    # Limpiar espacios
    text = re.sub(r'\s+', ' ', text).strip()
    return text

con = sqlite3.connect(DB)
rows = con.execute('SELECT book, chapter, fromverse, toverse, data FROM commentary').fetchall()

notes = {}
for book, chapter, fromverse, toverse, data in rows:
    if not data or not data.strip():
        continue
    text = clean(data)
    if not text:
        continue
    # Asignar la nota a cada verso del rango
    for verse in range(fromverse, toverse + 1):
        key = f"{book}_{chapter}_{verse}"
        # Si ya existe una nota para ese verso, concatenar
        if key in notes:
            notes[key] += ' ' + text
        else:
            notes[key] = text

con.close()

with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(notes, f, ensure_ascii=False, separators=(',', ':'))

size_kb = OUT.stat().st_size / 1024
print(f"✓ {len(notes)} notas → {OUT} ({size_kb:.0f} KB)")
