const topicKey = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function createTopicHistory(initial = []) {
  const seen = new Map(initial.filter(topic=>typeof topic === 'string' && topicKey(topic))
    .map(topic=>[topicKey(topic),topic]));
  return async (request, ids, count, keep = []) => {
    const retained = new Set(keep.filter(Boolean));
    const excluded = [...[...seen.values()].filter(topic => !retained.has(topic)), ...retained].slice(-160);
    const result = await request(excluded, count);
    const keys = new Map(seen);
    for (const topic of retained) keys.set(topicKey(topic), topic);
    const topics = Object.fromEntries(ids.map(id => {
      const values = count === 1 ? [result?.[id]] : result?.[id];
      if (!Array.isArray(values) || values.length !== count) throw new Error('选题返回不完整，请重试');
      for (const topic of values) {
        const key = typeof topic === 'string' && topicKey(topic);
        if (!key) throw new Error('选题返回不完整，请重试');
        if (keys.has(key)) throw new Error('推荐了已看过的选题，请再换一批');
        keys.set(key, topic);
      }
      return [id, values];
    }));
    for (const [key, topic] of keys) seen.set(key, topic);
    return topics;
  };
}

export class TopicChoice {
  recommended = '';
  manual = '';
  excluded = false;
  options = [];
  expanded = false;

  get topic() { return this.manual || this.recommended; }
  setRecommended(topics) {
    this.recommended = topics[0];
    this.options = topics;
  }

  setAlternatives(topics) { this.options = [this.topic,...topics]; }

  select(topic) {
    this.manual = topic;
    this.excluded = false;
  }
}
