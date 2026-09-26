# Arturia MiniLab 3 — measured profile

Recorded from a real unit over USB on Windows 11 + Chrome (Web MIDI), 2026-09-26.
3833 messages, factory preset, no DAW running. Numbers below are what the device actually sent.

## Ports

| Web MIDI input | Traffic seen | ECHOES |
|---|---|---|
| `Minilab3 MIDI` | **everything** (keys, pads, encoders, strips, buttons) | listened |
| `Minilab3 DIN THRU` | nothing | listened (harmless) |
| `Minilab3 MCU/HUI` | nothing in this mode; DAW-mode Mackie traffic | skipped in "All inputs" |
| `Minilab3 ALV` | nothing in this mode; Analog Lab traffic | skipped in "All inputs" |

No message was duplicated across ports.

## Controls (all on MIDI channel 1 unless noted)

| Control | Message | Range / behaviour |
|---|---|---|
| Keys (25) | Note On/Off, ch 1 | notes 48–72 at default octave (C3–C5). Velocity seen 1–104; firm playing ≈ 85–100, rarely above 105 |
| Octave − / + | no MIDI | transposes the key notes by ±12 |
| Encoders 1–8 | CC **74, 71, 76, 77, 93, 18, 19, 16** | see "Encoder mode" |
| Second encoder layer | CC 86, 87, 89 (observed) | same behaviour as encoders; not mapped |
| Faders 1–4 | CC **82, 83, 85, 17** | absolute 0–127, 3–10 per message, no repeats |
| Pads 1–8 | Note On/Off, **ch 10**, notes **36–43** | velocity low: 9–37 on real hits |
| Pad pressure | Poly Aftertouch, ch 10 | rises to 127 within ~50 ms of a press, returns to 0 |
| Pitch strip | Pitch Bend, ch 1 | 0–16383, springs back to 8192 |
| Mod strip | CC **1** | 0–127, stays where released |
| Main encoder (turn) | CC **114** | relative: 64 ± 1–3 per tick, then 64 again (64,65,64,65…) |
| Main encoder (push) | CC **115** | 127 / 0 |
| Other buttons | CC 9, 105, 106, 27 | 127 / 0 momentary |
| Channel aftertouch (keys) | not sent | — |
| Sustain | no pedal connected during the test | CC 64 works if one is attached |

## Encoder mode

The encoders are endless, but they transmit an **absolute counter** 0–127:

- built-in acceleration: step 1 when very slow, **step 2** for normal turning;
- 7–20 ms between messages while turning;
- at an end stop they keep transmitting the same value (`127, 127, 127…` / `0, 0, 0…`) for every detent;
- values never repeat mid-range.

ECHOES therefore uses **delta mode** for them: only the change is applied (±1/127 or ±2/127
per message), and a repeated 0/127 counts as a further ±2. Parameters never jump when the knob's
internal counter disagrees with the on-screen value, and a knob never "runs out" at 0 or 127.
MIDI Learn classifies these encoders the same way (see `detectMode` in `src/input/MidiLearn.ts`).

## Default mapping in ECHOES

| Encoder | CC | Macro |
|---|---|---|
| 1 | 74 | WORLD |
| 2 | 71 | WEATHER |
| 3 | 76 | ENERGY |
| 4 | 77 | SPACE |
| 5 | 93 | TEXTURE |
| 6 | 18 | MOTION |
| 7 | 19 | COLOR |
| 8 | 16 | CHAOS |

| Fader | CC | Mix level |
|---|---|---|
| 1 | 82 | ATMOSPHERE — wind, surf, rain, rumble, drips and the world's own echoes (0 = silent bed) |
| 2 | 83 | RAIN — rain on the water, drizzle, rain hiss and drips, on any sky |
| 3 | 85 | FOG — sea fog and horizon haze (0 = crystal-clear air) |
| 4 | 17 | DRONE — level of the root/fifth drone |

| Control | Function |
|---|---|
| Main encoder push (CC 115) | HOLD — latching sustain: play, press, everything keeps ringing |
| Main encoder turn (CC 114) | master volume |
| Mod strip (CC 1) | expression: shimmer on the water, brighter harmonics and air on held notes, brighter bell, wind and mist lift, gentle vibrato |
| Pitch strip | pitch bend ±2 semitones (springs back) |
| Pads 1–4 | swell · shimmer · bloom · wave (a big wave rolling in: deep notes, the wash of the wave, a long ring and a gust) |
| Pads 5–8 | the same, an octave higher |

Applied automatically when a port named "MiniLab 3" / "Minilab3" appears and the user has not
learned their own layout. Faders are absolute (a fader jumps to where it physically sits, gliding
over 0.12 s). Pad pressure is ignored.
