#!/usr/bin/env python3
"""
Descarga los 32 archivos JSON de bible-cross-reference-json
y los une en cross-references.json con formato compacto:
{ "bookId_chap_vers": [[bookId,chap,vers], ...], ... }
"""
import urllib.request
import json
import os

BASE_URL = "https://raw.githubusercontent.com/josephilipraja/bible-cross-reference-json/master/{}.json"
OUT_FILE = os.path.join(os.path.dirname(__file__), "cross-references.json")

# Mapeo de abreviaciones (fuente) → ID de libro 1-66
ABBR = {
    "GEN":1,"EXO":2,"LEV":3,"NUM":4,"DEU":5,"JOS":6,"JDG":7,"RUT":8,
    "1SA":9,"2SA":10,"1KI":11,"2KI":12,"1CH":13,"2CH":14,"EZR":15,
    "NEH":16,"EST":17,"JOB":18,"PSA":19,"PRO":20,"ECC":21,"SNG":22,
    "ISA":23,"JER":24,"LAM":25,"EZK":26,"EZE":26,"DAN":27,"HOS":28,
    "JOE":29,"JOL":29,"AMO":30,"OBA":31,"JON":32,"MIC":33,"NAH":34,
    "HAB":35,"ZEP":36,"HAG":37,"ZEC":38,"MAL":39,"MAT":40,"MRK":41,
    "MAR":41,"LUK":42,"JOH":43,"ACT":44,"ROM":45,"1CO":46,"2CO":47,
    "GAL":48,"EPH":49,"PHP":50,"PHI":50,"COL":51,"1TH":52,"2TH":53,
    "1TI":54,"2TI":55,"TIT":56,"PHM":57,"HEB":58,"JAS":59,"JAM":59,
    "1PE":60,"2PE":61,"1JO":62,"2JO":63,"3JO":64,"JUD":65,"JDE":65,
    "REV":66,"SOS":22,
}

def parse_ref(s):
    """"GEN 1 1" → [1, 1, 1] o None"""
    parts = s.strip().split()
    if len(parts) != 3:
        return None
    bid = ABBR.get(parts[0].upper())
    if not bid:
        return None
    try:
        return [bid, int(parts[1]), int(parts[2])]
    except ValueError:
        return None

merged = {}
unknown_abbrs = set()

for i in range(1, 33):
    url = BASE_URL.format(i)
    print(f"Descargando {i}/32...", end=" ", flush=True)
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            data = json.loads(resp.read().decode())
        ok = 0
        for entry in data.values():
            if not isinstance(entry, dict):
                continue
            v = entry.get("v")
            r = entry.get("r")
            if not v or not r:
                continue
            src = parse_ref(v)
            if not src:
                unknown_abbrs.add(v.split()[0] if v else "?")
                continue
            if isinstance(r, dict):
                raw_refs = list(r.values())
            elif isinstance(r, list):
                raw_refs = r
            else:
                continue
            refs = []
            for ref_str in raw_refs:
                parsed = parse_ref(ref_str)
                if parsed:
                    refs.append(parsed)
                else:
                    unknown_abbrs.add(ref_str.split()[0] if ref_str else "?")
            if refs:
                key = f"{src[0]}_{src[1]}_{src[2]}"
                merged[key] = refs
                ok += 1
        print(f"OK ({ok} versículos)")
    except Exception as e:
        print(f"ERROR: {e}")

if unknown_abbrs:
    print(f"\nAbreviaciones no reconocidas: {sorted(unknown_abbrs)}")

print(f"\nTotal versículos con referencias: {len(merged)}")

with open(OUT_FILE, "w", encoding="utf-8") as f:
    json.dump(merged, f, separators=(",", ":"), ensure_ascii=False)

size_kb = os.path.getsize(OUT_FILE) / 1024
print(f"Guardado en cross-references.json ({size_kb:.0f} KB)")
