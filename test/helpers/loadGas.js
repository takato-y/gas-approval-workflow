/**
 * loadGas.js
 * src/*.js を GAS と同じく「1つのグローバル空間」に読み込むテスト用の読み込み器。
 * GAS のサービス（SpreadsheetApp 等）は引数 globals で偽物を差し込む。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC_DIR = path.join(__dirname, '..', '..', 'src');

/** GAS は読み込み順を保証しないため、依存の少ない順に読む（実行時の呼び出しは順序に依存しない） */
const LOAD_ORDER = [
  'Config.js',
  'Routing.js',
  'Token.js',
  'StateMachine.js',
  'Reminder.js',
  'Repository.js',
  'Notifier.js',
  'Guard.js',
  'Main.js',
];

/**
 * @param {Object} [globals] 差し込むグローバル（GAS サービスの偽物など）
 * @return {{ctx: Object, get: function(string): *}} ctx は関数宣言を持つ。get は const 等の参照用
 */
function loadGas(globals) {
  const ctx = vm.createContext(Object.assign({ console: console }, globals || {}));
  LOAD_ORDER.forEach(function (file) {
    const full = path.join(SRC_DIR, file);
    if (!fs.existsSync(full)) return;
    vm.runInContext(fs.readFileSync(full, 'utf8'), ctx, { filename: file });
  });
  return {
    ctx: ctx,
    get: function (name) { return vm.runInContext(name, ctx); },
  };
}

module.exports = { loadGas, SRC_DIR, LOAD_ORDER };
