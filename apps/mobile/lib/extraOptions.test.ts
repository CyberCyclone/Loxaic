import { describe, expect, it } from 'vitest';
import type { LlamaOptionInfo } from '@loxaic/api-client';
import { cleanKey, rowHint, rowProblems, rowsToSave, sameOptions } from './extraOptions';

const options: LlamaOptionInfo[] = [
  { names: ['keep'], takesValue: true, description: 'number of tokens to keep', reserved: null },
  { names: ['metrics'], takesValue: false, description: 'enable metrics', reserved: null },
  { names: ['cb', 'cont-batching', 'nocb', 'no-cont-batching'], takesValue: false, description: 'continuous batching', reserved: null },
  { names: ['port'], takesValue: true, description: 'port to listen', reserved: 'Loxaic runs the llama.cpp router with this itself.' },
];

describe('rowProblems', () => {
  it('passes good rows and blank ones', () => {
    expect(rowProblems([{ key: '--keep', value: '64' }, { key: 'metrics', value: 'TRUE' }, { key: '', value: '' }], options)).toEqual([null, null, null]);
  });

  it('says what is wrong with each row, in the server\'s words', () => {
    expect(
      rowProblems(
        [
          { key: 'mlock', value: 'true' },
          { key: 'port', value: '1' },
          { key: 'metrics', value: 'yes' },
          { key: 'keep', value: ' ' },
          { key: 'a b', value: '1' },
          { key: '', value: '1' },
        ],
        options,
      ),
    ).toEqual([
      'This llama.cpp build has no option "mlock"',
      '"port" can\'t be set here. Loxaic runs the llama.cpp router with this itself.',
      '"metrics" is a switch: its value is true or false',
      '"keep" needs a value',
      '"a b" is not an option name',
      "Type the option's name",
    ]);
  });

  it('catches one option set twice under two of its names', () => {
    expect(rowProblems([{ key: 'cb', value: 'true' }, { key: 'no-cont-batching', value: 'true' }], options)[1]).toBe(
      '"no-cont-batching" is the same option as "cb", set above',
    );
    expect(rowProblems([{ key: 'keep', value: '1' }, { key: 'keep', value: '2' }], options)[1]).toBe('"keep" is set twice');
  });

  it('lets a stored row the build does not know stand as it is, and nothing else', () => {
    const kept = [{ key: 'bogus', value: '1' }];
    expect(rowProblems([{ key: 'bogus', value: '1 ' }], options, kept)).toEqual([null]);
    expect(rowProblems([{ key: 'bogus', value: '2' }], options, kept)).toEqual(['This llama.cpp build has no option "bogus"']);
    expect(rowProblems([{ key: 'bogus', value: '1' }], options)).toEqual(['This llama.cpp build has no option "bogus"']);
  });

  it('judges only the shape of a key when the build could not be asked', () => {
    expect(rowProblems([{ key: 'anything', value: '' }, { key: 'a=b', value: '1' }], null)).toEqual([null, '"a=b" is not an option name']);
  });
});

describe('rows as they are saved', () => {
  it('drops blank rows and dashes, and trims values', () => {
    expect(rowsToSave([{ key: ' --keep ', value: ' 64 ' }, { key: ' ', value: '' }])).toEqual([{ key: 'keep', value: '64' }]);
    expect(cleanKey('---x')).toBe('x');
  });

  it('compares what would be saved, not what is typed', () => {
    expect(sameOptions([{ key: '--keep', value: '64 ' }, { key: '', value: '' }], [{ key: 'keep', value: '64' }])).toBe(true);
    expect(sameOptions([{ key: 'keep', value: '64' }], [{ key: 'keep', value: '65' }])).toBe(false);
  });
});

describe('rowHint', () => {
  it('says what a known option does, and that a switch takes true or false', () => {
    expect(rowHint({ key: 'keep', value: '' }, options)).toBe('number of tokens to keep');
    expect(rowHint({ key: 'metrics', value: '' }, options)).toBe('enable metrics · a switch: true or false');
    expect(rowHint({ key: 'port', value: '' }, options)).toBeNull();
    expect(rowHint({ key: 'nope', value: '' }, options)).toBeNull();
  });
});
