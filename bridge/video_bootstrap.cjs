'use strict';
// A private parent-owned pipe, preloaded before the unchanged video CLI.
const fs = require('node:fs');
let first = '', byte = Buffer.alloc(1);
while (first.length < 128) {
  if (fs.readSync(0, byte, 0, 1, null) !== 1) process.exit(78);
  if (byte[0] === 10) break;
  first += byte.toString('utf8');
}
if (first !== '{"type":"boot"}') process.exit(78);
const readline = require('node:readline');
const lines = readline.createInterface({input: process.stdin});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  const emit = () => process.emit('SIGTERM');
  if (process.listenerCount('SIGTERM')) emit();
  else process.on('newListener', function onListener(event) {
    if (event === 'SIGTERM') {process.removeListener('newListener', onListener); queueMicrotask(emit);}
  });
  lines.close();
  process.stdin.destroy();
}
lines.on('line', line => {
  if (line === '{"type":"shutdown"}') stop();
});
lines.once('close', stop);
process.stdin.unref?.();
