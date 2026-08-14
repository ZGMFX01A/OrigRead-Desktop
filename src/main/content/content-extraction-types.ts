export type ContentExtractionSource =
  | 'PLATFORM_SPECIFIC'
  | 'WEBSITE_RULE'
  | 'STRUCTURED_DATA'
  | 'READABILITY'
  | 'META_DESCRIPTION'

export interface ContentExtractionCandidate {
  source: ContentExtractionSource
  html: string
  title: string | null
  author: string | null
  publishedTime: string | null
  score: number
}

export interface ExtractedContent extends ContentExtractionCandidate {}

export const CONTENT_SOURCE_PRIORITY: Record<ContentExtractionSource, number> = {
  PLATFORM_SPECIFIC: 50,
  WEBSITE_RULE: 40,
  STRUCTURED_DATA: 30,
  READABILITY: 20,
  META_DESCRIPTION: 10
}
