import { MarkdownView, Notice, Scope, type Modifier } from 'obsidian';
import type MathLivePlugin from './main';
import type { MathSymbolMapping } from './settings';
import { getFocusedMathField } from './focus';

/** How long a leader sequence waits for its next key before giving up. */
export const SEQUENCE_TIMEOUT_MS = 1200;

const MODIFIER_ALIASES: Record<string, Modifier> = {
  mod: 'Mod',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  shift: 'Shift',
  alt: 'Alt',
  option: 'Alt',
};

type ParsedTrigger =
  | { kind: 'chord'; modifiers: Modifier[]; key: string }
  | { kind: 'sequence'; chars: string[] }
  | { kind: 'hold'; releaseKey: string; holdKey: string };

/**
 * "Alt+P" / "Shift+Ctrl+X" -> a chord. "c+d" (two plain single-character keys,
 * neither a recognised modifier) -> a hold trigger: fires when the first key
 * is released while the second is still held down, so an ordinary key can act
 * as a modifier for another. Anything else -> a sequence of plain, unmodified
 * keys typed one after another (case-insensitive — see the settings tab help
 * text for why sequences don't try to track Shift).
 *
 * A single-letter chord key is upper/lowercased to match what the key
 * actually reports when Shift is (or isn't) one of its modifiers, since
 * that's what a real keydown's `key` looks like for letters on any layout.
 * Multi-character keys (e.g. "Enter", "ArrowUp") are passed through as-is.
 */
export function parseTrigger(raw: string): ParsedTrigger | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.includes('+')) {
    const parts = trimmed
      .split('+')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    if (parts.length >= 2) {
      const modifierParts = parts.slice(0, -1);
      const keyPart = parts[parts.length - 1];
      const modifiers = modifierParts.map((p) => MODIFIER_ALIASES[p.toLowerCase()]);

      if (modifiers.every((m): m is Modifier => m !== undefined) && keyPart.length > 0) {
        const key =
          keyPart.length === 1
            ? modifiers.includes('Shift')
              ? keyPart.toUpperCase()
              : keyPart.toLowerCase()
            : keyPart;
        return { kind: 'chord', modifiers, key };
      }

      if (
        parts.length === 2 &&
        parts[0].length === 1 &&
        parts[1].length === 1 &&
        !(parts[0].toLowerCase() in MODIFIER_ALIASES) &&
        !(parts[1].toLowerCase() in MODIFIER_ALIASES)
      ) {
        return {
          kind: 'hold',
          releaseKey: parts[0].toLowerCase(),
          holdKey: parts[1].toLowerCase(),
        };
      }
    }
  }

  return { kind: 'sequence', chars: Array.from(trimmed.toLowerCase()) };
}

interface HoldMapping {
  releaseKey: string;
  holdKey: string;
  mapping: MathSymbolMapping;
}

export class MathSymbolMode {
  private active = false;
  /** True while the current activation should auto-exit after one symbol. */
  private oneShot = false;
  private scope: Scope | null = null;
  private statusBarEl: HTMLElement;

  private sequenceBuffer = '';
  private sequenceTimer: number | null = null;

  // Hold triggers ("c+d": release c while d is still down) can't be expressed
  // through Obsidian's Scope — it only matches keydown against real modifier
  // flags, never keyup or an arbitrary key's held state. So these are tracked
  // by hand with raw listeners, added/removed alongside the Scope push/pop in
  // activate()/deactivate() rather than left always-on.
  private holdMappings: HoldMapping[] = [];
  private holdParticipantKeys = new Set<string>();
  private heldKeys = new Set<string>();
  private holdListenersActive = false;
  // Keys that are *both* a plain sequence trigger and a hold participant
  // (e.g. "c" -> \Chi alongside "c+d" -> \cdot) can't be given to Scope: an
  // exact, non-extendable sequence match fires immediately on keydown, before
  // there's any way to know a hold combo is being attempted, so it would
  // always win the race and the hold would never fire. These keys are
  // withheld from Scope entirely (see activate()) and resolved at keyup
  // instead — see onHoldKeyup.
  private deferredSequenceKeys = new Set<string>();

  constructor(private plugin: MathLivePlugin) {
    this.statusBarEl = plugin.addStatusBarItem();
    this.statusBarEl.addClass('mathlive-symbol-mode-status');
    this.statusBarEl.setText('Σ symbols');
    this.statusBarEl.hide();
    plugin.registerDomEvent(this.statusBarEl, 'click', () => this.deactivate());

    plugin.addCommand({
      id: 'toggle-math-symbol-mode',
      name: 'Toggle math symbol mode',
      hotkeys: [{ modifiers: ['Alt'], key: '`' }],
      callback: () => this.toggle(),
    });

    // The configured trigger key (no modifiers) inserts a single symbol, but
    // only while a math field is focused. Obsidian hotkeys can't be bound
    // without a modifier, so this bypasses addCommand entirely and is wired up
    // as a capture-phase listener instead. Capture matters: MathLive listens
    // for keydown in the capture phase on its own keyboard sink inside the
    // shadow root (see widget.ts DAMMED_EVENTS), and a capture listener out
    // here on `document` fires first, before the key ever reaches MathLive or
    // becomes input.
    plugin.registerDomEvent(
      activeDocument,
      'keydown',
      (evt) => this.handleOneShotTrigger(evt),
      { capture: true },
    );

    // Never leave Obsidian's global hotkeys suspended if the plugin unloads
    // (or is disabled) while the mode happens to be active.
    plugin.register(() => this.deactivate());
  }

  private handleOneShotTrigger(evt: KeyboardEvent): void {
    const trigger = this.plugin.settings.oneShotTrigger;
    if (!trigger || evt.key !== trigger) return;
    // Ctrl/Alt/Meta are real modifiers; Shift is deliberately not checked
    // here, since it's already baked into what `evt.key` reports (e.g. a
    // trigger configured as "!" is Shift+1, and `evt.key` is "!" only when
    // Shift produced it).
    if (evt.altKey || evt.ctrlKey || evt.metaKey) return;

    if (this.active) {
      // A second press cancels our own one-shot activation. Leave the
      // persistent Alt+` toggle mode alone if that's what's active instead.
      if (!this.oneShot) return;
      evt.preventDefault();
      evt.stopPropagation();
      this.deactivate();
      return;
    }

    if (!getFocusedMathField()) return;

    evt.preventDefault();
    evt.stopPropagation();
    this.activate(true);
  }

  private toggle(): void {
    if (this.active) this.deactivate();
    else this.activate(false);
  }

  private activate(oneShot: boolean): void {
    if (this.active) return;

    this.oneShot = oneShot;

    const mappings = this.plugin.settings.mathSymbolMappings;
    const scope = new Scope();

    // Reserved: always available so the mode can never get stuck on.
    scope.register(['Alt'], '`', () => {
      this.deactivate();
      return false;
    });
    scope.register([], 'Escape', () => {
      this.deactivate();
      return false;
    });

    // Collected across all mappings, not per-mapping: two sequences sharing a
    // character (e.g. "al" and "ap") must not register that key twice, or a
    // single keystroke would double-fire into the buffer.
    const sequenceChars = new Set<string>();
    const holdMappings: HoldMapping[] = [];

    for (const mapping of mappings) {
      const parsed = parseTrigger(mapping.trigger);
      if (!parsed || !mapping.insert) continue;

      if (parsed.kind === 'chord') {
        scope.register(parsed.modifiers, parsed.key, () => {
          this.insert(mapping.insert);
          this.finishOneShot();
          return false;
        });
      } else if (parsed.kind === 'hold') {
        holdMappings.push({ releaseKey: parsed.releaseKey, holdKey: parsed.holdKey, mapping });
      } else {
        for (const char of parsed.chars) sequenceChars.add(char);
      }
    }

    this.holdMappings = holdMappings;
    this.holdParticipantKeys = new Set<string>();
    for (const h of holdMappings) {
      this.holdParticipantKeys.add(h.releaseKey);
      this.holdParticipantKeys.add(h.holdKey);
    }

    // Keys used both as a plain sequence trigger and as a hold participant
    // are withheld from Scope (see the field comment on deferredSequenceKeys
    // above) and resolved at keyup instead, in onHoldKeyup.
    this.deferredSequenceKeys = new Set<string>();
    for (const char of sequenceChars) {
      if (this.holdParticipantKeys.has(char)) {
        this.deferredSequenceKeys.add(char);
        continue;
      }
      scope.register([], char, () => {
        this.handleSequenceKey(char, mappings);
        return false;
      });
    }

    this.plugin.app.keymap.pushScope(scope);
    this.scope = scope;
    this.active = true;
    this.statusBarEl.show();

    if (holdMappings.length > 0) {
      activeDocument.addEventListener('keydown', this.onHoldKeydown, true);
      activeDocument.addEventListener('keyup', this.onHoldKeyup, true);
      activeWindow.addEventListener('blur', this.onHoldBlur);
      this.holdListenersActive = true;
    }

    // No corresponding "off" notice for one-shot: it exits automatically after
    // almost every activation (one symbol inserted), which would be noisy.
    if (this.plugin.settings.showModeNotifications) {
      new Notice(oneShot ? 'One-shot symbol mode on' : 'Math symbol mode on');
    }
  }

  /**
   * Hold-trigger keydown: swallow the key (so it never types into the field,
   * matching how registered sequence chars behave) and mark it held.
   */
  private onHoldKeydown = (evt: KeyboardEvent): void => {
    const key = evt.key.toLowerCase();
    if (!this.holdParticipantKeys.has(key)) return;
    evt.preventDefault();
    evt.stopPropagation();
    this.heldKeys.add(key);
  };

  /**
   * Hold-trigger keyup: fires a mapping if this key is a configured
   * "release" key and its paired "hold" key is still down at this instant.
   * If not — and this key doubles as a plain sequence trigger — falls back
   * to the normal sequence handling now that a hold combo is ruled out (see
   * deferredSequenceKeys).
   */
  private onHoldKeyup = (evt: KeyboardEvent): void => {
    const key = evt.key.toLowerCase();
    if (!this.holdParticipantKeys.has(key)) return;
    evt.preventDefault();
    evt.stopPropagation();

    const match = this.holdMappings.find(
      (h) => h.releaseKey === key && this.heldKeys.has(h.holdKey),
    );
    this.heldKeys.delete(key);
    if (match) {
      this.insert(match.mapping.insert);
      this.finishOneShot();
    } else if (this.deferredSequenceKeys.has(key)) {
      this.handleSequenceKey(key, this.plugin.settings.mathSymbolMappings);
    }
  };

  /** Losing window focus mid-hold (e.g. alt-tab) never fires a keyup — clear stale state. */
  private onHoldBlur = (): void => {
    this.heldKeys.clear();
  };

  private deactivate(): void {
    if (!this.active || !this.scope) return;

    const wasOneShot = this.oneShot;
    this.plugin.app.keymap.popScope(this.scope);
    this.scope = null;
    this.active = false;
    this.oneShot = false;
    this.resetSequence();
    this.statusBarEl.hide();

    if (this.holdListenersActive) {
      activeDocument.removeEventListener('keydown', this.onHoldKeydown, true);
      activeDocument.removeEventListener('keyup', this.onHoldKeyup, true);
      activeWindow.removeEventListener('blur', this.onHoldBlur);
      this.holdListenersActive = false;
    }
    this.holdMappings = [];
    this.holdParticipantKeys = new Set();
    this.deferredSequenceKeys = new Set();
    this.heldKeys.clear();

    if (!wasOneShot && this.plugin.settings.showModeNotifications) {
      new Notice('Math symbol mode off');
    }
  }

  /** After a one-shot activation inserts its symbol, immediately exit the mode. */
  private finishOneShot(): void {
    if (this.oneShot) this.deactivate();
  }

  /**
   * Feed one plain keystroke into the leader-sequence buffer.
   *
   * `sequenceMappings` is only ever the sequence-kind subset relevant here,
   * but it's simplest to just re-derive matches against the full trigger
   * list each keystroke — these lists are user-authored and tiny.
   */
  private handleSequenceKey(char: string, mappings: MathSymbolMapping[]): void {
    if (this.sequenceTimer !== null) {
      window.clearTimeout(this.sequenceTimer);
      this.sequenceTimer = null;
    }

    const candidate = this.sequenceBuffer + char;
    const sequences = mappings
      .map((m) => ({ m, parsed: parseTrigger(m.trigger) }))
      .filter(
        (x): x is { m: MathSymbolMapping; parsed: { kind: 'sequence'; chars: string[] } } =>
          x.parsed?.kind === 'sequence',
      )
      .map((x) => ({ mapping: x.m, trigger: x.parsed.chars.join('') }));

    const exact = sequences.find((s) => s.trigger === candidate);
    const extendable = sequences.some(
      (s) => s.trigger.length > candidate.length && s.trigger.startsWith(candidate),
    );

    if (!exact && !extendable) {
      this.resetSequence();
      // A one-shot activation only gets a single attempt at a symbol; a dead
      // keystroke ends it instead of leaving the mode waiting silently.
      this.finishOneShot();
      return;
    }

    this.sequenceBuffer = candidate;

    if (exact && extendable) {
      // Ambiguous: "a" is itself a symbol, but so is "al" — give the longer
      // sequence a chance to complete before committing to the short one.
      this.sequenceTimer = window.setTimeout(() => {
        this.insert(exact.mapping.insert);
        this.sequenceBuffer = '';
        this.sequenceTimer = null;
        this.finishOneShot();
      }, SEQUENCE_TIMEOUT_MS);
    } else if (exact) {
      this.insert(exact.mapping.insert);
      this.sequenceBuffer = '';
      this.finishOneShot();
    } else {
      this.sequenceTimer = window.setTimeout(() => this.resetSequence(), SEQUENCE_TIMEOUT_MS);
    }
  }

  private resetSequence(): void {
    this.sequenceBuffer = '';
    if (this.sequenceTimer !== null) {
      window.clearTimeout(this.sequenceTimer);
      this.sequenceTimer = null;
    }
  }

  /** Paste `text` at the cursor: as LaTeX into a focused math field, else into the active editor. */
  private insert(text: string): void {
    const mf = getFocusedMathField();
    if (mf) {
      mf.insert(text, { format: 'latex' });
      return;
    }

    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    view?.editor.replaceSelection(text);
  }
}

export function registerMathSymbolMode(plugin: MathLivePlugin): void {
  new MathSymbolMode(plugin);
}
