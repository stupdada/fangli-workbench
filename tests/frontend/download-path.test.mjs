import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchDelivery, saveUrl } from '../../web/workbench/files.mjs';

const reply = (body, { status = 200, type = 'application/json; charset=utf-8', headers = {} } = {}) =>
  new Response(body, { status, headers: { 'content-type': type, ...headers } });

test('成品导出先写入设置目录，返回完整保存路径与文件名', async () => {
  const urls = [];
  const result = await fetchDelivery('/api/workbench/conversations/1/export?fmt=docx', 'fallback.docx', {
    fetcher: async url => { urls.push(url); return reply(JSON.stringify({ ok: true, path: 'C:\\下载\\三洋.docx', name: '三洋.docx' })); },
  });
  assert.equal(urls[0], '/api/workbench/conversations/1/export?fmt=docx&save=1');
  assert.equal(result.saved, 'C:\\下载\\三洋.docx');
  assert.equal(result.name, '三洋.docx');
});

test('目录不可用时回退浏览器下载，并带出未保存的原因', async () => {
  const result = await fetchDelivery('/api/workbench/conversations/1/archive', '归档.zip', {
    fetcher: async () => reply('zip-bytes', { type: 'application/zip',
      headers: { 'x-download-error': encodeURIComponent('下载路径不可写：D:\\只读') } }),
  });
  assert.equal(result.saved, null);
  assert.equal(result.warning, '下载路径不可写：D:\\只读');
  assert.equal(await result.blob.text(), 'zip-bytes');
});

test('后台拒绝导出时照常报错，不会静默变成浏览器下载', async () => {
  await assert.rejects(fetchDelivery('/x', 'x.docx', {
    fetcher: async () => reply(JSON.stringify({ ok: false, error: '选中的稿件仍在处理，请待当前篇收尾后导出' }), { status: 409 }),
  }), /选中的稿件仍在处理/);
});

test('保存参数追加在已有查询之后', () => {
  assert.equal(saveUrl('/a?fmt=md&ids=1'), '/a?fmt=md&ids=1&save=1');
  assert.equal(saveUrl('/a'), '/a?save=1');
});
