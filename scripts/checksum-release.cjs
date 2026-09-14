const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const directory = path.resolve(process.argv[2] || 'release');
const names = fs.readdirSync(directory).filter(name => /\.(exe|dmg|zip)$/.test(name)).sort();
if (!names.length) throw new Error('No release installers found');
fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), names.map(name => `${createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')}  ${name}\n`).join(''));
