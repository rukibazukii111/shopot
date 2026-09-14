const messages = {
  pasted: 'Текст вставлен', copied: 'Текст скопирован', saved: 'Сохранено в истории',
  'no-target': 'Текст скопирован · вставь в нужное поле',
  'focus-changed': 'Окно изменилось · текст в буфере',
  permission: 'Текст скопирован · разреши автовставку в настройках',
  modifiers: 'Клавиши удерживаются · текст в буфере',
  blocked: 'Вставка недоступна · текст в буфере',
  'clipboard-changed': 'Буфер изменился · текст в истории',
  'clipboard-failed': 'Буфер недоступен · текст в истории',
  canceled: 'Вставка отменена · текст в истории',
};
class PasteService {
  constructor({clipboard, native, wait = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
    this.clipboard = clipboard; this.native = native; this.wait = wait;
  }
  capture() { try { return this.native?.capture() || null; } catch { return null; } }
  release(target) { if (target) this.native?.release(target); }
  async deliver(text, {autoCopy, autoPaste, target}, current = () => true) {
    let copied = false;
    const result = code => ({copied, pasted: code === 'pasted', code, message: messages[code]});
    if (!current()) return result('canceled');
    if (autoCopy || autoPaste) {
      try { await this.clipboard.writeText(text); copied = true; }
      catch { return result('clipboard-failed'); }
    }
    if (!autoPaste) return result(copied ? 'copied' : 'saved');
    if (!target || !this.native) return result('no-target');
    try {
      if (!this.native.permitted()) return result('permission');
      for (let i = 0; this.native.modifiersDown() && i < 20; i++) {
        if (!current()) return result('canceled');
        await this.wait(50);
      }
      if (!current()) return result('canceled');
      if (await this.clipboard.readText() !== text) { copied = false; return result('clipboard-changed'); }
      if (!current()) return result('canceled');
      if (this.native.modifiersDown()) return result('modifiers');
      if (!this.native.sameTarget(target)) return result('focus-changed');
      return result(this.native.paste() ? 'pasted' : 'blocked');
    } catch { return result('blocked'); }
  }
}
module.exports = {PasteService};
