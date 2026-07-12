import type { Selector } from 'mathlive';
import type MathLivePlugin from './main';
import { getFocusedMathField } from './focus';

/**
 * These commands are gated on actual focus (see `getFocusedMathField`), so
 * they only ever fire while the field is still focused.
 *
 * Trade-off: this means the command palette can no longer run these commands
 * (opening the palette blurs the field first). That's intentional — these
 * are meant to be driven by hotkeys assigned directly to the field, and a
 * hotkey must not fire while focus is elsewhere.
 */

/**
 * Every command in mathlive's `Commands` interface (src/public/commands.ts)
 * that takes no arguments beyond its target, i.e. `(mathfield: Mathfield) => boolean`
 * or `(model: Model) => boolean`.
 *
 * Deliberately excluded because they require arguments: `performWithFeedback`,
 * `dispatchEvent`, `switchMode`, `insert`, `typedText`, `speak`, `insertPrompt`,
 * `setEnvironment`, `applyStyle`.
 *
 * Typed as `Selector[]` so `tsc -noEmit` fails the build if MathLive renames one.
 */
export const NO_ARG_SELECTORS: readonly Selector[] = [
  // target: mathfield
  'undo',
  'redo',
  'commit',
  'complete',
  'nextSuggestion',
  'previousSuggestion',
  'copyToClipboard',
  'cutToClipboard',
  'pasteFromClipboard',
  'scrollIntoView',
  'scrollToStart',
  'scrollToEnd',
  'toggleContextMenu',
  'toggleKeystrokeCaption',
  'toggleVirtualKeyboard',
  'showVirtualKeyboard',
  'hideVirtualKeyboard',
  'plonk',
  'insertDecimalSeparator',

  // target: model — tabular
  'addRowAfter',
  'addColumnAfter',
  'addRowBefore',
  'addColumnBefore',
  'removeRow',
  'removeColumn',

  // target: model — delete
  'deleteAll',
  'deleteForward',
  'deleteBackward',
  'deleteNextWord',
  'deletePreviousWord',
  'deleteToGroupStart',
  'deleteToGroupEnd',
  'deleteToMathFieldStart',
  'deleteToMathFieldEnd',

  // target: model — move
  'moveToOpposite',
  'moveBeforeParent',
  'moveAfterParent',
  'moveToNextPlaceholder',
  'moveToPreviousPlaceholder',
  'moveToNextChar',
  'moveToPreviousChar',
  'moveUp',
  'moveDown',
  'moveToNextWord',
  'moveToPreviousWord',
  'moveToGroupStart',
  'moveToGroupEnd',
  'moveToNextGroup',
  'moveToPreviousGroup',
  'moveToMathfieldStart',
  'moveToMathfieldEnd',
  'moveToSuperscript',
  'moveToSubscript',

  // target: model — select
  'selectGroup',
  'selectAll',
  'extendSelectionForward',
  'extendSelectionBackward',
  'extendToNextWord',
  'extendToPreviousWord',
  'extendSelectionUpward',
  'extendSelectionDownward',
  'extendToNextBoundary',
  'extendToPreviousBoundary',
  'extendToGroupStart',
  'extendToGroupEnd',
  'extendToMathFieldStart',
  'extendToMathFieldEnd',
];

/** `moveToSuperscript` -> `Move to superscript` */
export function selectorToName(selector: string): string {
  const spaced = selector.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function registerMathFieldCommands(plugin: MathLivePlugin): void {
  for (const selector of NO_ARG_SELECTORS) {
    plugin.addCommand({
      id: selector,
      name: selectorToName(selector),
      checkCallback: (checking: boolean) => {
        const mf = getFocusedMathField();
        if (!mf) return false;
        if (!checking) mf.executeCommand(selector);
        return true;
      },
    });
  }
}
