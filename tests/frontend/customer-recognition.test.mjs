import assert from 'node:assert/strict';
import test from 'node:test';
import { CustomerClient, importCustomerFile } from '../../web/workbench/customers-client.mjs';
import { RecognitionReview } from '../../web/workbench/customer-recognition.mjs';
import { CustomerImport } from '../../web/workbench/customer-import.mjs';

test('客户资料导入将 PDF 和 HEIC 原件交给本机识别，不预先提取浏览器文字', async () => {
  const uploads = [];
  const service = new CustomerClient(async (path, method, body) => {
    if (path.endsWith('/check')) return {candidates:[]};
    assert.equal(method,'POST');
    uploads.push(body);
    return {outcome:'pending',document:{id:'pending',has_recognition:true}};
  });
  for (const filename of ['样张.pdf','样张.HEIC']) {
    const result = await importCustomerFile(service,'client',new File(['测试原件'],filename),null,{recognize:true});
    assert.equal(result.outcome,'pending');
  }
  assert.deepEqual(uploads.map(({filename, recognize, text, content_b64}) =>
    [filename,recognize,text,Buffer.from(content_b64,'base64').toString('utf8')]), [
    ['样张.pdf',true,undefined,'测试原件'],
    ['样张.HEIC',true,undefined,'测试原件']
  ]);
});

test('暂停后只续识别剩余页，失败页经人工选择后才提交整份资料', async () => {
  const pages = [{page:1,status:'waiting',text:''},{page:2,status:'waiting',text:''}];
  const requests = [];
  const service = {
    recognition: async () => ({pages:structuredClone(pages),images:[]}),
    async retryDocument(_client, _document, payload) {
      requests.push(payload);
      if (payload.pages) return {document:{id:'confirmed',status:'ready'}};
      const [page] = payload.retry_pages;
      pages[page - 1] = page === 1 ? {page,status:'ready',text:'识别结果'} : {page,status:'error',text:''};
      return {document:{id:'pending',status:'pending'}};
    }
  };
  const review = new RecognitionReview(service,'client',{id:'pending'},await service.recognition());
  review.selectPage = page => { review.currentPage = page; };
  const progress = [];
  const recordProgress = (done,total) => progress.push([done,total]);
  await review.processWaiting(recordProgress, () => requests.length === 1);
  assert.deepEqual(review.waiting.map(page => page.page),[2]);
  review.remember(1,'人工校对后的结果');
  await review.processWaiting(recordProgress);
  assert.deepEqual(progress,[[0,2],[1,2],[1,2],[2,2]]);
  await assert.rejects(review.confirm(),/请补录第 2 页/);
  assert.equal(review.currentPage,2);
  assert.deepEqual(requests,[{retry_pages:[1]},{retry_pages:[2]}]);
  review.remember(2,'');
  const saved = await review.confirm();
  assert.equal(saved.id,'confirmed');
  assert.deepEqual(requests.at(-1),{pages:[{page:1,text:'人工校对后的结果'},{page:2,text:''}]});
});

test('确认最后一份 OCR 资料后，按确认后的修订直接整理档案', async t => {
  const recognized = {id:'confirmed',status:'ready',text:'校对后的正文'};
  const next = {id:'second',status:'pending',has_recognition:true};
  const cases = [
    {name:'最后一份有正文',documents:[recognized],expected:[['intake',['confirmed']]],stage:'review'},
    {name:'还有待核对文件',documents:[recognized,next],expected:[['recognition','second']],stage:'recognition'},
    {name:'还有文件待重传',documents:[recognized],missingFiles:[{name:'待重传.pdf'}],expected:[],stage:'files'},
    {name:'只有原件和图片',documents:[{...recognized,text:''}],expected:[],stage:'files'},
    {name:'还有未解析文件',documents:[recognized,{id:'unparsed',status:'pending'}],expected:[],stage:'files'},
  ];
  for (const {name,documents,missingFiles = [],expected,stage} of cases) {
    await t.test(name, async () => {
      const calls = [];
      const flow = {
        id:'client',stage:'recognition',files:[],text:'',missingFiles,
        recognition:{report:{pages:[{page:1}]},waiting:[],async confirm() { calls.push(['confirm']); }},
      };
      const importer = Object.assign(Object.create(CustomerImport.prototype), {
        flow,
        intake:{async start(_client, ids) { calls.push(['intake', ids]); }},
        platformSelections() {},
        showFiles() { flow.stage = 'files'; },
        async refreshDocuments() { flow.documents = documents; },
        async openRecognition(doc) { flow.stage = 'recognition'; calls.push(['recognition', doc.id]); },
        rememberDraft() {},
        setProgress() {},
      });
      await importer.advance();
      assert.deepEqual(calls,[['confirm'],...expected]);
      assert.equal(flow.stage,stage);
    });
  }
});
