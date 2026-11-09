import unittest
from bridge.checks import article_length
from bridge.creation_context import build, digest, for_article, platform_preference, resolve_length, section_budget


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
        self.assertEqual(resolve_length({'length_hint': '短篇'}, customer, platform, '图文')['hint'], '正文 300—450 字')
        self.assertEqual(resolve_length({'length_hint': '长篇'}, customer, platform, '短视频')['hint'], '正文 351—450 字')

    def test_length_limits_and_platform_preference_use_effective_inputs(self):
        target = resolve_length({'note': '正文不超过 20 字'}, {}, {'length_hint': '300—500 字'})
        self.assertEqual(target['hint'], '正文不超过 20 字')
        self.assertLess(section_budget(target)['target'], 20)
        body = '# 标题\n\n## 条件\n\n- **确认样件**\n\n#标签\n\n声明：含AI生成内容'
        self.assertEqual(article_length(body, target)['actual'], 6)
        self.assertEqual(article_length(body, target)['status'], 'within')
        self.assertEqual(article_length(body.replace('确认样件', '要' * 20), target)['status'], 'above')
        self.assertNotIn('status', article_length(body, {**target, 'source': 'platform_default'}))

        targets = [{'name':'低档目标', 'id':1, 'enabled':True}, {'name':'无配置目标', 'id':2, 'enabled':True}]
        prefs = [{'model_id':1, 'platform_id':9, 'level':'low'}, {'model_id':2, 'platform_id':8, 'level':'high'}]
        result = platform_preference(9, ['低档目标', '无配置目标'], targets, prefs)
        self.assertEqual([target['level'] for target in result['targets']], ['low', 'mid'])
        self.assertEqual(result['level'], 'mid')
        self.assertEqual(platform_preference(9, [], targets, prefs), {'level':'mid', 'targets':[]})

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
