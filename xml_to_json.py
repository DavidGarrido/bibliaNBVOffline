#!/usr/bin/env python3
"""
xml_to_json.py — Convierte archivos XML del formato Beblia a bible-{version}.json

Uso:
    python xml_to_json.py <archivo.xml> <nombre_version>

Ejemplo:
    python xml_to_json.py SpanishTLABible.xml tla
    → genera bible-tla.json

Formato de entrada (Beblia):
    <bible>
      <testament name="Old">
        <book number="1">
          <chapter number="1">
            <verse number="1">Texto...</verse>
          </chapter>
        </book>
      </testament>
    </bible>

Formato de salida:
    [
      {"id": 1, "name": "Génesis", "chapters": [
        {"n": 1, "v": [{"n": "1", "t": "Texto..."}, ...]}
      ]},
      ...
    ]
"""

import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

BOOK_NAMES = {
    1: "Génesis", 2: "Éxodo", 3: "Levítico", 4: "Números", 5: "Deuteronomio",
    6: "Josué", 7: "Jueces", 8: "Rut", 9: "1 Samuel", 10: "2 Samuel",
    11: "1 Reyes", 12: "2 Reyes", 13: "1 Crónicas", 14: "2 Crónicas",
    15: "Esdras", 16: "Nehemías", 17: "Ester", 18: "Job", 19: "Salmos",
    20: "Proverbios", 21: "Eclesiastés", 22: "Cantares", 23: "Isaías",
    24: "Jeremías", 25: "Lamentaciones", 26: "Ezequiel", 27: "Daniel",
    28: "Oseas", 29: "Joel", 30: "Amós", 31: "Abdías", 32: "Jonás",
    33: "Miqueas", 34: "Nahúm", 35: "Habacuc", 36: "Sofonías", 37: "Hageo",
    38: "Zacarías", 39: "Malaquías", 40: "Mateo", 41: "Marcos", 42: "Lucas",
    43: "Juan", 44: "Hechos", 45: "Romanos", 46: "1 Corintios",
    47: "2 Corintios", 48: "Gálatas", 49: "Efesios", 50: "Filipenses",
    51: "Colosenses", 52: "1 Tesalonicenses", 53: "2 Tesalonicenses",
    54: "1 Timoteo", 55: "2 Timoteo", 56: "Tito", 57: "Filemón",
    58: "Hebreos", 59: "Santiago", 60: "1 Pedro", 61: "2 Pedro",
    62: "1 Juan", 63: "2 Juan", 64: "3 Juan", 65: "Judas", 66: "Apocalipsis",
}


def convert(xml_path: Path) -> list:
    tree = ET.parse(xml_path)
    root = tree.getroot()

    bible = []
    for testament in root.findall('testament'):
        for book_el in testament.findall('book'):
            book_id = int(book_el.get('number'))
            name = BOOK_NAMES.get(book_id, f"Libro {book_id}")
            chapters = []
            for chap_el in book_el.findall('chapter'):
                chap_n = int(chap_el.get('number'))
                verses = []
                for verse_el in chap_el.findall('verse'):
                    text = (verse_el.text or '').strip()
                    if text:
                        verses.append({'n': verse_el.get('number'), 't': text})
                if verses:
                    chapters.append({'n': chap_n, 'v': verses})
            if chapters:
                bible.append({'id': book_id, 'name': name, 'chapters': chapters})

    bible.sort(key=lambda b: b['id'])
    return bible


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)

    xml_path = Path(sys.argv[1])
    version = sys.argv[2].lower()

    if not xml_path.exists():
        sys.exit(f"Error: no se encontró {xml_path}")

    print(f"Convirtiendo {xml_path.name}...")
    bible = convert(xml_path)

    out_path = Path(__file__).parent / f"bible-{version}.json"
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(bible, f, ensure_ascii=False, separators=(',', ':'))

    print(f"✓ {len(bible)} libros → {out_path}")
    size_kb = out_path.stat().st_size / 1024
    print(f"  Tamaño: {size_kb:.0f} KB")


if __name__ == '__main__':
    main()
