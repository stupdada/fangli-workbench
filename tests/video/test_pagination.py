"""Two focused, real-font regression cases for video-003. No cloud or encoder."""
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import unittest

BASE = Path(__file__).resolve().parents[2]
OUT = BASE.parent / 'output/geo-merge-20261104/video/pagination-003'
spec = importlib.util.spec_from_file_location('video_layout', BASE / 'video/runtime/layout.py')
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)


def canon(value): return re.sub(r'\s', '', value)
def sha(file):
    result = hashlib.sha256()
    with file.open('rb') as source:
        for part in iter(lambda: source.read(1048576), b''): result.update(part)
    return result.hexdigest()


class PaginationRegression(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.inputs = json.loads((OUT / 'inputs.json').read_text(encoding='utf-8'))
        cls.old = json.loads((OUT / 'old-results.json').read_text(encoding='utf-8'))
        cls.results = {value['id']: layout.paginate(value) for value in cls.inputs}
        cls.checks = []

    def check_pages(self, value, result):
        self.assertEqual(canon(''.join(p['text'] for p in result['segments'])), canon(value['body']))
        frames = 0
        for page in result['segments']:
            image, displayed, box = layout.renderer.text_layout(page['text'], value['width'], value['height'], value['textStyle'])
            try:
                self.assertEqual(canon(displayed), canon(page['text']))
                self.assertLessEqual(box['lines'], 2)
                self.assertGreaterEqual(box['x'], 0)
                self.assertGreaterEqual(box['y'], 0)
                self.assertLessEqual(box['x'] + box['width'], value['width'])
                self.assertLessEqual(box['y'] + box['height'], value['height'])
            finally: image.close()
            expected = math.ceil(max(3, value['minimumSeconds'], len(canon(page['text'])) / 3.5) * 25)
            self.assertEqual(round(page['durationSeconds'] * 25), expected)
            frames += expected
        self.assertEqual(result['durationSeconds'], frames / 25)
        self.assertLessEqual(result['durationSeconds'], 600)
        self.assertLessEqual(len(result['segments']), 100)

    def test_archived_full_text_font_bounds_and_tail_readability(self):
        baseline = json.loads((OUT / 'baseline.json').read_text(encoding='utf-8'))
        self.assertEqual(sha(layout.renderer.font_file()), baseline['font']['sha256'])
        for value in self.inputs:
            result = self.results[value['id']]
            self.check_pages(value, result)
            self.checks.append({'id': value['id'], 'allPagesRealFontMeasured': True,
                'fullBodyUnchanged': True, 'characters': len(canon(value['body'])),
                'screenCount': result['screenCount'], 'durationSeconds': result['durationSeconds']})
        pet = self.results['pet']['segments']
        self.assertIn('合同条款。', pet[-1]['text'])
        self.assertNotIn(pet[-1]['text'], ('款。', '。'))
        self.assertGreater(len(canon(pet[-1]['text'])), 3)
        industrial = self.results['industrial']['segments']
        self.assertTrue(any('装模成型' in p['text'] for p in industrial[-3:]))
        for previous, current in zip(industrial, industrial[1:]):
            self.assertFalse(previous['text'].endswith('装') and current['text'].startswith('模成型'))
        self.assertEqual([p['text'] for p in self.results['manual']['segments']], [p['text'] for p in self.old['manual']['segments']])
        for artifact in baseline['protectedArtifacts']:
            self.assertEqual(sha(Path(artifact['path'])), artifact['sha256'])

    def test_orphans_punctuation_atoms_and_genuine_short_ending(self):
        template = self.inputs[-1]
        texts = {
            'minimal-real-defect': '新手到店可直接要求翻看记录单并逐条指认合同条款。',
            'punctuation-tail': '甲乙丙丁戊己庚辛壬癸甲乙丙丁戊己庚辛壬癸甲乙。',
            'independent-short-ending': '甲乙丙丁戊己庚辛壬癸甲乙丙丁戊己庚辛壬癸甲。好。',
            'technical-atoms': '请先确认CILBOND24的型号，再核对15—20μm干膜厚度与120—230°C的成型条件。最后按约定操作。',
        }
        cases = {}
        for name, body in texts.items():
            value = {**template, 'id': name, 'body': body}
            result = layout.paginate(value)
            self.check_pages(value, result)
            cases[name] = result
        self.assertIn('合同条款。', cases['minimal-real-defect']['segments'][-1]['text'])
        self.assertTrue(all(re.search(r'[\w]', page['text']) for page in cases['punctuation-tail']['segments']))
        self.assertEqual(cases['independent-short-ending']['segments'][-1]['text'], '好。')
        for atom in ('CILBOND24', '15—20μm', '120—230°C'):
            self.assertTrue(any(atom in page['text'] for page in cases['technical-atoms']['segments']))
        for result in cases.values():
            for page in result['segments']:
                self.assertNotIn(page['text'][0], layout.CLOSING)
        (OUT / 'focused-edge-results.json').write_text(json.dumps(cases, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    @classmethod
    def tearDownClass(cls):
        from PIL import Image, ImageDraw, ImageFont
        frames = OUT / 'previews'; frames.mkdir(exist_ok=True)
        font = ImageFont.truetype(str(layout.renderer.font_file()), 18)
        tiles = []
        comparisons = []
        for value in cls.inputs:
            ident = value['id']
            sides = {}
            for side, result in [('old', cls.old[ident]), ('new', cls.results[ident])]:
                last = []
                for index in range(max(0, len(result['segments']) - 3), len(result['segments'])):
                    page = result['segments'][index]
                    overlay, displayed, box = layout.renderer.text_layout(page['text'], value['width'], value['height'], value['textStyle'])
                    background = Image.new('RGBA', overlay.size, '#aab0b9')
                    background.alpha_composite(overlay); overlay.close()
                    file = frames / f'{ident}-{side}-{index+1}.png'
                    background.convert('RGB').save(file)
                    tile = Image.new('RGB', (250, 500), '#f5f6f8')
                    thumb = background.convert('RGB'); thumb.thumbnail((230, 409)); background.close()
                    tile.paste(thumb, (10, 10)); thumb.close()
                    draw = ImageDraw.Draw(tile)
                    draw.text((10, 428), f'{ident} {side} #{index+1}', font=font, fill='#292b31')
                    draw.text((10, 455), str(page['durationSeconds']) + 's', font=font, fill='#292b31')
                    tiles.append(tile)
                    last.append({'page': index+1, 'text': page['text'], 'durationSeconds': page['durationSeconds'], 'layout': box, 'displayed': displayed, 'preview': str(file)})
                sides[side] = {'screenCount': result['screenCount'], 'durationSeconds': result['durationSeconds'], 'tail': last}
            comparisons.append({'id': ident, **sides})
        sheet = Image.new('RGB', (1500, 1500), '#f5f6f8')
        # A row per source, old last 3 on the left and new last 3 on the right.
        cursor = 0
        for row, value in enumerate(cls.inputs):
            for side_index, source in enumerate((cls.old[value['id']], cls.results[value['id']])):
                count = min(3, len(source['segments']))
                for column in range(count):
                    tile = tiles[cursor]; cursor += 1
                    sheet.paste(tile, (side_index * 750 + column * 250, row * 500)); tile.close()
        sheet.save(OUT / 'tail-comparison.jpg', quality=94); sheet.close()
        for name, value in [('new-results.json', cls.results), ('tail-comparison.json', comparisons)]:
            (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        (OUT / 'focused-verification.json').write_text(json.dumps({'checks': cls.checks, 'modelCalls': 0, 'directoryCalls': 0, 'encoderCalls': 0, 'newVideoBatches': 0, 'note': 'layout previews only; old 169.12-second MP4 and original SRT/source files kept byte-identical'}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__': unittest.main(verbosity=2)
