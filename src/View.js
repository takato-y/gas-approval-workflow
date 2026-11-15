/**
 * View.js
 * 承認画面・案内画面の HTML 作成（純粋ロジック）。
 * 画面に出す値はすべてエスケープする。トークンは画面内のスクリプトに文字列として埋め込む。
 */

/** HTML の特殊文字をエスケープする */
function escapeHtml_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** スクリプト内に埋め込む文字列リテラルを作る（</script> での脱出を防ぐ） */
function jsStringLiteral_(value) {
  return JSON.stringify(String(value)).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

const PAGE_STYLE = [
  'body{font-family:sans-serif;max-width:640px;margin:24px auto;padding:0 16px;line-height:1.6;color:#1f2933}',
  'table{border-collapse:collapse;width:100%}th,td{border:1px solid #cbd2d9;padding:6px 8px;text-align:left}',
  'th{background:#f0f4f8;width:30%}textarea{width:100%;box-sizing:border-box}',
  'button{font-size:16px;padding:10px 20px;margin:12px 8px 0 0;min-height:44px}',
  '#msg{margin-top:16px;font-weight:bold}',
].join('');

/** 案内だけを表示する画面 */
function renderMessagePage_(title, message) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' + PAGE_STYLE + '</style></head><body>' +
    '<h1>' + escapeHtml_(title) + '</h1><p>' + escapeHtml_(message) + '</p></body></html>';
}

/**
 * 承認・却下の確認画面。開いただけでは状態を変えず、ボタンを押したときに submitDecision を呼ぶ。
 * @param {Object} request
 * @param {number} step
 * @param {string} token
 */
function renderDecisionPage_(request, step, token) {
  const rows = [
    ['申請ID', request.id], ['申請者', request.applicant], ['部署', request.department],
    ['申請区分', request.category], ['品目・内容', request.item], ['金額', formatYen_(request.amount)],
    ['理由', request.reason], ['承認段階', step + ' / ' + request.totalSteps],
  ].map(function (r) { return '<tr><th>' + escapeHtml_(r[0]) + '</th><td>' + escapeHtml_(r[1]) + '</td></tr>'; }).join('');

  const script = [
    'var TOKEN=' + jsStringLiteral_(token) + ';',
    'function decide(type){',
    '  var comment=document.getElementById("comment").value;',
    '  if(type==="reject"&&comment.trim()===""){document.getElementById("msg").textContent="却下の理由を入力してください。";return;}',
    '  var buttons=document.querySelectorAll("button");for(var i=0;i<buttons.length;i++){buttons[i].disabled=true;}',
    '  document.getElementById("msg").textContent="処理しています…";',
    '  google.script.run',
    '    .withSuccessHandler(function(r){document.getElementById("msg").textContent=r.message;})',
    '    .withFailureHandler(function(){document.getElementById("msg").textContent="処理できませんでした。時間をおいてリンクを開き直してください。";})',
    '    .submitDecision(TOKEN,type,comment);',
    '}',
  ].join('\n');

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' + PAGE_STYLE + '</style></head><body>' +
    '<h1>申請の承認</h1><table>' + rows + '</table>' +
    '<p><label for="comment">コメント（却下の場合は必須）</label><br>' +
    '<textarea id="comment" rows="3" maxlength="' + LIMITS.COMMENT_MAX_LENGTH + '"></textarea></p>' +
    '<button type="button" onclick="decide(\'approve\')">承認する</button>' +
    '<button type="button" onclick="decide(\'reject\')">却下する</button>' +
    '<p id="msg" role="status"></p><script>' + script + '</script></body></html>';
}

/** エラーコードを利用者向けの文に置き換える（内部の詳細は画面に出さない） */
function userMessageFor_(code) {
  switch (code) {
    case 'TOKEN_EXPIRED': return 'このリンクは有効期限が切れています。督促メールの新しいリンクをお待ちください。';
    case 'TOKEN_USED':
    case 'ALREADY_DECIDED': return 'この申請は既に処理済みです。';
    case 'TOKEN_REVOKED': return 'このリンクは無効になっています。新しいメールのリンクを開いてください。';
    case 'UNAUTHORIZED_APPROVER':
    case 'IDENTITY_UNAVAILABLE': return 'この申請の承認者として確認できませんでした。会社のアカウントでログインしているか確認してください。';
    case 'COMMENT_REQUIRED': return '却下の理由を入力してください。';
    case 'BUSY': return '他の処理と重なりました。少し待ってからもう一度押してください。';
    default: return 'このリンクは無効です。';
  }
}
