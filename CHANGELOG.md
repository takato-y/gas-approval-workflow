# Changelog

このプロジェクトの主な変更を記録します。形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に従い、版の付け方は [Semantic Versioning](https://semver.org/lang/ja/) に従います。

## [Unreleased]

## [1.0.0] - 2026-11-15

### Added

- Google フォームからの申請受付と、入力の検査（金額・部署・申請区分・文字数）
- 承認ルール・設定シートによる承認経路の決定（しきい値以上は2段階、自己承認は代理承認者へ）
- HMAC-SHA256 署名・有効期限・1回限りの承認トークンと、承認者本人の確認
- HtmlService の承認確認画面（HTML・CSS・画面側の JavaScript）。2段階の確定と、確認画面ごとの確認用の値（CSRF 対策）
- 申請の状態遷移（承認済み・却下からの操作を拒否）と排他制御
- 承認依頼・結果・督促・管理者への通知メール
- 時間主導トリガーによる督促（リンクの再発行）と、上限超過時の管理者への連絡
- 監査ログ（追記のみ）とシートへの書き込み時の数式の無効化
- トリガーのイベント検証・管理者本人の確認・公開関数の許可一覧
- 架空のサンプルデータ（シート別 CSV）を作る Node.js のコマンド
- Node.js の標準テスト機能による自動テスト68件
- 設計書（要件定義・基本設計・詳細設計・権限設計・テスト仕様書・導入運用手順）と ADR 3件

### Changed

- GAS のソースを JavaScript から TypeScript に移行し、`dist/` へビルドして clasp で送る構成に変更
- 承認確認画面を、サーバー側で組み立てた HTML 文字列から HtmlService のテンプレートに変更

[Unreleased]: https://github.com/takato-y/gas-approval-workflow/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/takato-y/gas-approval-workflow/releases/tag/v1.0.0
