# osu! Cut Editor

[简体中文](README.zh-CN.md) · English

A Windows desktop editor that removes a selected time interval from an osu! beatmap and its audio together, then exports an independent copy.

**Current version: 1.0.0 · Windows x64 · Portable executable**

The application interface is currently in Simplified Chinese. English and Chinese documentation describe the same features.

## Download

Download `osu-cut-editor-1.0.0.exe` from [Release v1.0.0](https://github.com/reisen0327-sudo/osu-cut-editor/releases/tag/v1.0.0) and run it directly. No installer or Node.js installation is required to use the portable build.

This repository and its releases are currently private; downloads require repository access.

## Quick start

1. Import one or more `.osu` files, a beatmap folder, or an `.osz` archive.
2. Select a difficulty from the list, then play or seek to the part you want to edit.
3. Set the start and end in **Cut 区间**. Enter either milliseconds or a game timestamp; the other field updates automatically. For example, `00:02.500`–`00:05.500` equals `2500`–`5500 ms`.
4. Click **执行 Cut** to remove that interval, then preview the result. Use **撤销**, **重做**, or **恢复原始** to undo, redo, or restore the original loaded content.
5. Choose **导出独立副本** to export a folder, or **导出 .osz** to export an archive.

The `sample/` directory contains small synthetic standard and 4K mania maps with generated audio for trying this workflow.

## Features

### Preview and navigation

- **osu!mania:** editor-style columns, silver/pink long notes (LN), thin heads and tails, beat lines, and a time ruler. Column count follows `CircleSize` from 1 to 18.
- Dense LN heads and tails adapt to nearby timestamps; bodies render before heads and tails to avoid artificial drawing overlap.
- A continuous **0.50×–8.00×** scroll-speed slider with **0.01×** steps. It changes visual spacing and scrolling only; audio playback and beatmap timestamps stay unchanged.
- **osu!standard:** a reference playfield for circles, sliders, spinners, and the beatmap background.
- A timeline with measure, beat, and subdivision markers. Drag to select an interval, use the wheel to move between subdivisions, or anchor the current beat as a cut endpoint.
- Linked timestamp and millisecond inputs. Both `00:49.809` and the clipboard form `00:49:809` convert to `49809 ms`. Fractional milliseconds are preserved.
- Audio playback, pause, seeking, and a live playhead.

### Cut behavior

**Cut removes the selected interval; it does not keep only that interval.**

- The interval is **[start, end)**: start is included and end is excluded.
- Circles inside the interval are removed. Any slider, spinner, or hold intersecting it is removed as a whole. A long object ending exactly at the cut start is retained.
- Later objects, timing points, and breaks move earlier by the cut duration. Active BPM, slider velocity (SV), volume, and sample settings are restored at the seam when needed.
- Preview time and editor bookmarks are adjusted. Bookmarks inside the removed interval are deleted; breaks crossing the seam retain their remaining duration.
- Audio is cut at sample boundaries and encoded as **16-bit PCM WAV**. The duration error per cut is less than one audio sample period.
- `Title` and `TitleUnicode` receive ` (Cut. Ver)` once.
- Beatmap and audio changes are committed together only after processing succeeds. The editor supports 10 undo/redo steps and restoring the originally loaded content.
- Invalid timestamps, missing audio, whole-audio deletion, out-of-range cuts, and cuts shorter than one sample are rejected.

### Export and import safeguards

- Each folder export uses a unique output directory. Source files and previous exports are preserved.
- For an `.osu` import, the output folder is created inside its source folder. For an `.osz` import, it is created beside the original archive.
- Archive export refuses to overwrite an existing file.
- Backgrounds, custom samples, and nested resources are copied. Original beatmaps, the original main audio, and existing `.osz` files are excluded; generated audio names avoid resource collisions.
- Video, external `.osb` files, embedded storyboard events, and storyboard variables are removed from the exported copy.
- Exported maps use `BeatmapID:0` and `BeatmapSetID:-1`. Missing source backgrounds produce a warning.
- Archive import supports nested maps and rejects path traversal, Windows-invalid names, case-insensitive duplicates, file/directory conflicts, and corrupt data.
- Import limits: **512 MiB** per archive and per extracted file, **1 GiB** total extracted data, and **10,000** entries.
- Failed imports clean up their temporary extraction directory and preserve the current edit. Normal application exit cleans up extraction directories created during that session.

## Development

Validated on Windows with Node.js **24.18.0**, pnpm **11.22.0**, Electron **44.7.2**, and electron-builder **26.15.3**. The project pins pnpm through `packageManager` and includes `pnpm-lock.yaml`.

```powershell
pnpm install --frozen-lockfile
pnpm start

# Build the Windows x64 portable executable
pnpm dist
# Output: dist/osu-cut-editor-1.0.0.exe
```

The first setup/build may download Electron and packaging tools. `ELECTRON_MIRROR` and `ELECTRON_BUILDER_BINARIES_MIRROR` can be configured for a suitable download mirror.

The bundled icons are ready to use. Regenerating them with `scripts/make-icon.py` requires Python and Pillow.

## Tests

Once dependencies are installed, the tests can run without network access:

```powershell
npm test
npm run test:electron

# After building: test the main process, renderer, and dependencies inside app.asar
node scripts/run-electron-check.cjs --packaged

# Save screenshots of dense 4K/7K LN maps, window sizes, and scroll speeds
node scripts/run-electron-check.cjs --screenshots
```

`--packaged` requires `dist/win-unpacked/`; run `pnpm dist` again if build intermediates have been cleaned up. Screenshots are written to `build/verification-<version>/`.

The **1.0.0** build passed **38 core regression tests** and **25 Electron integration checks**, with the integration checks run against both source and packaged code. Coverage includes cut boundaries, BPM/SV restoration, audio failure handling, undo/redo, real file exports, archive import safeguards, timestamp conversion, and Mania layout.

Integration tests use a hidden window, muted audio, and project-local `.test-tmp/` files. Successful runs remove their temporary files; failed runs retain diagnostics. If Chromium cannot start in a restricted Windows test environment, `OSU_CUT_TEST_NO_SANDBOX=1` is a test-only opt-in; it does not change normal application startup.

## Project layout

| Path | Purpose |
| --- | --- |
| `main.js` | Electron window, file dialogs, and import/export IPC |
| `renderer/` | Interface, playfield, timeline, and audio playback |
| `shared/osuParser.js` | Beatmap parsing and serialization |
| `shared/cutEngine.js` | Object, timing, break, and metadata adjustments |
| `shared/editSession.js` | Prepare beatmap and audio changes before committing state |
| `shared/exportEngine.js` | Independent exports, resource copying, and overwrite protection |
| `shared/osz.js` | Archive handling and temporary import lifecycle |
| `shared/maniaLayout.js` | Mania time mapping, clipping, and dense-note layout |
| `shared/timeFormat.js` | Timestamp parsing and conversion |
| `shared/snapEngine.js` | Beat subdivisions and navigation |
| `shared/wav.js` | WAV encoding |
| `tests/`, `scripts/` | Regression tests, integration runner, and icon generation |
| `sample/`, `build/` | Synthetic sample maps/audio and build artwork |

## Known limitations

- Arbitrary cuts can create an audible discontinuity. Restored red timing points use the seam as their beat origin; this is not a crossfade or musical transition editor.
- Archive extraction, resource copying, and compression are synchronous. Large files may temporarily block the interface, and long audio plus undo history can use substantial memory. Very large files have not been stress-tested.
- Force-quitting or a system crash can leave temporary extraction directories behind. Automatic cleanup is limited to directories created in the current session.
- Standard and mania workflows have been tested. Taiko, catch, and actual import/play in the osu! client have not received dedicated validation.
- The standard playfield is a reference visualization, not a complete reproduction of the game's rendering.

## Credits

This is an unofficial tool and is not affiliated with the osu! team. osu! names and artwork belong to their respective owners. Legacy images in `renderer/skin/` originate from the Wilben_Chan v2 skin; the current Mania preview is drawn procedurally.
