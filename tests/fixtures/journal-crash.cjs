// Abrupt termination after a real rename, including during recovery itself.
const fs = require('node:fs');
const {createJournal} = require('../../electron/log.cjs');
const [dir, operation, after] = process.argv.slice(2);
const rename = fs.renameSync;
let renamed = 0;
fs.renameSync = (from, to) => {
  rename(from, to);
  if (++renamed === Number(after)) process.exit(73);
};
const journal = createJournal({dir, maxBytes: 50});
if (operation === 'write') journal.write('quit', {uptime: 40});
else journal.read();
// A missing crash means the requested filesystem step was never reached.
process.exit(74);
