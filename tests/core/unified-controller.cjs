'use strict';
// Real same-origin HTTP + unchanged video controller; local storage only, no browser/renderer submit.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const UI = require('../../video/public/video-ui.js'), Content = require('../../video/public/content.js');
const out = path.resolve(__dirname, '../../../output/geo-merge-20261104/core/unified');
const fixture = JSON.parse(fs.readFileSync(path.join(out, 'controller-fixture.json'), 'utf8'));
const records = new Map(), requests = [];
const storage = {getItem: key => records.get(key) || null, setItem: (key, value) => {
  records.set(key, value); fs.writeFileSync(path.join(out, 'saved-video-draft.json'), value, 'utf8');
}};
const fetcher = async (url, init = {}) => {
  assert.ok(url.startsWith('/api/video/'));
  if ((init.method || 'GET') !== 'GET') assert.ok(['/api/video/content-imports', '/api/video/content-layouts'].includes(url), 'Paid/encoding endpoints forbidden');
  const response = await fetch(fixture.url + url, {...init, headers: {Origin: fixture.url, 'Sec-Fetch-Site': 'same-origin', ...init.headers}});
  requests.push({url, method: init.method || 'GET', status: response.status});
  return response;
};
(async () => {
  const controller = UI.createController({fetch: fetcher, storage, initialSource: {requested: true, clientId: fixture.client_id,
    article_id: fixture.article_id, version_id: fixture.version_id}});
  try {
    const resumed = process.argv.includes('--resume-saved');
    let job;
    if (resumed) {
      // importContent already persisted the successful real import/layout before the old test assertion failed.
      job = JSON.parse(fs.readFileSync(path.join(out, 'saved-video-draft.json'), 'utf8')).jobs[0];
      assert.equal(job.bodyNeedsPagination, false);
    } else {
      await controller.initialize();
      assert.ok(controller.state.config.rendererAvailable);
      job = controller.job();
    }
    const expected = Content.partition(fixture.expected_body);
    assert.equal(job.originalText, expected.displayBody);
    assert.equal(Content.canon(job.segments.map(s => s.text).join('')), Content.canon(expected.displayBody));
    assert.deepEqual(job.source, {article_id: fixture.article_id, version_id: fixture.version_id});
    assert.equal(job.editorial.originalMarkdown, fixture.expected_body);
    assert.deepEqual(job.editorial.provenance.structured, fixture.expected_provenance.zip_data);
    assert.equal(job.editorial.provenance.rawGeneration, fixture.expected_provenance.raw_generation);
    assert.equal(job.editorial.provenance.rawAudit, fixture.expected_provenance.raw_audit);
    if (!resumed) controller.persist();
    const saved = JSON.parse(fs.readFileSync(path.join(out, 'saved-video-draft.json'), 'utf8')).jobs[0];
    assert.deepEqual(saved.segments, job.segments);
    assert.equal(saved.source.version_id, fixture.version_id);
    assert.equal(saved.originalText, job.originalText);
    if (!resumed) {
      assert.equal(requests.filter(r => r.url === '/api/video/content-layouts').length, 1);
      assert.ok(requests.every(r => r.status === 200));
    }
    const result = {ok: true, method: 'unchanged Node video controller over real unified HTTP; local draft save, no browser',
      full_display_body_equal: true, source_version_fixed: fixture.version_id, old_structured_only_provenance: true,
      screens: job.segments.length, duration_seconds: UI.duration(job).seconds, saved_segments_equal: true,
      requests, resumed_persisted_live_result: resumed,
      fixture_correction: resumed ? 'source intentionally stores identity only; full Markdown/provenance live in editorial. Reused already-persisted real HTTP import + font layout; did not issue them again.' : null,
      model_calls: 0, catalog_calls: 0, encodes: 0};
    fs.writeFileSync(path.join(out, 'controller-summary.json'), JSON.stringify(result, null, 2), 'utf8');
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    // Restore the adopted version that existed before this protocol-only manual edit.
    const response = await fetch(fixture.url + '/api/workbench/conversations/' + fixture.conversation_id + '/articles/' + fixture.article_id + '/select-version',
      {method: 'POST', headers: {Origin: fixture.url, 'Content-Type': 'application/json'}, body: JSON.stringify({expected_version: fixture.version_id, version_id: fixture.restore_version})});
    assert.equal(response.status, 200); assert.equal((await response.json()).article.current_version, fixture.restore_version);
  } finally {controller.destroy();}
})().catch(error => {process.stderr.write(String(error.stack) + '\n'); process.exitCode = 1;});
