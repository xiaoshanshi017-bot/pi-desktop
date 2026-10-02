// A tiny child-process peer for transport tests. It never loads Pi or a model.
let buffer = '';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (command, data = {}) => emit({ id: command.id, type: 'response', command: command.type, success: true, data });
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    switch (command.type) {
      case 'echo':
        setTimeout(() => reply(command, { marker: command.marker }), command.delay || 0);
        break;
      case 'fail':
        emit({ id: command.id, type: 'response', command: command.type, success: false, error: 'fixture rejected command' });
        break;
      case 'hang':
        break;
      case 'crash':
        process.stderr.write('fixture crash detail\n');
        setTimeout(() => process.exit(19), 10);
        break;
      case 'event':
        emit({ type: 'fixture_event', message: '中文\u2028line\u2029paragraph' });
        reply(command);
        break;
      case 'prompt':
        emit({ type: 'agent_start' });
        reply(command);
        setTimeout(() => emit({ type: 'agent_end', messages: [], willRetry: false }), 20);
        setTimeout(() => emit({ type: 'agent_settled' }), 80);
        break;
      case 'extension_ui_response':
        emit({ type: 'fixture_ui_received', id: command.id, confirmed: command.confirmed });
        break;
      default:
        reply(command);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
