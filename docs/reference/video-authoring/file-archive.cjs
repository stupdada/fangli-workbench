'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
function createFileArchive(directory) {
  const root = path.resolve(directory);
  return async record => {
    if (typeof record.id !== 'string' || !/^[\w.-]{1,128}$/u.test(record.id)) throw new TypeError('存档ID无效');
    await fs.mkdir(root, { recursive: true });
    const target = path.join(root, record.id + '.json');
    const temporary = target + '.writing';
    await fs.writeFile(temporary, JSON.stringify(record, null, 2) + '\n', 'utf8');
    await fs.rename(temporary, target);
  };
}
module.exports = { createFileArchive };
