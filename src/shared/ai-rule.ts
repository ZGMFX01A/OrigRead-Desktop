export type AiGeneratedRuleKind = 'WEBSITE' | 'JSON'

export interface AiGeneratedRulePreview {
  previewId: string
  kind: AiGeneratedRuleKind
  name: string
  ruleJson: string
  articleCount: number
  score: number
  sampleTitles: string[]
}
