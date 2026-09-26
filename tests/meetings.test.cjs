const {test} = require('node:test');
const assert = require('node:assert/strict');
const {MicWatcher, meetingTurns, meetingText, summaryPrompt, clock} = require('../electron/meetings.cjs');

test('the watcher reports apps that start and stop using the microphone', () => {
  const reads = [[], [{id: 'discord.exe', name: 'Discord'}], [{id: 'discord.exe', name: 'Discord'}, {id: 'zoom.exe', name: 'Zoom'}], [{id: 'zoom.exe', name: 'Zoom'}], []];
  const watcher = new MicWatcher(() => reads.shift());
  const events = [];
  watcher.on('start', user => events.push(['start', user.id]));
  watcher.on('stop', user => events.push(['stop', user.id]));
  for (let i = 0; i < 5; i++) watcher.poll();
  assert.deepEqual(events, [['start', 'discord.exe'], ['start', 'zoom.exe'], ['stop', 'discord.exe'], ['stop', 'zoom.exe']]);
  // A failed read changes nothing.
  const broken = new MicWatcher(() => { throw new Error('registry'); });
  broken.poll();
  assert.equal(broken.active.size, 0);
});

test('two channels become a dialog in time order, and the microphone echo of the other side is dropped', () => {
  const mine = [{start: 4, end: 6, text: 'Да, слышно отлично.'}, {start: 7, end: 9, text: 'Начнём с бюджета.'},
    // Played through speakers, the other side's words reach the microphone too.
    {start: 10.2, end: 13, text: 'Бюджет утвердили, сто двадцать тысяч.'}];
  const theirs = [{start: 0, end: 3, text: 'Привет, всех слышно?'}, {start: 10, end: 13, text: 'Бюджет утвердили, сто двадцать тысяч.'},
    {start: 13.5, end: 15, text: 'Сроки до пятницы.'}];
  const turns = meetingTurns(mine, theirs);
  assert.deepEqual(turns.map(t => [t.speaker, t.text]), [
    ['them', 'Привет, всех слышно?'], ['me', 'Да, слышно отлично. Начнём с бюджета.'],
    ['them', 'Бюджет утвердили, сто двадцать тысяч. Сроки до пятницы.']]);
  assert.equal(meetingText(turns), '[00:00] Собеседники: Привет, всех слышно?\n\n[00:04] Я: Да, слышно отлично. Начнём с бюджета.\n\n'
    + '[00:10] Собеседники: Бюджет утвердили, сто двадцать тысяч. Сроки до пятницы.');
});

test('the same words said by the user at another time are not echo', () => {
  const turns = meetingTurns([{start: 30, end: 32, text: 'Сроки до пятницы.'}], [{start: 13.5, end: 15, text: 'Сроки до пятницы.'}]);
  assert.deepEqual(turns.map(t => t.speaker), ['them', 'me']);
});

test('clock and summary prompt', () => {
  assert.equal(clock(65), '01:05');
  assert.equal(clock(3725), '1:02:05');
  assert.match(summaryPrompt('[00:00] Я: Привет', 'Discord'), /^Сделай краткое резюме созвона \(Discord\).*\n\n\[00:00\] Я: Привет$/s);
});
