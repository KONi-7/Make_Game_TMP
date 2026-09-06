# 課題・締め切り管理アプリ

学生向けの課題管理アプリです。課題の締切日、通知日、優先度、完了状態、科目、種類、メモを管理できます。

## 主な機能

- 課題の登録、編集、削除
- 締切日、通知日、優先度、完了状態の管理
- 科目と種類による分類
- 並び替え、絞り込み、検索
- localStorage への課題保存
- 通知日を迎えた未完了課題の Web Push 通知

## 通知について

通知を受け取るには、アプリを HTTPS で開き、画面上の通知設定を「通知ON」にしてください。

通知ON の状態で未完了課題の通知日を迎えると、登録済みのブラウザ購読に Web Push 通知が送信されます。通知日が未設定の場合は、締切日を通知日として扱います。完了済み課題には通知されません。

ブラウザや OS 側で通知がブロックされている場合は、アプリ側で通知ONにしていても通知は表示されません。

## 環境変数

Web Push を送信するには VAPID キーが必要です。`.env.local` などに以下を設定してください。

```env
NEXT_PUBLIC_VAPID_PUBLIC_KEY=your_public_key
VAPID_PRIVATE_KEY=your_private_key
VAPID_SUBJECT=mailto:your-email@example.com
```

`VAPID_SUBJECT` は任意です。未設定の場合は既定値が使われます。

## ローカル起動

依存関係をインストールします。

```bash
npm install
```

通知機能を確認する場合は HTTPS で起動してください。

```bash
npm run dev:https
```

起動後、以下の URL を開きます。

```text
https://localhost:3001
```

自己署名証明書を使うため、ブラウザで警告が表示される場合があります。

通常の開発サーバーは以下でも起動できますが、通知確認には HTTPS 起動を使用してください。

```bash
npm run dev
```

## 開発用コマンド

```bash
npm test
npm run build
```

## 技術構成

| 項目 | 技術 |
| --- | --- |
| フロントエンド | Next.js |
| 言語 | TypeScript |
| UI | Tailwind CSS |
| 通知 | Web Push |
