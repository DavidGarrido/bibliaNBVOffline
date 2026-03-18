#!/usr/bin/env python3
"""
Consulta referencias cruzadas de un versículo.
Uso:  python3 consultar_refs.py "GEN 1 1"
      python3 consultar_refs.py "JOH 3 16"
      python3 consultar_refs.py "PSA 23 1"
"""
import json, sys, os

ABBR = {
    "GEN":1,"EXO":2,"LEV":3,"NUM":4,"DEU":5,"JOS":6,"JDG":7,"RUT":8,
    "1SA":9,"2SA":10,"1KI":11,"2KI":12,"1CH":13,"2CH":14,"EZR":15,
    "NEH":16,"EST":17,"JOB":18,"PSA":19,"PRO":20,"ECC":21,"SNG":22,"SOS":22,
    "ISA":23,"JER":24,"LAM":25,"EZK":26,"EZE":26,"DAN":27,"HOS":28,
    "JOE":29,"JOL":29,"AMO":30,"OBA":31,"JON":32,"MIC":33,"NAH":34,
    "HAB":35,"ZEP":36,"HAG":37,"ZEC":38,"MAL":39,"MAT":40,"MRK":41,
    "MAR":41,"LUK":42,"JOH":43,"ACT":44,"ROM":45,"1CO":46,"2CO":47,
    "GAL":48,"EPH":49,"PHP":50,"PHI":50,"COL":51,"1TH":52,"2TH":53,
    "1TI":54,"2TI":55,"TIT":56,"PHM":57,"HEB":58,"JAS":59,"JAM":59,
    "1PE":60,"2PE":61,"1JO":62,"2JO":63,"3JO":64,"JUD":65,"JDE":65,
    "REV":66,
}

DIR = os.path.dirname(__file__)

# Nombres en español → ID de libro (incluye abreviaciones comunes)
SPANISH = {
    "genesis":1,"gen":1,"gén":1,"exodo":2,"éxodo":2,"exo":2,"ex":2,
    "levitico":3,"levítico":3,"lev":3,"numeros":4,"números":4,"num":4,"núm":4,
    "deuteronomio":5,"deut":5,"deu":5,"josue":6,"josué":6,"jos":6,
    "jueces":7,"jue":7,"rut":8,"rut":8,
    "1samuel":9,"1 samuel":9,"1sa":9,"2samuel":10,"2 samuel":10,"2sa":10,
    "1reyes":11,"1 reyes":11,"1re":11,"2reyes":12,"2 reyes":12,"2re":12,
    "1cronicas":13,"1 crónicas":13,"1crónicas":13,"1cr":13,
    "2cronicas":14,"2 crónicas":14,"2crónicas":14,"2cr":14,
    "esdras":15,"esd":15,"nehemias":16,"nehemías":16,"neh":16,
    "ester":17,"éster":17,"est":17,"job":18,
    "salmos":19,"sal":19,"salmo":19,"proverbios":20,"prov":20,"pro":20,
    "eclesiastes":21,"eclesiastés":21,"ecl":21,"ec":21,
    "cantares":22,"cant":22,"cnt":22,
    "isaias":23,"isaías":23,"isa":23,"jeremias":24,"jeremías":24,"jer":24,
    "lamentaciones":25,"lam":25,"ezequiel":26,"ezeq":26,"eze":26,"ez":26,
    "daniel":27,"dan":27,"oseas":28,"os":28,"joel":29,"joe":29,
    "amos":30,"amós":30,"am":30,"abdias":31,"abdías":31,"abd":31,
    "jonas":32,"jonás":32,"jon":32,"miqueas":33,"miq":33,"mic":33,
    "nahum":34,"nahúm":34,"nah":34,"habacuc":35,"hab":35,
    "sofonias":36,"sofonías":36,"sof":36,"hageo":37,"hag":37,
    "zacarias":38,"zacarías":38,"zac":38,"malaquias":39,"malaquías":39,"mal":39,
    "mateo":40,"mat":40,"mt":40,"marcos":41,"mar":41,"mc":41,"mr":41,
    "lucas":42,"luc":42,"lc":42,"juan":43,"jn":43,"jua":43,
    "hechos":44,"hech":44,"hch":44,"act":44,
    "romanos":45,"rom":45,"1corintios":46,"1 corintios":46,"1cor":46,"1co":46,
    "2corintios":47,"2 corintios":47,"2cor":47,"2co":47,
    "galatas":48,"gálatas":48,"gal":48,"gál":48,
    "efesios":49,"ef":49,"efe":49,"filipenses":50,"fil":50,"flp":50,
    "colosenses":51,"col":51,"1tesalonicenses":52,"1 tesalonicenses":52,"1tes":52,"1ts":52,
    "2tesalonicenses":53,"2 tesalonicenses":53,"2tes":53,"2ts":53,
    "1timoteo":54,"1 timoteo":54,"1tim":54,"1ti":54,
    "2timoteo":55,"2 timoteo":55,"2tim":55,"2ti":55,
    "tito":56,"tit":56,"filemon":57,"filemón":57,"flm":57,"phm":57,
    "hebreos":58,"heb":58,"santiago":59,"sant":59,"stg":59,
    "1pedro":60,"1 pedro":60,"1pe":60,"2pedro":61,"2 pedro":61,"2pe":61,
    "1juan":62,"1 juan":62,"1jn":62,"2juan":63,"2 juan":63,"2jn":63,
    "3juan":64,"3 juan":64,"3jn":64,"judas":65,"jud":65,"apocalipsis":66,"apoc":66,"ap":66,
}

def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)

def normalize(s):
    import unicodedata
    return unicodedata.normalize("NFD", s).encode("ascii","ignore").decode().lower()

def parse_ref(s):
    """Acepta 'GEN 1 1', 'Juan 3 16', 'Sal 23 1', '1 Corintios 13 4', etc."""
    parts = s.strip().split()
    if len(parts) < 3:
        return None

    # Intenta leer un prefijo numérico de libro (1 Juan, 2 Reyes, etc.)
    chap, vers = None, None
    book_id = None

    for split in range(len(parts) - 2, 0, -1):
        book_str  = " ".join(parts[:split])
        remainder = parts[split:]
        if len(remainder) < 2:
            continue
        try:
            chap = int(remainder[0])
            vers = int(remainder[1])
        except ValueError:
            continue

        # Busca primero en español, luego en inglés
        key_es = normalize(book_str)
        bid = SPANISH.get(key_es) or SPANISH.get(book_str.lower())
        if not bid:
            bid = ABBR.get(book_str.upper())
        if bid:
            book_id = bid
            break

    if book_id and chap and vers:
        return book_id, chap, vers
    return None

def main():
    if len(sys.argv) < 2:
        print("Uso: python3 consultar_refs.py \"GEN 1 1\"")
        sys.exit(1)

    src = parse_ref(" ".join(sys.argv[1:]))
    if not src:
        print(f"No se reconoció la referencia: {' '.join(sys.argv[1:])}")
        print(f"Abreviaciones válidas: {', '.join(sorted(ABBR))}")
        sys.exit(1)

    bid, chap, vers = src

    xref  = load(os.path.join(DIR, "cross-references.json"))
    bible = load(os.path.join(DIR, "bible-nbv.json"))
    books = {b["id"]: b for b in bible}

    src_book = books.get(bid)
    src_name = f"{src_book['name']} {chap}:{vers}" if src_book else f"Libro {bid} {chap}:{vers}"

    key  = f"{bid}_{chap}_{vers}"
    refs = xref.get(key)

    if not refs:
        print(f"\n{src_name} — sin referencias cruzadas.")
        sys.exit(0)

    print(f"\n{src_name} — {len(refs)} referencias cruzadas:\n")
    print("─" * 70)

    for i, (rbid, rchap, rvers) in enumerate(refs, 1):
        b = books.get(rbid)
        if not b:
            continue
        chapd = next((c for c in b["chapters"] if c["n"] == rchap), None)
        if not chapd:
            continue
        v = next((v for v in chapd["v"] if str(v["n"]) == str(rvers)), None)
        text = v["t"] if v else "(versículo no encontrado)"
        ref_str = f"{b['name']} {rchap}:{rvers}"
        print(f"{i:>3}. {ref_str}")
        print(f"     {text}")
        print()

if __name__ == "__main__":
    main()
