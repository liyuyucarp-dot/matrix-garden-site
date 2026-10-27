// B站鲸鱼 · 爱看/不爱看关键词多行编辑
// 原生设置弹窗对 type:"textarea" 只渲染单行 input，换行会被吞；这里用真正的 textarea，
// 保存仍写回同一项 likeKeywords / dislikeKeywords 设置。

const $ = (id) => document.getElementById(id);

function setStatus(text, tone = '') {
  const box = $('status');
  box.className = `persona-status ${tone}`.trim();
  box.textContent = text || '';
}

function setText(id, text) {
  const el = $(id);
  if (el.value !== String(text ?? '')) el.value = String(text ?? '');
}

async function load() {
  setStatus('读取关键词…', 'busy');
  try {
    const res = await fetch('../@data/storage.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const db = raw?.db || raw || {};
    const s = db.meta?.settings || {};
    setText('like', s.likeKeywords || '');
    setText('dislike', s.dislikeKeywords || '');
    $('updated').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    setStatus('已读取。改完点「保存关键词」。', '');
  } catch (error) {
    setStatus(`读取失败：${String(error?.message || error)}`, 'bad');
  }
}

async function save() {
  const like = $('like').value.replace(/\r\n?/g, '\n').trim();
  const dislike = $('dislike').value.replace(/\r\n?/g, '\n').trim();
  setStatus('保存中…', 'busy');
  try {
    const res = await fetch('/api/skills/bili-whale', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { likeKeywords: like, dislikeKeywords: dislike } })
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    const likeCount = like.split(/\n+/).map((x) => x.trim()).filter(Boolean).length;
    const dislikeCount = dislike.split(/\n+/).map((x) => x.trim()).filter(Boolean).length;
    setStatus(`已保存：爱看 ${likeCount} 条，不爱看 ${dislikeCount} 条。下一轮选题生效。`, 'ok');
  } catch (error) {
    setStatus(`保存失败：${String(error?.message || error)}`, 'bad');
  }
}

$('save').addEventListener('click', save);
$('refresh').addEventListener('click', load);
load();
