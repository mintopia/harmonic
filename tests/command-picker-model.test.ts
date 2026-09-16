import { describe, expect, it } from 'vitest';
import { commandPickerState } from '../web/src/components/conversation/command-picker-model.js';

const commands = [
  { name: 'help', description: 'Show help' },
  { name: 'handoff', description: 'Hand work off' },
  { name: 'status', description: 'Show status' },
];

describe('command picker trigger (#613)', () => {
  it('opens at whitespace boundaries and filters command names without treating paths as commands', () => {
    expect(commandPickerState('/ha', 3, '/', commands)).toEqual({ start: 0, end: 3, commands: [commands[1]] });
    expect(commandPickerState('ask /', 5, '/', commands)).toEqual({ start: 4, end: 5, commands });
    expect(commandPickerState('ask\t/st', 7, '/', commands)).toEqual({ start: 4, end: 7, commands: [commands[2]] });
    expect(commandPickerState('src/foo', 7, '/', commands)).toBeNull();
  });

  it('uses the harness prefix and closes when a query has no match or ends with whitespace', () => {
    expect(commandPickerState('$st', 3, '$', commands)).toEqual({ start: 0, end: 3, commands: [commands[2]] });
    expect(commandPickerState('/missing', 8, '/', commands)).toBeNull();
    expect(commandPickerState('/help ', 6, '/', commands)).toBeNull();
  });

  it('tracks the whole token when the caret is in its middle', () => {
    expect(commandPickerState('/status', 3, '/', commands)).toEqual({ start: 0, end: 7, commands: [commands[2]] });
  });
});
