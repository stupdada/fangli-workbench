import unittest
from bridge.creation_context import build, digest, for_article, resolve_length, section_budget


class CreationContextTests(unittest.TestCase):
    def test_explicit_ranges_allocate_summary_and_sections(self):
        for hint, expected in [('正文650—850字', [344, 344]), ('正文320—450字', [168, 167])]:
            plan = section_budget({'source': 'request', 'hint': hint})
            self.assertEqual(plan['sections'], expected)
            self.assertEqual(plan['target'], plan['summary'] + sum(plan['sections']))
        self.assertIsNone(section_budget({'source': 'request', 'hint': '正文500字以上'}))

    def test_explicit_length_over_customer_over_matching_platform_format(self):
        platform = {'length_hint': '图文 300-600 字；短视频口播 250-450 字'}
        customer = {'note': '偏好短稿，正文 350—450字'}
        explicit = {'note': '本次正文约500字', 'length_hint': '正文 520—600字'}
        self.assertEqual(resolve_length(explicit, customer, platform)['hint'], '正文 520—600字')
        self.assertEqual(resolve_length({'note': '本次正文约500字'}, customer, platform)['source'], 'request')
        self.assertEqual(resolve_length({'note': '说明真实工艺'}, customer, platform)['source'], 'customer_preference')
        self.assertEqual(resolve_length({}, {}, platform, '图文'),
                         {'hint': '图文 300-600 字', 'source': 'platform_default', 'metric': 'nonWhitespace'})

    def test_style_scope_and_digest_follow_actual_platform_and_identity(self):
        platform = {'id': 9, 'name': '头条', 'formats': ['图文'], 'length_hint': '800—1300字'}
        context = build({'id': 'new-client', 'name': '客户', 'profile': {}}, [],
                        {'selections': [{'platform_id': 9, 'account_type': 'personal', 'count': 1}]}, [platform])
        actual = for_article(context, platform, 'personal', '图文')
        style = context['style']['variants']['9:personal:图文']
        self.assertIn(style['profiles'][0]['voice'], actual['instructions'])
        self.assertEqual(style['profiles'][0]['platform'], '今日头条')
        self.assertEqual(style['expressions'], [])
        self.assertTrue(style['version'])
        self.assertTrue(all(len(s) == 64 for s in style['sources'].values()))
        self.assertIsNone(for_article(context, platform, 'official', '图文'))
        self.assertEqual(context['digest'], digest(context))
