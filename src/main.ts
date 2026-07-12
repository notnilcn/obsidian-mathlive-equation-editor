import { Editor, Plugin } from 'obsidian';
import { MathfieldElement } from 'mathlive';
import { DEFAULT_SETTINGS, MathLiveSettings, MathLiveSettingTab } from './settings';
import { registerMathFieldCommands } from './commands';
import { MathBlockRenderChild } from './widget';
import { mathBlockNavigation } from './navigation';
import { registerMathSymbolMode } from './mathSymbolMode';

/**
 * Drop an empty fenced block on the lines *below* the cursor's line, leaving the
 * cursor where it was so that ArrowDown moves into the new widget (see
 * `mathBlockNavigation`).
 */
function insertEquation(editor: Editor, lang: 'mathlive' | 'mathlive-left'): void {
  const cursor = editor.getCursor();
  const endOfLine = { line: cursor.line, ch: editor.getLine(cursor.line).length };
  editor.replaceRange(`\n\`\`\`${lang}\n\n\`\`\``, endOfLine);
  editor.setCursor(cursor);
}

export default class MathLivePlugin extends Plugin {
  settings!: MathLiveSettings;

  async onload(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) as Partial<MathLiveSettings>,
    );

    // The KaTeX @font-face rules live in our generated styles.css as base64 data
    // URIs, and it sets --ML__static-fonts, which makes MathLive skip dynamic font
    // loading entirely. Null these so it never tries to fetch a relative URL that
    // does not resolve inside Obsidian. Sounds are simply not wanted.
    //
    // After a re-enable, the class registered as `math-field` is the one from the
    // previous bundle, so configure both it and the one we just imported.
    const registered = window.customElements.get('math-field') as
      | typeof MathfieldElement
      | undefined;
    for (const cls of new Set([MathfieldElement, registered])) {
      if (!cls) continue;
      cls.fontsDirectory = null;
      cls.soundsDirectory = null;
    }

    // `mathlive` follows the `centre` setting; `mathlive-left` always aligns left.
    this.registerMarkdownCodeBlockProcessor('mathlive', (source, el, ctx) => {
      ctx.addChild(
        new MathBlockRenderChild(this, el, source.trim(), ctx, this.settings.centre),
      );
    });

    this.registerMarkdownCodeBlockProcessor('mathlive-left', (source, el, ctx) => {
      ctx.addChild(new MathBlockRenderChild(this, el, source.trim(), ctx, false));
    });

    // Up/Down move the cursor into an adjacent rendered block. Left/Right are left
    // alone, so they collapse it to raw source as before.
    this.registerEditorExtension(mathBlockNavigation());

    if (this.settings.registerPaletteCommands) registerMathFieldCommands(this);

    this.addCommand({
      id: 'insert-equation',
      name: 'Insert equation',
      editorCallback: (editor) => insertEquation(editor, 'mathlive'),
    });

    this.addCommand({
      id: 'insert-equation-left',
      name: 'Insert left-aligned equation',
      editorCallback: (editor) => insertEquation(editor, 'mathlive-left'),
    });

    this.addSettingTab(new MathLiveSettingTab(this.app, this));

    registerMathSymbolMode(this);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
