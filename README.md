# ECHOES — an audiovisual world you can play

### ▶ [Play ECHOES](https://badplast.github.io/Echoes/)

**Alpha.** Open it in **Chrome or Edge** (recommended — they support Web MIDI). A MIDI controller is optional: the computer keyboard works too (`A S D F G H J K L`, `Z`/`X` octave, `Space` sustain). Headphones recommended.

**World 01 — TIDE.** Тёмная вода, свет, туман и генеративный ambient. Ноты, velocity, пэды и энкодеры одновременно меняют звук и мир.

## Запуск

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production → dist/
npm run preview    # проверить dist на http://localhost:4173
```

## Миры

- **World 01 — TIDE** — вода, свет, туман; бухта Пластун.
- **World 02 — FIBA** — комната-сон: серое кресло и спящая на нём кошка Фиба (процедурная SDF-скульптура). Она дышит, шевелит ушами и хвостом, иногда просыпается и потягивается (голова → плечи и передние лапы → прогиб → вытянутая спина → возврат); сильная игра может её разбудить, тихая — нет. Ноты оставляют в воздухе сновидческие следы, сама Фиба никогда не светится: низкие — большие тёплые облака света, средние — огоньки, лепестки и кольца-ореолы, высокие — искры и блики; аккорды иногда открывают редкие события (созвездие, большой ореол, спираль лепестков). Вокруг — слои тумана, тонкие световые нити, далёкие огни и пыль.

Мир выбирается на заставке или в панели (раздел *Place*).

| FIBA | Что делает |
|---|---|
| Энкодеры 1–8 | Hour (ночь → первый свет) · Mist (туман сна) · Restless (крепкий сон → беспокойная) · Distance (крупный план → широкий кадр) · Sparkle (мягкие шары → блёстки) · Float (скорость парения) · Palette (Moon Linen → Amber Night) · Wonder (разброс, падающие огоньки) |
| Фейдеры 1–4 | Lullaby (музыкальная шкатулка играет сама) · Dust (пылинки) · Moonbeam (лунный луч) · Purr (мурчание) |
| Пэды 1–8 | swell · stardust · purr · wake · bloom · pulse · stretch · lift |

## Quick Launch (Windows)

После установки (`npm install`) ECHOES запускается ярлыком **ECHOES** на рабочем столе: он сам поднимет сервер в фоне (или использует уже запущенный) и откроет сайт в Chrome. Ярлык указывает на `launcher\ECHOES.vbs`.

Остановить сервер: дважды кликнуть `launcher\Stop ECHOES.vbs`. Логи лаунчера лежат в `%LOCALAPPDATA%\ECHOES`.

`dist/` — статический сайт (`base: './'`), его можно выложить на любой статический хостинг. Для Web MIDI нужен Chrome или Edge и `localhost`/HTTPS.

## Управление

| Ввод | Действие |
|---|---|
| `A W S E D F T G Y H U J K O L P ; '` | ноты (как клавиши пианино; работает при любой раскладке) |
| `Shift` + нота | акцент (громче) |
| `Z` / `X` | октава вниз / вверх |
| `Space` | sustain |
| `1`–`8`, затем `↑` `↓` | выбрать макропараметр и крутить его |
| клик / перетаскивание по воде | ноты мышью (X → высота, Y → сила) |
| `Enter` | HOLD — всё продолжает звучать, пока не нажмёте снова |
| `Tab` | панель управления |
| `` ` `` | MIDI-монитор |
| `Esc` | закрыть панель |

MIDI: Note On/Off + velocity, CC (через MIDI Learn), CC64 sustain, CC1 выразительность (mod), pitch bend, channel aftertouch, пэды на канале 10 (swell · shimmer · bloom · wave).

**Arturia MiniLab 3** подхватывается автоматически: энкодеры 1–8 → WORLD … CHAOS (бесконечный режим, без прыжков), фейдеры 1–4 → Atmosphere · Rain · Fog · Drone, главный энкодер: нажатие — HOLD, вращение — громкость, mod-полоса — выразительность (мерцание воды, яркость гармоник, ветер). Реально измеренный профиль контроллера — [docs/MINILAB3.md](docs/MINILAB3.md).

**MIDI Learn:** в панели нажать `LEARN` возле параметра → покрутить энкодер. Относительные энкодеры распознаются автоматически. Правый клик по `LEARN` — снять привязку.

## Архитектура

```
Input (MIDI / клавиатура / мышь) ─► InputRouter ─► bus: note:on/off, pad, expression, sustain
                                        │ (scale lock, MIDI Learn)          │
Knobs / sliders ─► ParameterStore ──────┴──────► AudioEngine (Tone.js) + World (Three.js)
                   (8 макро 0..1)          core/derive.ts — общие производные (время эха, тепло палитры…)
Generator — «эхо» мира: отвечает на сыгранное через ту же шину
```

```
src/
  App.ts                 связывает сервисы, цикл рендера, адаптивный DPR
  core/                  EventBus, events, ParameterStore, scales, derive, Generator, storage
  input/                 MidiManager, MidiLearn, InputRouter
  audio/                 AudioEngine (фасад, ленивый импорт), ToneEngine (граф звука)
  worlds/World.ts        контракт мира
  worlds/tide/           TideWorld, палитры, процедурный шум, GLSL-шейдеры
  ui/                    интро, HUD, панель, MIDI-монитор
```

Новый мир = новый класс, реализующий `World`; MIDI, аудио и параметры не меняются.
