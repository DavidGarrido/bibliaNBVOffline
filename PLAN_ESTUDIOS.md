# Plan: Funcionalidad de Estudios Bíblicos

## Objetivo
Permitir al usuario guardar citas bíblicas y notas organizadas por estudios.
Siempre existe un estudio **General** por defecto. El estudio activo se selecciona
desde un desplegable en la barra del lector.

---

## UX: Flujo general

```
[📓 botón en reader-nav]
        ↓ click
  ┌─────────────────────┐
  │  General ›          │  ← nombre estudio activo, click → abre sheet del estudio
  │─────────────────────│
  │  📝 Nueva nota      │
  │  ➕ Nuevo estudio   │
  │─────────────────────│
  │  ✓ General          │  ← activo marcado con ✓
  │    Sermón 1         │
  │    Estudio Romanos  │
  │─────────────────────│
  │  ⚙️ Configuración   │  ← sección fija al fondo
  │  📄 Modo: Páginas   │  ← toggle paged ↔ continuo (reemplaza #mode-btn del nav)
  └─────────────────────┘
```

- Click en un estudio del listado → abre el **modal timeline** del estudio (NO lo activa aún)
- Click en el header (nombre activo ›) → abre el modal timeline del estudio activo
- El botón `#mode-btn` del reader-nav se **elimina** y su funcionalidad pasa al dropdown
- Click fuera del dropdown → cierra

---

## UX: Modal Timeline de Estudio

Al hacer click en un estudio (desde el dropdown o al entrar a la app):

```
┌──────────────────────────────┐
│  📓 Sermón 1           [✕]  │
│──────────────────────────────│
│  · Juan 3:16                 │  ← cita bíblica
│    "Porque de tal manera..." │  ← texto del versículo
│    nota: reflexión sobre...  │  ← nota (si tiene)
│                              │
│  · Nota libre                │  ← entrada tipo note
│    "Recordar comparar con..."│
│                              │
│  [Continuar en este estudio] │  ← botón primario, activa el estudio
│  [Cancelar]                  │  ← solo cierra el modal sin cambiar
└──────────────────────────────┘
```

- Si el estudio ya es el activo, solo muestra "Continuar" (sin "Cancelar")
- Si el estudio está vacío, muestra mensaje "Aún no hay entradas en este estudio"
- Botón "Continuar en este estudio" → activa el estudio + cierra modal + toast

---

## UX: Alerta al entrar a la app

Al arrancar la app (en `init()`), si hay un `activeStudyId` distinto de `general`:

```
┌──────────────────────────────┐
│  📓 Estudio activo           │
│  Tienes activo:              │
│  "Sermón 1"                  │
│                              │
│  [Continuar en este estudio] │
│  [Cambiar a General]         │
└──────────────────────────────┘
```

- Se muestra el modal timeline del estudio activo con las entradas guardadas
- "Continuar en este estudio" → cierra y sigue normalmente
- "Cambiar a General" → setea General como activo y cierra

---

## Estructura de datos — localStorage key: `bible-studies`

```json
{
  "activeStudyId": "general",
  "studies": [
    {
      "id": "general",
      "name": "General",
      "createdAt": "2026-03-15T00:00:00.000Z",
      "entries": [
        {
          "id": "entry_1710460800000",
          "type": "verse",
          "ref": "Juan 3:16",
          "bookId": 43,
          "chapN": 3,
          "verseN": 16,
          "text": "Porque de tal manera amó Dios...",
          "translationId": "nbv",
          "note": "",
          "savedAt": "2026-03-15T10:00:00.000Z"
        },
        {
          "id": "entry_1710460900000",
          "type": "note",
          "text": "Reflexión sobre la gracia",
          "note": "",
          "savedAt": "2026-03-15T10:05:00.000Z"
        }
      ]
    }
  ]
}
```

- `type: "verse"` — cita bíblica (requiere bookId, chapN, verseN, text)
- `type: "note"` — nota libre (solo texto)
- El estudio `general` no puede borrarse ni renombrarse
- `activeStudyId` puede ser null → equivale a "general"

---

## Componentes UI

### 1. Botón en reader-nav
- Elemento: `<button id="studies-btn" class="icon-btn">📓</button>`
- Posición: entre `#mode-btn` y `#home-btn`
- Muestra un punto azul si hay un estudio activo distinto de General

### 2. Dropdown (desplegable)
- Elemento: `<div id="studies-dropdown" class="sd-hidden">`
- Posición: `absolute`, anclado debajo del botón `#studies-btn`
- Se cierra al hacer click fuera o al seleccionar una opción
- Estructura:
  ```html
  <div id="studies-dropdown">
    <div id="sd-header">         ← nombre estudio activo, click → abre sheet del estudio
    <div class="sd-divider">
    <button id="sd-new-note">📝 Nueva nota
    <button id="sd-new-study">➕ Nuevo estudio
    <div class="sd-divider">
    <ul id="sd-studies-list">    ← un <li> por estudio
  </div>
  ```

### 3. Bottom sheet de estudio (vista de entradas)
- Elemento: `<div id="study-sheet" class="ss-hidden">`
- Mismo patrón visual que `#verse-compare`
- Muestra: nombre del estudio, lista de entradas, botón eliminar estudio (si no es General)
- Cada entrada: referencia en azul (si es verse), texto, nota, botón 🗑

### 4. Bottom sheet "Nueva nota / Guardar versículo"
- Elemento: `<div id="note-sheet" class="ns-hidden">`
- Se abre desde:
  a. `📝 Nueva nota` del dropdown (nota libre o versículo seleccionado)
  b. `🔖 Guardar` en `#verse-actions` (si hay versículo seleccionado)
- Contenido:
  - Referencia del versículo (si hay uno) en readonly
  - Texto del versículo (readonly, si aplica)
  - `<textarea>` para nota opcional
  - Botón "Guardar"

### 5. Toast de confirmación
- `<div id="save-toast">` — aparece 2 seg tras guardar

### 6. Botón en verse-actions
- `<button id="va-save" class="va-btn">🔖 Guardar</button>`
- Agrega el versículo seleccionado al estudio activo

---

## Funciones JS

### Capa de datos
| Función | Descripción |
|---|---|
| `studiesLoad()` | Lee localStorage, inicializa si no existe |
| `studiesSave(state)` | Escribe en localStorage |
| `studiesGetActive(state)` | Retorna el objeto del estudio activo |
| `studiesCreate(state, name)` | Crea nuevo estudio, retorna nuevo state |
| `studiesSetActive(state, id)` | Cambia el activo, retorna nuevo state |
| `studiesAddEntry(state, studyId, entry)` | Agrega entrada, retorna nuevo state |
| `studiesDeleteEntry(state, studyId, entryId)` | Elimina entrada, retorna nuevo state |
| `studiesDeleteStudy(state, studyId)` | Elimina estudio (no General), retorna nuevo state |

### UI
| Función | Descripción |
|---|---|
| `studiesInit()` | Llama al final de init(), asigna todos los listeners |
| `toggleStudiesDropdown()` | Abre/cierra el dropdown |
| `renderStudiesDropdown()` | Reconstruye la lista de estudios en el dropdown |
| `openStudySheet(studyId)` | Muestra el sheet con las entradas del estudio |
| `renderStudyEntries(studyId)` | Reconstruye la lista de entradas |
| `openNoteSheet(verseData?)` | Abre el sheet de nueva nota/guardar versículo |
| `handleSaveVerse()` | Desde #va-save: guarda versículo seleccionado en estudio activo |
| `showSaveToast(msg)` | Muestra el toast 2 seg |

---

## Archivos a modificar

| Archivo | Cambios |
|---|---|
| `index.html` | Eliminar bloque duplicado (líneas 95-113), agregar: botón `#studies-btn`, dropdown `#studies-dropdown`, sheet `#study-sheet`, sheet `#note-sheet`, toast `#save-toast`, botón `#va-save` |
| `style.css` | Agregar estilos al final: dropdown, sheets, toast, verse-selected indicator |
| `app.js` | Agregar bloque de estudios al final del archivo |

---

## Orden de implementación

1. `index.html` — limpiar duplicado + agregar HTML
2. `style.css` — agregar estilos
3. `app.js` — agregar funciones de datos → UI → listeners

---

## Notas técnicas

- El estudio activo se muestra con `✓` en el dropdown
- Al cambiar de estudio, aparece toast: _"Estudio activo: [nombre]"_
- El punto azul en `#studies-btn` se activa cuando `activeStudyId !== 'general'`
- `window.confirm` para confirmar eliminación de estudio o entrada
- Sin librerías externas, todo vanilla JS
