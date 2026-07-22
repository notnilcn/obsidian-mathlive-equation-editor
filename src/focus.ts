import type { MathfieldElement } from 'mathlive';

/**
 * The last math-field to have had focus. Kept as a module-level field rather
 * than read off `document.activeElement` directly because focus can transit
 * through MathLive's own shadow-root internals (e.g. its menu button) without
 * ever really leaving the field conceptually — see `handleBlur` in widget.ts.
 * Cleared on blur and on the widget's unload.
 */
let lastMathField: MathfieldElement | null = null;

export function setLastMathField(mf: MathfieldElement): void {
  lastMathField = mf;
}

export function clearLastMathField(mf: MathfieldElement): void {
  if (lastMathField === mf) lastMathField = null;
}

/** The field, or null unless it is both live and actually focused. */
export function getFocusedMathField(): MathfieldElement | null {
  if (!lastMathField) return null;
  if (!lastMathField.isConnected) {
    lastMathField = null;
    return null;
  }
  return lastMathField.ownerDocument.activeElement === lastMathField ? lastMathField : null;
}
