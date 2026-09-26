# ECHOES — an audiovisual world you can play

**World 01 — TIDE.** Тёмная вода, свет, туман и генеративный ambient. Ноты, velocity, пэды и энкодеры одновременно меняют звук и мир.

## Запуск

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production → dist/
npm run preview    # проверить dist на http://localhost:4173
```

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
| `Tab` | панель управления |
| `` ` `` | MIDI-монитор |
| `Esc` | закрыть панель |

MIDI: Note On/Off + velocity, CC (через MIDI Learn), CC64 sustain, CC1 vibrato, pitch bend, aftertouch (channel/poly), пэды на канале 10 (swell · shimmer · bloom · gust).

**Arturia MiniLab 3** подхватывается автоматически: энкодеры 1–8 → WORLD … CHAOS (бесконечный режим, без прыжков). Реально измеренный профиль контроллера — [docs/MINILAB3.md](docs/MINILAB3.md).

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
