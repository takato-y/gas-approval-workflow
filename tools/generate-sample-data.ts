/**
 * generate-sample-data.ts
 * 架空のサンプルデータ（シートごとの CSV）を作るコマンド。
 *
 * 使い方:
 *   node tools/generate-sample-data.ts [--count 20] [--seed 42] [--out sample-data]
 *                                      [--threshold 100000] [--start 2026-11-16T09:00:00+09:00]
 *                                      [--with-invalid] [--bom]
 *
 * 作った CSV は、Google スプレッドシートの「ファイル → インポート」で同名のシートに取り込める。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildSampleFiles } from './sample-data.ts';

const USAGE = '使い方: node tools/generate-sample-data.ts [--count N] [--seed N] [--out DIR] [--threshold N] [--start 日時] [--with-invalid] [--bom]';

function toPositiveInt(name: string, raw: string, max: number): number {
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) {
    throw new Error('--' + name + ' は 1〜' + max + ' の整数で指定してください（指定値: ' + raw + '）');
  }
  return Number(raw);
}

export function main(argv: string[]): number {
  let values;
  try {
    values = parseArgs({
      args: argv,
      options: {
        count: { type: 'string', default: '20' },
        seed: { type: 'string', default: '42' },
        out: { type: 'string', default: 'sample-data' },
        threshold: { type: 'string', default: '100000' },
        start: { type: 'string', default: '2026-11-16T09:00:00+09:00' },
        'with-invalid': { type: 'boolean', default: false },
        bom: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    }).values;
  } catch (e) {
    console.error((e as Error).message + '\n' + USAGE);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    const startMs = Date.parse(values.start);
    if (!Number.isFinite(startMs)) throw new Error('--start は日時で指定してください（例: 2026-11-16T09:00:00+09:00）');
    const files = buildSampleFiles({
      count: toPositiveInt('count', values.count, 1000),
      seed: toPositiveInt('seed', values.seed, 2 ** 31),
      threshold: toPositiveInt('threshold', values.threshold, 99999999),
      startMs,
      withInvalid: values['with-invalid'],
      bom: values.bom,
    });
    const outDir = resolve(values.out);
    mkdirSync(outDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(outDir, name), content, 'utf8');
    console.log('作成しました: ' + Object.keys(files).join('、') + '（出力先: ' + values.out + '）');
    return 0;
  } catch (e) {
    console.error((e as Error).message + '\n' + USAGE);
    return 1;
  }
}

// コマンドとして実行されたときだけ動かす（テストからは main を直接呼ぶ）
if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  process.exitCode = main(process.argv.slice(2));
}
