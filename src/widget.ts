import { MarkdownPostProcessorContext, MarkdownRenderChild, MarkdownView } from 'obsidian';
import type { MathfieldElement } from 'mathlive';
import type MathLivePlugin from './main';
import { clearLastMathField, setLastMathField } from './focus';

/**
 * Events we stop from escaping the widget.
 *
 * Bubble phase, never capture: MathLive listens in the capture phase on its own
 * keyboard sink inside the shadow root, so a capture listener out here would fire
 * first and starve it. By the time an event bubbles back out to this container,
 * MathLive has already handled it, and we stop it before it reaches CodeMirror's
 * contentDOM handler or the document.
 *
 * `mousedown` also stops CodeMirror moving the selection into the block, which in
 * Live Preview would collapse the rendered widget back to its raw source.
 * `contextmenu` lets MathLive's own menu win over Obsidian's.
 *
 * We never call preventDefault(): the field needs its default click and focus
 * behaviour.
 */
/** MathLive's `move-out`, which its own typings only expose via the element event map. */
type MoveOutEvent = CustomEvent<{
  direction: 'forward' | 'backward' | 'upward' | 'downward';
}>;

/**
 * MathLive's context menu, reached through internals because `MathfieldElement`
 * exposes no way to close it.
 *
 * Read `_menu`, never the `menu` getter on `_Mathfield`: the getter lazily
 * *constructs* a Menu (`mathlive/src/editor-mathfield/mathfield-private.ts:745`),
 * so asking whether a menu is open through it would create one.
 */
type MathfieldInternals = {
  _mathfield?: { _menu?: { hide(): void } } | null;
};

const DAMMED_EVENTS = [
  'keydown',
  'keyup',
  'keypress',
  'beforeinput',
  'input',
  'mousedown',
  'contextmenu',
] as const;

/**
 * Never `new MathfieldElement()`. Obsidian re-evaluates main.js when a plugin is
 * re-enabled, but `customElements.define('math-field', ...)` only ever takes the
 * first class it is given. The freshly imported `MathfieldElement` is then not the
 * registered constructor, and calling it throws "Illegal constructor".
 * `createElement` always upgrades against whatever is actually registered.
 *
 * It also returns a plain, un-upgraded element when `math-field` is not defined in
 * this document's window — which is the case in Obsidian popout windows, since
 * MathLive only registers itself on the main window.
 */
function createMathField(doc: Document): MathfieldElement | null {
  const el = doc.createElement('math-field') as MathfieldElement;
  // Duck-typed, not `instanceof`: after a re-enable the registered class is a
  // different (but equally functional) class object from the one we imported.
  return typeof el.executeCommand === 'function' ? el : null;
}

export class MathBlockRenderChild extends MarkdownRenderChild {
  private mf!: MathfieldElement;
  private lastSaved: string;

  constructor(
    private plugin: MathLivePlugin,
    containerEl: HTMLElement,
    private source: string,
    private ctx: MarkdownPostProcessorContext,
    private centre: boolean,
  ) {
    super(containerEl);
    this.lastSaved = source;
  }

  onload(): void {
    const { settings } = this.plugin;

    this.containerEl.addClass('mathlive-block');
    this.containerEl.toggleClass('mathlive-block-centre', this.centre);

    const mf = createMathField(this.containerEl.ownerDocument);
    if (!mf) {
      this.containerEl.createEl('pre', {
        cls: 'mathlive-error',
        text:
          'MathLive is not available in this window. Equations can only be edited ' +
          'in the main window, not in popout windows.\n\n' +
          this.source,
      });
      return;
    }

    mf.value = this.source;
    mf.mathVirtualKeyboardPolicy = settings.virtualKeyboardPolicy;
    this.containerEl.appendChild(mf);
    this.mf = mf;

    for (const type of DAMMED_EVENTS) {
      this.registerDomEvent(this.containerEl, type, (evt: Event) => {
        evt.stopPropagation();
      });
    }

    this.registerDomEvent(this.containerEl, 'mousedown', (evt) => this.focusFromSurround(evt));

    // In Live Preview `containerEl` fills Obsidian's `.cm-embed-block` exactly, so the
    // handler above already covers the whole bordered square. Claim the wrapper anyway,
    // for a theme that gives it padding lying outside `containerEl`. It is not yet in the
    // DOM when the post processor runs, hence the deferral. A mousedown from inside
    // `containerEl` never reaches it — the dam stops that one propagating.
    const timer = window.setTimeout(() => {
      const wrapper = this.containerEl.closest<HTMLElement>('.cm-embed-block');
      if (wrapper) this.registerDomEvent(wrapper, 'mousedown', (evt) => this.focusFromSurround(evt));
    }, 0);
    this.register(() => window.clearTimeout(timer));

    this.registerDomEvent(mf, 'focusin', () => setLastMathField(mf));
    this.registerDomEvent(mf, 'focusout', () => this.handleBlur());

    // Not registerDomEvent: its overloads only accept keys of HTMLElementEventMap,
    // and 'move-out' is MathLive's own. this.register still gives us cleanup.
    const onMoveOut = (evt: Event) => this.exit(evt as MoveOutEvent);
    mf.addEventListener('move-out', onMoveOut);
    this.register(() => mf.removeEventListener('move-out', onMoveOut));

    // MathLive dispatches `change` on blur, but only when the value actually
    // differs from what it was when the field gained focus. That is exactly the
    // "commit this edit" signal we want. Writing on `input` instead would
    // re-render the block on every keystroke and destroy focus.
    this.registerDomEvent(mf, 'change', () => void this.save());
  }

  onunload(): void {
    if (!this.mf) return;
    clearLastMathField(this.mf);
    // A block torn down with its menu open would otherwise leave the scrim behind
    // with nothing left to dismiss it. `handleBlur` bails on a disconnected field,
    // so it cannot cover this.
    this.dismissTransientUi();
    // A note closed mid-edit blurs the field first, so `change` has normally
    // already fired. This is the belt-and-braces path.
    if (this.mf.value !== this.lastSaved) void this.save();
  }

  /**
   * Focus the field from a click on the block around it.
   *
   * The rendered block spans the full width of Obsidian's code-block square, but the
   * `<math-field>` only occupies the middle of it. A mousedown on the surrounding strip
   * is caught by the dam and otherwise does nothing at all, which is what makes short
   * equations so hard to click into. Send the caret to whichever end of the equation the
   * click was nearer, the way clicking a text editor's margin behaves.
   *
   * `preventDefault()` is right here, unlike on a mousedown over the field itself (see
   * `DAMMED_EVENTS`): there is no default we want, and leaving it would let CodeMirror
   * move the selection into the block and collapse the widget back to raw source.
   *
   * Clicks over the `<math-field>` are left entirely to MathLive, and clicks on
   * Obsidian's "Edit this block" button — a sibling positioned on top of the block —
   * are left to Obsidian. That button only overlaps `containerEl` visually, so it never
   * actually reaches this handler; the guard is for the wrapper listener, where it does.
   */
  private focusFromSurround(evt: MouseEvent): void {
    if (evt.button !== 0 || !this.mf) return;

    // Events crossing MathLive's shadow root are retargeted to the host, so a click
    // anywhere inside the field reports the <math-field> itself as the target.
    const target = evt.target;
    if (!(target instanceof Element)) return;
    if (target.closest('math-field') || target.closest('.edit-block-button')) return;

    evt.preventDefault();
    evt.stopPropagation();

    const rect = this.mf.getBoundingClientRect();
    const before = evt.clientX < rect.left + rect.width / 2;
    this.mf.focus();
    this.mf.executeCommand(before ? 'moveToMathfieldStart' : 'moveToMathfieldEnd');
  }

  /**
   * Move the cursor out of the field and back into the note.
   *
   * MathLive dispatches `move-out` only at a dead end — when the caret is already at
   * the edge of the field and an arrow key has nowhere left to go
   * (`mathlive/src/editor-model/commands.ts`). Motion *within* the equation, such as
   * Down from the numerator of a fraction, never reaches us. The event is cancelable,
   * bubbles, and is `composed`, so it escapes the shadow root and we can just take it.
   *
   * All four directions land the cursor outside the block: backward/upward before the
   * opening fence, forward/downward after the closing one.
   */
  private exit(evt: MoveOutEvent): void {
    // In Reading mode there is no editor to move a cursor in. Leave the event
    // uncancelled and MathLive does its default thing (focus the next element).
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file?.path !== this.ctx.sourcePath) return;

    const info = this.ctx.getSectionInfo(this.containerEl);
    if (!info) return;

    evt.preventDefault();

    const { direction } = evt.detail;
    const backward = direction === 'backward' || direction === 'upward';

    // Deferred out of this event handler, because MathLive is still mid-command.
    // `move-out` is dispatched from `handleDeadEnd()` inside `moveUpward()` and its
    // three siblings, each of which calls `model.announce()` on the line *after* the
    // dispatch returns. Saving here re-renders the block synchronously, which unmounts
    // the <math-field>, which disposes the Mathfield and nulls `model.mathfield` —
    // so that `announce()` then throws "Cannot read properties of undefined (reading
    // 'host')". A macrotask lets the command finish before the DOM changes underneath it.
    const timer = window.setTimeout(() => this.leave(info, backward), 0);
    this.register(() => window.clearTimeout(timer));
  }

  /** The deferred half of `exit()`: commit the edit, then move the cursor. */
  private leave(info: { lineStart: number; lineEnd: number }, backward: boolean): void {
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file?.path !== this.ctx.sourcePath) return;

    void (async () => {
      // Blurring the field would fire `change` and save anyway, but the write shifts
      // every line below the block, so do it first and account for the shift.
      const wrote = await this.save();
      const { editor } = view;

      // The opening fence never moves — the body is below it — so an upward exit
      // needs no correction at all. Only the closing fence shifts.
      const oldBodyLines = info.lineEnd - info.lineStart - 1;
      const newBodyLines = this.lastSaved.length > 0 ? this.lastSaved.split('\n').length : 0;
      const lineEnd = info.lineEnd + (wrote ? newBodyLines - oldBodyLines : 0);

      // Focus first: it blurs the field, firing a `change` whose save() is now a
      // no-op. Doing it after setCursor would let that blur reset the selection.
      editor.focus();

      if (backward) {
        const line = info.lineStart - 1;
        // A block on the very first line has nothing above it to land on.
        if (line < 0) editor.setCursor({ line: 0, ch: 0 });
        else editor.setCursor({ line, ch: editor.getLine(line).length });
      } else {
        const line = lineEnd + 1;
        // Likewise for a block that ends the note.
        if (line < editor.lineCount()) editor.setCursor({ line, ch: 0 });
        else editor.setCursor({ line: lineEnd, ch: editor.getLine(lineEnd).length });
      }
    })();
  }

  /**
   * `focusout` also fires when focus moves *within* the shadow root (e.g. onto
   * MathLive's menu toggle), because the event is retargeted to the host. Defer a
   * tick and check whether focus really left.
   */
  private handleBlur(): void {
    window.setTimeout(() => {
      if (!this.mf.isConnected) return;
      if (this.mf.ownerDocument.activeElement === this.mf) return;
      clearLastMathField(this.mf);
      this.dismissTransientUi();
    }, 0);
  }

  /**
   * Tear down the context menu and the virtual keyboard, which both outlive the
   * field that opened them.
   *
   * `_Mathfield.onBlur` hides the suggestion popover and nothing else. The menu's
   * scrim is appended *inside the field's shadow root* and light-dismisses only on
   * a `click` whose target is the scrim itself, so a click that CodeMirror takes
   * instead leaves the menu on screen; the stranded scrim then sits over the note
   * at `z-index: 10099` and eats the events that arrow-key re-entry needs.
   * `VirtualKeyboard.disconnect()` opens with `if (this._visible) return;`, so a
   * blur never lowers the keyboard either.
   *
   * Safe to call when neither is showing: `Menu.hide()` no-ops when closed.
   */
  private dismissTransientUi(): void {
    const doc = this.mf.ownerDocument;

    // Snapshot before hiding. `Menu.hide()` synchronously reaches `Scrim.close()`,
    // which ends by restoring focus to whatever was focused when the menu opened —
    // this very field. Focus has legitimately moved on by now, so put it back.
    const focused = doc.activeElement;
    (this.mf as unknown as MathfieldInternals)._mathfield?._menu?.hide();
    if (focused instanceof HTMLElement && doc.activeElement !== focused) focused.focus();

    // The keyboard is a singleton shared by every field on the page. If focus went
    // straight to another equation, that field's `focusin` has already re-shown it.
    const vk = window.mathVirtualKeyboard;
    if (vk?.visible && doc.activeElement?.localName !== 'math-field') vk.hide();
  }

  /**
   * Write the field's LaTeX back into the fenced block in the note.
   *
   * Returns whether anything was written — `exit()` needs to know, because a write
   * can change how many lines the block occupies.
   */
  private async save(): Promise<boolean> {
    const latex = this.mf.value;
    if (latex === this.lastSaved) return false;

    // getSectionInfo goes stale, and is null often enough that it must be
    // handled. Call it immediately before use.
    const info = this.ctx.getSectionInfo(this.containerEl);
    if (!info) return false;

    // lineStart is the opening fence, lineEnd the closing one.
    const from = { line: info.lineStart + 1, ch: 0 };
    const to = { line: info.lineEnd, ch: 0 };
    const body = latex.length > 0 ? `${latex}\n` : '';

    // Set before the write, never after. `replaceRange` re-renders the block
    // synchronously, which unloads this render child; `onunload`'s fallback save
    // compares `mf.value` against `lastSaved`, and if that still held the old value
    // it would issue a second, identical `replaceRange` nested inside this one's
    // still-in-flight dispatch. CodeMirror then maps positions from the first change
    // through a changeset for a document that no longer has them:
    // "Position 23 is out of range for changeset of length 21".
    const previous = this.lastSaved;
    this.lastSaved = latex;

    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file?.path === this.ctx.sourcePath) {
      // Prefer the editor when the file is open, so we don't clobber unsaved
      // buffer state, and so the write lands in Obsidian's undo history.
      view.editor.replaceRange(body, from, to);
    } else {
      const file = this.plugin.app.vault.getFileByPath(this.ctx.sourcePath);
      if (!file) {
        this.lastSaved = previous;
        return false;
      }
      await this.plugin.app.vault.process(file, (data) => {
        const lines = data.split('\n');
        if (to.line > lines.length) return data; // section info went stale
        lines.splice(
          from.line,
          to.line - from.line,
          ...(latex.length > 0 ? latex.split('\n') : []),
        );
        return lines.join('\n');
      });
    }

    return true;
  }
}
