# Wall Painter

A small desktop app (Tauri 2) to try paint colours on the walls in your room photos.
Open a folder of photos, click a wall, pick a colour — light, shadows and texture from the photo are kept,
so it looks like the wall was actually painted.

## Run it (macOS)

One-time setup:

```bash
xcode-select --install                                           # if you don't have the Xcode command line tools
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh     # Rust
# Node 18+ is also needed (e.g. `brew install node`)
```

Then, in this folder:

```bash
npm install
npm run dev      # starts the app (first build takes a few minutes)
npm run build    # makes a real app: src-tauri/target/release/bundle/macos/Wall Painter.app
```

## How to use it

1. **Open folder…** (⌘O) and pick any folder with photos (JPG, PNG, WebP, BMP, GIF). They appear in the strip at the
   bottom; click a thumbnail or use ← → to switch. Next time the app reopens that folder at the photo you used last.
2. **Wand (W)** — click a wall. Click more spots to add to it (a wall that gets much darker toward a corner may need 2–3 clicks).
   ⌥-click removes. If it spills into something (e.g. a white ceiling against a white wall), lower *Colour tolerance*
   or *Stop at edges*, or cut it off with the lasso.
3. **Lasso (L)** — click around corners; click the first point / double-click / Enter to close. Hold ⌥ (or switch the
   rail to **−**) to subtract. Ideal for cutting off ceilings and trim with straight lines.
4. **Brush (B) / Eraser (E)** — touch up by hand. `[` and `]` change the size.
5. Pick a colour from the swatches, the colour picker, or type a hex code (e.g. from a paint brand's website).
   *Brightness* nudges the result lighter/darker, *Opacity* blends with the original. If the wall isn't white now,
   set *This wall is painted now* to its current colour — or use the **Other colour (M)** tool / *Match photo* to have it
   measured from the photo, so differently painted walls come out the same.
6. **+ New wall** to give another wall (or the ceiling) its own colour.
7. Hold **C** (or the *Hold: before* button) to compare with the original. **Export…** saves a PNG/JPEG;
   **Before/after…** saves both side by side.

Navigation: two-finger scroll pans (the photo can't scroll off screen), pinch or ⌘-scroll zooms, Space+drag pans, **F** fits the photo.

On Windows and Linux the same shortcuts use **Ctrl** instead of ⌘ and **Alt** instead of ⌥ (Ctrl+O, Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y, Ctrl+S, Alt-click, Ctrl-scroll); the app shows them that way there.

## Projects: your work is saved in the photo folder

Everything you do — walls, colours, selections, for every photo — is saved automatically in **`wall-painter.json`**
inside the folder you opened. A dot on a thumbnail means that photo has painted walls.

- A folder without that file simply starts fresh; the file is created the first time you paint something.
- Photos are matched by file name, so you can move, back up, zip or share the whole folder and it opens exactly as you
  left it. New photos added to the folder show up next time you open it.
- Work saved by older versions of the app (per photo, in the app's data folder) is copied into the project file
  automatically the first time you open that photo.

## How the recolouring works

A photo shows *wall colour × light*. The app swaps the wall colour and keeps the light, per pixel in linear light:
`new = photo pixel × new paint / current wall colour`. Shadows, light falloff and the warm or cool colour of the
lighting in each photo carry over to the new paint, as they would in reality.

That's why each wall has a **"This wall is painted now"** setting (at the bottom of the Colour panel): it defaults to
white. For a wall that is already coloured (e.g. taupe), pick the closest match, or new colours will come out too dark.

## Project layout

```
src/            the UI (plain HTML/CSS/JS, no build step)
  main.js       selection tools, recolouring, projects, export
  analyze.js    photo analysis for the magic wand (runs in a worker)
src-tauri/      the Rust side: folder/file reading and writing, dialogs
```
