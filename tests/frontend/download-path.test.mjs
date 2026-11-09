import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchDelivery, localDownloadHeaders, LOCAL_DOWNLOAD_HEADERS } from '../../web/workbench/download-delivery.mjs';

const reply = (body, { status = 200, type = 'application/json; charset=utf-8', headers = {} } = {}) =>
  new Response(body, { status, headers: { 'content-type': type, ...headers } });

test('成品导出先写入设置目录，返回完整保存路径与文件名', async () => {
  const result = await fetchDelivery('/api/workbench/conversations/1/export?fmt=docx', 'fallback.docx', {
    saveLocal: true,
    fetcher: async (url, options) => {
      assert.equal(url, '/api/workbench/conversations/1/export?fmt=docx');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['X-Fangli-Local-Download'], '1');
      return reply(JSON.stringify({ ok: true, path: 'C:\\下载\\三洋.docx', name: '三洋.docx' }));
    },
  });
  assert.equal(result.saved, 'C:\\下载\\三洋.docx');
  assert.equal(result.name, '三洋.docx');
});

test('目录不可用时回退浏览器下载，并带出未保存的原因', async () => {
  const result = await fetchDelivery('/api/workbench/conversations/1/archive', '归档.zip', {
    saveLocal: true,
    fetcher: async () => reply('zip-bytes', { type: 'application/zip',
      headers: { 'content-disposition': 'attachment', 'x-download-error': encodeURIComponent('下载路径不可写：D:\\只读') } }),
  });
  assert.equal(result.warning, '下载路径不可写：D:\\只读');
  assert.equal(await result.blob.text(), 'zip-bytes');
});

test('后台拒绝导出时照常报错，不会静默变成浏览器下载', async () => {
  await assert.rejects(fetchDelivery('/x', 'x.docx', {
    fetcher: async () => reply(JSON.stringify({ ok: false, error: '选中的稿件仍在处理，请待当前篇收尾后导出' }), { status: 409 }),
  }), /选中的稿件仍在处理/);
});

test('局域网使用普通下载，保留服务器给出的文件名及 JSON 文件内容', async () => {
  const data = '{"articles":[]}';
  const result = await fetchDelivery('/task/export?fmt=json', 'fallback.json', {
    fetcher: async (url, options) => {
      assert.equal(url, '/task/export?fmt=json');
      assert.equal(options, undefined);
      return reply(data, { headers: { 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent('任务.json') } });
    },
  });
  assert.equal(result.name, '任务.json');
  assert.equal(await result.blob.text(), data);
  assert.deepEqual(localDownloadHeaders('192.168.5.17'), {});
  assert.deepEqual(localDownloadHeaders('127.0.0.1'), LOCAL_DOWNLOAD_HEADERS);
});
