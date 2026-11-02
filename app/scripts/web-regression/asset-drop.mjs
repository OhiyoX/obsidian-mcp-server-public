// U30: real-Chromium coverage for in-place image drop upload (contract A1/A4).
//
// Registered by scripts/web-regression.mjs (one line, like the other domain modules). It drives
// the real drop path with a real `DataTransfer` on the shared page: the highlight, the per-file
// progress rows, the inserted wikilink embed, the read-back `GET`, the undo boundary and the
// reader's drop refusal. It never touches another scenario's assertions.
import assert from 'node:assert/strict';

// A real 1x1 PNG so the server's magic-number check and the read-back are genuine.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const READER_SURFACE = '#preview .markdown-preview-view';

// Dispatches dragenter -> dragover -> drop on a real element with a real DataTransfer and
// reports whether each event was cancelled (`dispatchEvent` returns false when preventDefault ran).
async function dispatchDrop(page, { selector, files = [], textTypes = [], x, y }) {
  return page.evaluate(({ selector, files, textTypes, x, y, png }) => {
    const target = document.querySelector(selector);
    if (!target) throw new Error(`missing drop target ${selector}`);
    const transfer = new DataTransfer();
    for (const file of files) {
      const bytes = file.png ? Uint8Array.from(atob(png), (char) => char.charCodeAt(0)) : new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      transfer.items.add(new File([bytes], file.name, { type: file.type || 'application/octet-stream' }));
    }
    for (const type of textTypes) transfer.setData(type, 'dragged text');
    const event = (type) => new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: transfer });
    const enter = target.dispatchEvent(event('dragenter'));
    const over = target.dispatchEvent(event('dragover'));
    const highlighted = target.classList.contains('cm-asset-drop-active');
    const outlined = Boolean(target.style.outline);
    const drop = target.dispatchEvent(event('drop'));
    return { enter, over, drop, highlighted, outlined };
  }, { selector, files, textTypes, x, y, png: PNG_BASE64 });
}

const rows = (page) => page.evaluate(() => Array.from(document.querySelectorAll('.cm-asset-drop-row')).map((row) => ({
  name: row.dataset.assetRow,
  done: row.classList.contains('is-done'),
  error: row.querySelector('.cm-asset-drop-error')?.textContent || null,
  bar: row.querySelector('.cm-asset-drop-progress > i')?.style.width || '',
})));

// Coordinates at the centre of the character at `pos`, so the drop point is unambiguous.
const coordsForPos = (page, pos) => page.evaluate((pos) => {
  const view = window.__testEditor._view;
  const rect = view.coordsAtPos(pos);
  return { x: Math.round((rect.left + rect.right) / 2), y: Math.round((rect.top + rect.bottom) / 2) };
}, pos);

async function readAsset(page, path, from) {
  return page.evaluate(async ({ path, from }) => {
    const response = await fetch(`/api/web/v1/asset?path=${encodeURIComponent(path)}&from=${encodeURIComponent(from)}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, type: response.headers.get('content-type'), length: bytes.length, head: Array.from(bytes.slice(0, 8)) };
  }, { path, from });
}

export async function registerAssetDropChecks(ctx) {
  const { check, sleep, page, open, mode, vault } = ctx;
  const source = 'alpha line\nbravo line\n';

  await check('WEB-ASSET-01 image drop highlights, uploads in place, inserts an embed and survives undo', async () => {
    await open('A.md');
    await mode('raw');
    await page.evaluate((text) => {
      window.__testEditor.setValue(text, { resetHistory: true, silent: true });
      window.__testEditor.scrollToPosition(0);
    }, source);
    await sleep(120);
    assert.equal(await page.evaluate(() => window.__testEditor.getValue()), source);

    const { x, y } = await coordsForPos(page, 3);
    const outcome = await dispatchDrop(page, { selector: '#editor .cm-editor', files: [{ name: 'drop one.png', png: true, type: 'image/png' }], x, y });
    assert.equal(outcome.enter, false, 'dragenter must be cancelled for a file drag');
    assert.equal(outcome.over, false, 'dragover must call preventDefault or the drop is never delivered');
    assert.equal(outcome.highlighted, true, 'the editor must highlight while a file is dragged over it');
    assert.equal(outcome.outlined, true, 'the highlight must be visible, not only a class');

    await page.waitForFunction(() => window.__testEditor.getValue().includes('![[attachments/'), null, { timeout: 7000 });
    const expected = `alp![[attachments/drop one.png]]ha line\nbravo line\n`;
    assert.equal(await page.evaluate(() => window.__testEditor.getValue()), expected, 'the embed must land exactly at the drop point');
    await page.waitForFunction(() => document.querySelectorAll('.cm-asset-drop-row.is-done').length === 1, null, { timeout: 7000 });

    const uploaded = await rows(page);
    assert.deepEqual(uploaded.map((row) => [row.name, row.done, row.bar]), [['drop one.png', true, '100%']], 'one completed progress row for the file');
    assert.equal(await page.evaluate(() => document.querySelector('#editor .cm-editor').classList.contains('cm-asset-drop-active')), false, 'the highlight must clear on drop');
    assert.equal(await page.evaluate(() => document.querySelector('.cm-asset-drop-notice')?.textContent || ''), '文件已上传，撤销仅移除引用。', 'the undo boundary must be stated once');
    assert.equal(await page.evaluate(() => document.querySelectorAll('.cm-asset-drop-notice').length), 1);

    // The inserted embed points at a real, readable asset with the same bytes.
    const asset = await readAsset(page, 'attachments/drop one.png', 'A.md');
    assert.deepEqual(asset, { status: 200, type: 'image/png', length: 70, head: [137, 80, 78, 71, 13, 10, 26, 10] }, JSON.stringify(asset));

    // Undo removes the reference only: one transaction, and the uploaded file stays readable.
    await page.evaluate(() => window.__testEditor._view.focus());
    await page.keyboard.press('Control+z');
    await page.waitForFunction((text) => window.__testEditor.getValue() === text, source, { timeout: 5000 });
    const afterUndo = await readAsset(page, 'attachments/drop one.png', 'A.md');
    assert.equal(afterUndo.status, 200, 'undo must not delete the uploaded file');
  });

  await check('WEB-ASSET-02 a text drag is handed back to CodeMirror and never highlights', async () => {
    await open('A.md');
    await mode('raw');
    await page.evaluate((text) => {
      window.__testEditor.setValue(text, { resetHistory: true, silent: true });
      window.__testEditor.scrollToPosition(0);
    }, source);
    await sleep(120);
    // Rows from an earlier check may still be on screen (the panel auto-closes); compare deltas.
    const beforeRows = await page.evaluate(() => document.querySelectorAll('.cm-asset-drop-row').length);
    const { x, y } = await coordsForPos(page, 3);
    const outcome = await dispatchDrop(page, { selector: '#editor .cm-editor', textTypes: ['text/plain', 'text/html'], x, y });
    assert.equal(outcome.enter, true, 'a drag without files must not be intercepted');
    assert.equal(outcome.over, true, 'a drag without files must keep its default handling');
    assert.equal(outcome.drop, true);
    assert.equal(outcome.highlighted, false, 'a text drag must not paint the upload highlight');
    await sleep(120);
    assert.equal(await page.evaluate(() => document.querySelectorAll('.cm-asset-drop-row').length), beforeRows, 'a text drag must not start an upload');
    assert.equal(await page.evaluate(() => window.__testEditor.getValue()), source, 'a text drag must not change the document');
  });

  await check('WEB-ASSET-03 a multi-file drop uploads serially, keeps order and reports the rejection', async () => {
    await open('A.md');
    await mode('raw');
    await page.evaluate((text) => {
      window.__testEditor.setValue(text, { resetHistory: true, silent: true });
      window.__testEditor.scrollToPosition(0);
    }, source);
    await sleep(120);
    const beforeRows = await page.evaluate(() => document.querySelectorAll('.cm-asset-drop-row').length);
    const beforeDone = await page.evaluate(() => document.querySelectorAll('.cm-asset-drop-row.is-done').length);
    const { x, y } = await coordsForPos(page, 3);
    await dispatchDrop(page, {
      selector: '#editor .cm-editor',
      files: [
        { name: 'multi a.png', png: true, type: 'image/png' },
        { name: 'bad.pdf', type: 'application/pdf' },
        { name: 'multi a.png', png: true, type: 'image/png' },
      ],
      x,
      y,
    });
    await page.waitForFunction((count) => document.querySelectorAll('.cm-asset-drop-row').length === count, beforeRows + 3, { timeout: 7000 });
    await page.waitForFunction((count) => document.querySelectorAll('.cm-asset-drop-row.is-done').length === count, beforeDone + 2, { timeout: 7000 });
    const multi = (await rows(page)).slice(beforeRows);
    assert.deepEqual(multi.map((row) => [row.name, row.done, row.error]), [
      ['multi a.png', true, null],
      ['bad.pdf', false, '不支持的图片类型'],
      ['multi a.png', true, null],
    ], JSON.stringify(multi));
    // Only the successful uploads are inserted, in file order; the duplicate takes `-1`.
    const text = await page.evaluate(() => window.__testEditor.getValue());
    assert.equal(text, 'alp![[attachments/multi a.png]]\n![[attachments/multi a-1.png]]ha line\nbravo line\n', JSON.stringify(text));
    for (const name of ['attachments/multi a.png', 'attachments/multi a-1.png']) {
      assert.equal((await readAsset(page, name, 'A.md')).status, 200, name);
    }
    // Nothing was written for the rejected file.
    const rejected = await page.evaluate(() => fetch('/api/web/v1/asset?path=attachments%2Fbad.pdf&from=A.md').then((response) => response.status));
    assert.equal(rejected, 404);
    await page.evaluate(() => window.__testEditor._view.focus());
    await page.keyboard.press('Control+z');
    await page.waitForFunction((value) => window.__testEditor.getValue() === value, source, { timeout: 5000 });
  });

  await check('WEB-ASSET-04 the reader surface refuses file drops without uploading or navigating', async () => {
    await open('A.md');
    await mode('preview');
    await page.waitForSelector(READER_SURFACE);
    const before = await page.evaluate(() => ({ url: location.href, text: window.__testEditor.getValue(), rows: document.querySelectorAll('.cm-asset-drop-row').length }));
    const box = await page.locator(READER_SURFACE).boundingBox();
    const outcome = await dispatchDrop(page, {
      selector: READER_SURFACE,
      files: [{ name: 'reader.png', png: true, type: 'image/png' }],
      x: Math.round(box.x + 20),
      y: Math.round(box.y + 20),
    });
    assert.equal(outcome.over, false, 'the reader must cancel dragover so the browser never navigates to the file');
    assert.equal(outcome.drop, false, 'the reader must cancel the drop');
    assert.equal(outcome.highlighted, false, 'the reader must not paint the editor upload highlight');
    await sleep(150);
    const after = await page.evaluate(() => ({ url: location.href, text: window.__testEditor.getValue(), rows: document.querySelectorAll('.cm-asset-drop-row').length }));
    assert.deepEqual(after, before, 'the reader must not navigate, insert or dirty the note, and must not upload');
    // The interceptor is an interceptor only: no upload entry point was added to the reader.
    assert.equal(await page.evaluate(() => document.querySelectorAll('#preview input[type=file], #preview .cm-asset-drop-cancel').length), 0);
    await page.evaluate(() => window.__testEditor._view.focus());
  });
}
