# Equation Editor

Turns ` ```mathlive ` fenced code blocks into live [MathLive](https://cortexjs.io/mathlive/)
equation editors, right inside a note — in both Reading mode and Live Preview.

MathLive already implements a full math editor with its own commands and keybindings; this
plugin's only job is to make that work correctly inside Obsidian.

## Usage

Run the **Insert equation** command (or **Insert left-aligned equation**) to drop an empty
block below the cursor:

````markdown
```mathlive
x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}
```
````

The block renders as an editable equation widget. Click into it, or arrow into it from an
adjacent line, and edit it like any MathLive field — its own keybindings
(`Ctrl+E`, `Ctrl+P`, `Ctrl+F`, `Ctrl+B`, `_`/`^`, `\frac` + Tab, etc.) all work.

- `mathlive` blocks are centred by default (configurable in settings).
- `mathlive-left` blocks always align left, regardless of that setting.
- Edits are written back to the note's markdown automatically when you leave the field.

### Navigating in and out

- **Arrow Up / Down** from an adjacent line moves the cursor into the field.
- **Arrow Left / Right** on the block's fence lines collapses it back to raw source, like
  any other code block.
- **Any arrow key, or Tab,** from inside the field exits back into the note once the caret
  is at a dead end (motion within the equation, e.g. into a fraction, stays inside MathLive).

## Settings

- **Virtual keyboard** — when MathLive's on-screen math keyboard appears: Manual (default,
  toggle with Ctrl+Space), Auto (on focus, for touch devices), or Sandboxed.
- **Centre equations** — centre `mathlive` blocks in the note rather than left-aligning them.
- **Add MathLive commands to the command palette** — registers one Obsidian command per
  no-argument MathLive command (e.g. `addRowAfter`, `moveToNextPlaceholder`), so they can be
  bound to hotkeys. These only run while a math field actually has focus — opening the
  command palette blurs the field, so they won't run from the palette itself. Requires a
  plugin reload to take effect.


## Commands

- **Insert equation** — insert an empty centred (or left-aligned, per settings) equation
  block below the current line.
- **Insert left-aligned equation** — same, but always left-aligned regardless of the centre
  setting.
- **Toggle math symbol mode** — toggle the math symbol mode on or off. this toggles a mode
  disables obsidian's native hotkeys and inserts a specified math symbol whenever you use
  your own specified triggers. By default, "p" is mapped to "\pi".
- **One-shot math symbol trigger** — same as above, except it automatically turns off math
  symbol mode after you insert a math symbol. only works when the widget is focused.
