/**
 * loadGas.ts
 * ビルド済みの dist/*.js（clasp で push するものと同じファイル）を、
 * GAS と同じく「1つのグローバル空間」に読み込むテスト用の読み込み器。
 * GAS のサービス（SpreadsheetApp 等）は引数 globals で偽物を差し込む。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export const ROOT_DIR = path.join(import.meta.dirname, '..', '..');
export const DIST_DIR = path.join(ROOT_DIR, 'dist');
export const SRC_DIR = path.join(ROOT_DIR, 'src');

/** GAS は読み込み順を保証しないため、依存の少ない順に読む（実行時の呼び出しは順序に依存しない） */
export const LOAD_ORDER = [
  'Types.js',
  'Config.js',
  'Routing.js',
  'Token.js',
  'StateMachine.js',
  'Reminder.js',
  'Repository.js',
  'Notifier.js',
  'Guard.js',
  'View.js',
  'Main.js',
];

/** vm 内の関数は型が付かないため any で扱う */
export type GasContext = Record<string, any>;

export interface LoadedGas {
  ctx: GasContext;
    get: (name: string) => any;
}

export function loadGas(globals?: Record<string, unknown>): LoadedGas {
  if (!fs.existsSync(path.join(DIST_DIR, 'Main.js'))) {
    throw new Error('dist/ がありません。先に npm run build を実行してください');
  }
  const ctx = vm.createContext(Object.assign({ console }, globals || {})) as GasContext;
  for (const file of LOAD_ORDER) {
    const full = path.join(DIST_DIR, file);
    if (!fs.existsSync(full)) continue;
    vm.runInContext(fs.readFileSync(full, 'utf8'), ctx, { filename: file });
  }
  return { ctx, get: (name: string) => vm.runInContext(name, ctx) };
}
