'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildCGMinerCommand } = require('../bridge/MinerProxy');

describe('MinerProxy', () => {
  it('maps reboot action to ascset command', () => {
    const cmd = buildCGMinerCommand('reboot', {});
    assert.deepStrictEqual(cmd, { command: 'ascset', parameter: '0,reboot,1' });
  });

  it('maps restart action', () => {
    const cmd = buildCGMinerCommand('restart', {});
    assert.deepStrictEqual(cmd, { command: 'restart' });
  });

  it('maps softoff with epoch parameter', () => {
    const cmd = buildCGMinerCommand('softoff', { epoch: '1700000000' });
    assert.deepStrictEqual(cmd, { command: 'ascset', parameter: '0,softoff,1:1700000000' });
  });

  it('maps softon with epoch parameter', () => {
    const cmd = buildCGMinerCommand('softon', { epoch: '1700000000' });
    assert.deepStrictEqual(cmd, { command: 'ascset', parameter: '0,softon,1:1700000000' });
  });

  it('maps setFrequency with mhz parameter', () => {
    const cmd = buildCGMinerCommand('setFrequency', { mhz: '600' });
    assert.deepStrictEqual(cmd, { command: 'ascset', parameter: '0,freq,600' });
  });

  it('maps setWorkMode with mode parameter', () => {
    const cmd = buildCGMinerCommand('setWorkMode', { mode: '1' });
    assert.deepStrictEqual(cmd, { command: 'ascset', parameter: '0,workmode,1' });
  });

  it('passes unknown action as raw command', () => {
    const cmd = buildCGMinerCommand('pools', {});
    assert.deepStrictEqual(cmd, { command: 'pools' });
  });
});
