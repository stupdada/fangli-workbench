from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'video' / 'narrated'))
from renderer import silent_durations, stamp, timeline


class PageTimingTest(unittest.TestCase):
    def test_silent_pages_with_uneven_copy_keep_a_readable_hold(self):
        words = ['开始。', '说明' * 18, '准备' * 18, '沟通' * 18, '完成' * 18]
        draft = {'script': {'paragraphs': [{'text': word} for word in words]}}
        durations = silent_durations(draft)
        self.assertAlmostEqual(sum(durations), 36)
        self.assertTrue(all(duration >= 4 for duration in durations))

    def test_audio_segment_boundaries_are_shared_by_captions(self):
        draft = {'pages': [{'id': 'p1'}, {'id': 'p2'}], 'script': {'paragraphs': [{'text': '第一段。'}, {'text': '第二段。'}]}}
        first, second = timeline(draft, [7.7185, 8.3184])
        self.assertEqual(first['end'], second['start'])
        self.assertEqual(stamp(second['end']), '00:00:16,037')
        self.assertEqual(second['text'], '第二段。')


if __name__ == '__main__':
    unittest.main()
