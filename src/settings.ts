import { App, PluginSettingTab, Setting } from 'obsidian';
import type { VirtualKeyboardPolicy } from 'mathlive';
import type MathLivePlugin from './main';
import { SEQUENCE_TIMEOUT_MS } from './mathSymbolMode';

/**
 * One user-defined symbol shortcut, live only while math symbol mode is on
 * (see mathSymbolMode.ts). `trigger` is parsed by `parseTrigger` there:
 *  - "Alt+P" / "Shift+Ctrl+X"  -> a single chord (modifiers + one key).
 *  - "al" / "pi" / "sum"       -> a leader sequence, typed one plain
 *                                  (unmodified) key at a time, matched
 *                                  case-insensitively.
 */
export interface MathSymbolMapping {
  id: string;
  /** Display label only, e.g. "Pi". Purely for the settings list. */
  name: string;
  trigger: string;
  /** Text/LaTeX inserted at the cursor, e.g. "\\pi". */
  insert: string;
}

export interface MathLiveSettings {
  /** MathLive's default is 'auto', which ambushes touch-capable laptops. */
  virtualKeyboardPolicy: VirtualKeyboardPolicy;
  /** Register one Obsidian command per no-arg MathLive command. */
  registerPaletteCommands: boolean;
  /** Centre the equation in the note. */
  centre: boolean;
  /** User-defined symbol shortcuts for math symbol mode. */
  mathSymbolMappings: MathSymbolMapping[];
  /**
   * A single unmodified key that activates math symbol mode for exactly one
   * symbol while a math field is focused (see mathSymbolMode.ts). Bypasses
   * Obsidian's command/hotkey system entirely, since that requires a modifier.
   */
  oneShotTrigger: string;
  /** Show a Notice when math symbol mode or one-shot symbol mode turns on. */
  showModeNotifications: boolean;
}

let idCounter = 0;
/** Not persisted meaningfully beyond uniqueness within a single session's edits. */
export function generateMappingId(): string {
  idCounter += 1;
  return `${Date.now().toString(36)}-${idCounter}`;
}

export const DEFAULT_SETTINGS: MathLiveSettings = {
  virtualKeyboardPolicy: 'manual',
  registerPaletteCommands: true,
  centre: true,
  mathSymbolMappings: [
    { id: generateMappingId(), name: 'Pi', trigger: 'pi', insert: '\\pi' },
  ],
  oneShotTrigger: '`',
  showModeNotifications: true,
};

export class MathLiveSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: MathLivePlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Virtual keyboard')
      .setDesc(
        'When MathLive\'s on-screen math keyboard appears. "Manual" only shows it ' +
          'via the toggle command (Alt+Space). "Auto" shows it on focus for touch devices.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ manual: 'Manual', auto: 'Auto', sandboxed: 'Sandboxed' })
          .setValue(this.plugin.settings.virtualKeyboardPolicy)
          .onChange(async (value) => {
            this.plugin.settings.virtualKeyboardPolicy = value as VirtualKeyboardPolicy;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Centre equations')
      .setDesc(
        'Centre the equation block in the note rather than left-aligning it. ' +
          'A ```mathlive-left block always aligns left, whatever this is set to.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.centre).onChange(async (value) => {
          this.plugin.settings.centre = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Add MathLive commands to the command palette')
      .setDesc(
        'Registers one Obsidian command per no-argument MathLive command, so you can ' +
          'assign your own hotkeys to them under Settings → Hotkeys. ' +
          'Requires a reload of the plugin to take effect.',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.registerPaletteCommands)
          .onChange(async (value) => {
            this.plugin.settings.registerPaletteCommands = value;
            await this.plugin.saveSettings();
          }),
      );

    this.displayMathSymbolMode(containerEl);
  }

  private displayMathSymbolMode(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Math symbol mode' });

    const desc = containerEl.createEl('p', { cls: 'setting-item-description' });
    desc.appendText(
      'Toggle command "Math symbol mode: Toggle" (default hotkey Alt+`, reassignable ' +
        'under Settings → Hotkeys) suspends Obsidian\'s normal hotkeys and activates the ' +
        'shortcuts below instead — so you can chain several without conflicts. Press ' +
        'Alt+` or Escape to return to normal.',
    );
    desc.createEl('br');
    desc.createEl('br');
    desc.appendText('Each shortcut has a trigger, written one of two ways:');
    const ul = desc.createEl('ul');
    ul.createEl('li').append(
      'A chord, e.g. ',
      createEl('code', { text: 'Alt+P' }),
      ' or ',
      createEl('code', { text: 'Shift+Ctrl+X' }),
      ' — one keypress with modifiers.',
    );
    ul.createEl('li').append(
      'A sequence, e.g. ',
      createEl('code', { text: 'al' }),
      ' or ',
      createEl('code', { text: 'pi' }),
      ' — plain (unmodified) keys typed one after another, case-insensitive. ' +
        `Waits up to ${(SEQUENCE_TIMEOUT_MS / 1000).toFixed(1)}s between keys before ` +
        'giving up and resetting.',
    );
    desc.append(
      'Text to insert is treated as LaTeX inside an equation block, and pasted as ' +
        'plain text everywhere else.',
    );

    for (const mapping of this.plugin.settings.mathSymbolMappings) {
      const setting = new Setting(containerEl);
      setting.settingEl.addClass('mathlive-symbol-mapping-row');

      setting.addText((text) =>
        text
          .setPlaceholder('Name')
          .setValue(mapping.name)
          .onChange(async (value) => {
            mapping.name = value;
            await this.plugin.saveSettings();
          }),
      );

      setting.addText((text) =>
        text
          .setPlaceholder('Trigger, e.g. al')
          .setValue(mapping.trigger)
          .onChange(async (value) => {
            mapping.trigger = value;
            await this.plugin.saveSettings();
          }),
      );

      setting.addText((text) =>
        text
          .setPlaceholder('Insert, e.g. \\alpha')
          .setValue(mapping.insert)
          .onChange(async (value) => {
            mapping.insert = value;
            await this.plugin.saveSettings();
          }),
      );

      setting.addExtraButton((button) =>
        button
          .setIcon('trash')
          .setTooltip('Remove')
          .onClick(async () => {
            this.plugin.settings.mathSymbolMappings = this.plugin.settings.mathSymbolMappings.filter(
              (m) => m.id !== mapping.id,
            );
            await this.plugin.saveSettings();
            this.display();
          }),
      );
    }

    new Setting(containerEl).addButton((button) =>
      button
        .setButtonText('Add symbol shortcut')
        .setCta()
        .onClick(async () => {
          this.plugin.settings.mathSymbolMappings.push({
            id: generateMappingId(),
            name: '',
            trigger: '',
            insert: '',
          });
          await this.plugin.saveSettings();
          this.display();
        }),
    );

    new Setting(containerEl)
      .setName('One-shot symbol trigger')
      .setDesc(
        'A single unmodified key that, while a math field is focused, activates math ' +
          'symbol mode for exactly one symbol: press it, then press the trigger for a ' +
          'shortcut above to insert it and return to normal automatically. Press it ' +
          "again to cancel. This bypasses Obsidian's hotkey system entirely (which " +
          "requires a modifier), so it can't be reassigned under Settings → Hotkeys — " +
          'change it here instead.',
      )
      .addText((text) =>
        text
          .setPlaceholder('`')
          .setValue(this.plugin.settings.oneShotTrigger)
          .onChange(async (value) => {
            this.plugin.settings.oneShotTrigger = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Notify on mode activation')
      .setDesc(
        'Show a Notice when math symbol mode or one-shot symbol mode turns on. ' +
          '(There is never one for turning off, since one-shot mode exits ' +
          'automatically after almost every use.)',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showModeNotifications)
          .onChange(async (value) => {
            this.plugin.settings.showModeNotifications = value;
            await this.plugin.saveSettings();
          }),
      );
  }
}
