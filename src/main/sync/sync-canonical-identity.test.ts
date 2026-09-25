import { describe, expect, it } from 'vitest'
import {
  adoptUuidOrNull,
  articleCanonicalKey,
  feedCanonicalKey,
  relationLocalId,
  relationSyncId
} from './sync-canonical-identity'

describe('sync canonical identity v1', () => {
  it('matches the frozen Android/Desktop fixtures', () => {
    const feedKey = feedCanonicalKey('rss', ' HTTPS://Example.COM:443/feed/?utm_source=x&b=2#frag ')
    expect(feedKey).toBe('feed:v1:5db48e420506f52ed082918bb7489132f060cac350554a79696de83908b28309')
    expect(articleCanonicalKey(feedKey, 'https://EXAMPLE.com/post/42/?utm_medium=x#part'))
      .toBe('article:v1:3fe23e061e57a17896fd9bb1e52e1b9845f0c48e38c237b088ad24a5191ca789')
    expect(relationSyncId(
      'conversation_article',
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222'
    )).toBe('rel:v1:5b5f5125f29862e934c2f7e2a358f3180338d5e4db7ae7eaec6ce81b79a54955')
    expect(relationLocalId('conversation_article', 'local-conversation', 'local-article'))
      .toBe('local-rel:v1:de47eb320197d3b649d9583c67f3fae20c88862e768a8b5e23be2c9c15436508')
  })

  it('canonicalizes adopted UUIDs and refuses weak article identity', () => {
    expect(adoptUuidOrNull('123E4567-E89B-42D3-A456-426614174000')).toBe('123e4567-e89b-42d3-a456-426614174000')
    expect(adoptUuidOrNull('local-article-1')).toBeNull()
    expect(articleCanonicalKey('feed:v1:any', '  ')).toBeNull()
  })
})
