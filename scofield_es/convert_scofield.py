#!/usr/bin/env python3
"""
Convierte BE-Scofield.cmt.mybible (SQLite) a commentary-scofield.json
Formato de salida: { "bookId_cap_vers": "html con .note-bible-ref", ... }
"""
import sqlite3, json, re
from pathlib import Path

DB = Path(__file__).parent / 'BE-Scofield.cmt.mybible'
OUT = Path(__file__).parent.parent / 'commentary-scofield.json'

# Abreviaciones del módulo → bookId
ABBR = {
    'Gen':1,'Exo':2,'Lev':3,'Num':4,'Deu':5,'Jos':6,'Jue':7,'Rut':8,
    '1Sa':9,'2Sa':10,'1Re':11,'2Re':12,'1Cr':13,'2Cr':14,'Esd':15,
    'Neh':16,'Est':17,'Job':18,'Sal':19,'Pro':20,'Ecl':21,'Cnt':22,
    'Isa':23,'Jer':24,'Lam':25,'Eze':26,'Dan':27,'Ose':28,'Joe':29,
    'Amo':30,'Abd':31,'Jon':32,'Miq':33,'Nah':34,'Hab':35,'Sof':36,
    'Hag':37,'Zac':38,'Mal':39,'Mat':40,'Mar':41,'Luc':42,'Jua':43,
    'Hch':44,'Rom':45,'1Co':46,'2Co':47,'Gal':48,'Efe':49,'Flp':50,
    'Col':51,'1Ts':52,'2Ts':53,'1Ti':54,'2Ti':55,'Tit':56,'Flm':57,
    'Heb':58,'Stg':59,'1Pe':60,'2Pe':61,'1Jn':62,'2Jn':63,'3Jn':64,
    'Jud':65,'Apo':66,
}

def convert_links(html):
    """Convierte <a class='bible' href='#bABR_C:V'>texto</a> a spans .note-bible-ref"""
    def replace(m):
        href = m.group(1)
        label = m.group(2)
        # href formato: #bABR_C:V o #bABR_C:V-V2
        ref_m = re.match(r'#b([A-Za-z0-9]+)_(\d+):(\d+)(?:-(\d+))?', href)
        if not ref_m:
            return label
        abbr, chap, verse = ref_m.group(1), ref_m.group(2), ref_m.group(3)
        verse_end = ref_m.group(4)
        book_id = ABBR.get(abbr)
        if not book_id:
            return label
        extra = f' data-verse-end="{verse_end}"' if verse_end else ''
        return (f'<span class="note-bible-ref" data-book-id="{book_id}" '
                f'data-chap="{chap}" data-verse="{verse}"{extra}>{label}</span>')
    return re.sub(r"<a[^>]*href='([^']*)'[^>]*>([^<]*)</a>", replace, html)

def clean(html):
    # Eliminar el versículo inicial (antes del primer <br/><br/>)
    sep = '<br/><br/>'
    idx = html.find(sep)
    if idx != -1:
        html = html[idx + len(sep):]
    # Convertir links bíblicos antes de eliminar el resto del HTML
    html = convert_links(html)
    # Eliminar tags HTML restantes (excepto los spans que acabamos de crear)
    html = re.sub(r'<(?!/?span)[^>]+>', ' ', html)
    # Decodificar entidades básicas
    html = html.replace('&nbsp;', ' ').replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"')
    # Limpiar espacios
    html = re.sub(r'  +', ' ', html).strip()
    return html

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
