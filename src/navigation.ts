import { Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import type { MathfieldElement } from 'mathlive';

/**
 * Arrow-key entry into a rendered math block, from the CodeMirror side.
 *
 * Only Up and Down are bound. Left and Right are deliberately left to CodeMirror's
 * defaults, which move the cursor onto the fence line and so collapse the block back
 * to its raw source — that is the intended behaviour, not a bug.
 *
 * This is driven entirely off the rendered DOM, never off a CM6 `WidgetType` of our
 * own (see CLAUDE.md — an earlier design had one and its arrow-key nav was the most
 * fragile code in the plugin). That has a useful consequence: when a block is already
 * collapsed to raw source there is no `.mathlive-block` element for it, so these
 * handlers find nothing and fall through to ordinary line motion. Editing the source
 * of a math block therefore behaves exactly like editing any other code block.
 */

/**
 * The document line range of a rendered block, fence line to fence line.
 *
 * `lineBlockAt` on the widget's position spans the whole replaced range, so `from` is
 * the opening fence and `to` the closing one. `posAtDOM` throws if the element is not
 * currently part of this view's content, which happens while a block is being torn
 * down or re-rendered.
 */
function blockLines(view: EditorView, el: HTMLElement): { from: number; to: number } | null {
  try {
    const block = view.lineBlockAt(view.posAtDOM(el));
    return {
      from: view.state.doc.lineAt(block.from).number,
      to: view.state.doc.lineAt(block.to).number,
    };
  } catch {
    return null;
  }
}

/**
 * True if vertical motion from the cursor would leave its current document line.
 *
 * A long soft-wrapped line occupies several visual rows, and Down from its first row
 * should move to its second row, not jump into the block below it. `moveVertically`
 * answers that in visual rows, which is what the user actually sees.
 */
function leavesCurrentLine(view: EditorView, forward: boolean): boolean {
  const cursor = view.state.selection.main;
  const moved = view.moveVertically(cursor, forward);
  const doc = view.state.doc;
  return doc.lineAt(moved.head).number !== doc.lineAt(cursor.head).number;
}

/** Focus the field in `el`, putting its caret at the edge the cursor arrived from. */
function focusField(el: HTMLElement, fromAbove: boolean): boolean {
  const mf = el.querySelector('math-field') as MathfieldElement | null;
  // Duck-typed for the same reason as widget.ts, and null in popout windows where
  // `math-field` was never registered. Fall through to normal motion there.
  if (!mf || typeof mf.executeCommand !== 'function') return false;
  mf.focus();
  mf.executeCommand(fromAbove ? 'moveToMathfieldStart' : 'moveToMathfieldEnd');
  return true;
}

function enterAdjacentBlock(view: EditorView, forward: boolean): boolean {
  const cursor = view.state.selection.main;
  if (!cursor.empty) return false;

  const cursorLine = view.state.doc.lineAt(cursor.head).number;

  for (const el of Array.from(
    view.contentDOM.querySelectorAll<HTMLElement>('.mathlive-block'),
  )) {
    const lines = blockLines(view, el);
    if (!lines) continue;

    // Down from the line directly above the opening fence, or up from the line
    // directly below the closing fence.
    const adjacent = forward ? lines.from === cursorLine + 1 : lines.to === cursorLine - 1;
    if (!adjacent) continue;
    if (!leavesCurrentLine(view, forward)) return false;

    return focusField(el, forward);
  }

  return false;
}

export function mathBlockNavigation(): Extension {
  // Highest precedence so we run before CodeMirror's own cursorLineDown/Up, which
  // would move the cursor into the block and collapse it before we saw the key.
  return Prec.highest(
    keymap.of([
      { key: 'ArrowDown', run: (view) => enterAdjacentBlock(view, true) },
      { key: 'ArrowUp', run: (view) => enterAdjacentBlock(view, false) },
    ]),
  );
}
