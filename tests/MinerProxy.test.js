'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildCGMinerCommand } = require('../bridge/MinerProxy');

describe('MinerProxy', () => {
  it('maps reboot action to raw ascset pipe form', () => {
    const cmd = buildCGMinerCommand('reboot', {});
    assert.strictEqual(cmd, 'ascset|0,reboot,0');
  });

  it('maps restart action to JSON cgminer command', () => {
    const cmd = buildCGMinerCommand('restart', {});
    assert.deepStrictEqual(cmd, { command: 'restart' });
  });

  it('maps softoff with epoch parameter to raw ascset pipe form', () => {
    const cmd = buildCGMinerCommand('softoff', { epoch: '1700000000' });
    assert.strictEqual(cmd, 'ascset|0,softoff,1:1700000000');
  });

  it('maps softon with epoch parameter to raw ascset pipe form', () => {
    const cmd = buildCGMinerCommand('softon', { epoch: '1700000000' });
    assert.strictEqual(cmd, 'ascset|0,softon,1:1700000000');
  });

  it('maps setFrequency with mhz parameter using `frequency` keyword (raw pipe form)', () => {
    const cmd = buildCGMinerCommand('setFrequency', { mhz: '600' });
    assert.strictEqual(cmd, 'ascset|0,frequency,600');
  });

  it('maps setWorkMode including the required `set,` keyword (raw pipe form)', () => {
    const cmd = buildCGMinerCommand('setWorkMode', { mode: '1' });
    assert.strictEqual(cmd, 'ascset|0,workmode,set,1');
  });

  it('maps switchPool to JSON switchpool command', () => {
    const cmd = buildCGMinerCommand('switchPool', { poolIndex: '1' });
    assert.deepStrictEqual(cmd, { command: 'switchpool', parameter: '1' });
  });

  it('passes unknown action as raw cgminer command', () => {
    const cmd = buildCGMinerCommand('pools', {});
    assert.deepStrictEqual(cmd, { command: 'pools' });
  });
});
