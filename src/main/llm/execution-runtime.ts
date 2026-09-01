import type { LlmReasoningPreference } from '../../shared/llm'
import { DEFAULT_LLM_REASONING_PREFERENCE } from '../../shared/llm'
import type { ComposedLlmContext, LlmContextItem, LlmContextPolicy } from '../../shared/llm-context'
import { LLM_CONTEXT_TYPES } from '../../shared/llm-context'
import type { LlmToolDescriptor } from '../../shared/llm-tool'
import type { AiProviderCapability, AiProviderCapabilityOverride } from '../ai/ai-provider-capabilities'
import type { AiRuntimeConfig } from '../ai/openai-compatible-provider'
import { LlmContextComposer } from './context-composer'
import type { ResolvedLlmReasoningConfig } from './reasoning-config'
import { OpenAiCompatibleLlmAdapter } from './openai-compatible-llm-adapter'
import { LlmToolRuntime } from './tool-runtime'

const DEFAULT_LLM_CONTEXT_BUDGET_TOKENS = 128_000

export type LlmExecutionTask = 'CHAT' | 'ARTICLE_ANALYSIS'

export interface LlmExecutionProfile {
  task?: LlmExecutionTask
  providerId?: string | null
  model?: string | null
  reasoning?: LlmReasoningPreference
  capabilityOverride?: AiProviderCapabilityOverride | null
  skillId?: string | null
  customInstructions?: string | null
  enabledToolIds?: ReadonlySet<string>
  contextPolicy?: LlmContextPolicy
}

export interface LlmResolvedSkill {
  id: string
  instructions: string
}

export interface LlmSkillInstructionResolver {
  resolve(skillId: string): LlmResolvedSkill | null
}

export interface LlmExecutionPlan {
  readonly task: LlmExecutionTask
  readonly providerId: string
  readonly providerName: string
  readonly model: string
  readonly runtimeConfig: Readonly<AiRuntimeConfig>
  readonly capability: AiProviderCapability
  readonly reasoning: ResolvedLlmReasoningConfig
  readonly tools: readonly LlmToolDescriptor[]
  readonly automaticToolCalling: boolean
  readonly context: ComposedLlmContext
  readonly skillId: string | null
  readonly skillInstructions: string | null
  readonly customInstructions: string | null
}

const NO_SKILLS: LlmSkillInstructionResolver = { resolve: () => null }

/** Resolves one request into a stable Main-process execution snapshot before any Provider call. */
export class LlmRuntime {
  constructor(
    private readonly providerAdapter: OpenAiCompatibleLlmAdapter,
    private readonly contextComposer = new LlmContextComposer(),
    private readonly toolRuntime = new LlmToolRuntime(),
    private readonly skillResolver: LlmSkillInstructionResolver = NO_SKILLS
  ) {}

  prepare(profile: LlmExecutionProfile = {}, contextItems: readonly LlmContextItem[] = []): LlmExecutionPlan {
    const provider = this.providerAdapter.resolveProvider(profile.providerId)
    const model = this.providerAdapter.resolveModel(provider, profile.model)
    const capability = this.providerAdapter.capability(provider, model, profile.capabilityOverride)
    const reasoningPreference = normalizeReasoningPreference(profile.reasoning)
    const reasoning = this.providerAdapter.reasoning(capability, reasoningPreference)
    const runtimeConfig = this.providerAdapter.runtimeConfig(provider, model, capability, reasoning)
    const enabledToolIds = new Set([...(profile.enabledToolIds ?? [])].map((id) => id.trim()).filter(Boolean))
    const tools = this.toolRuntime.resolveAllowed(enabledToolIds).map(cloneToolDescriptor)
    const contextPolicy = normalizeContextPolicy(profile.contextPolicy, capability.contextWindowTokens)
    const context = this.contextComposer.compose(contextItems, contextPolicy)
    const skillId = profile.skillId?.trim() || null
    const skill = skillId ? this.skillResolver.resolve(skillId) : null
    if (skillId && !skill) throw new Error(`Skill 不存在或未启用：${skillId}`)

    return {
      task: profile.task ?? 'CHAT',
      providerId: provider.id,
      providerName: provider.name,
      model,
      runtimeConfig: Object.freeze({ ...runtimeConfig }),
      capability: cloneCapability(capability),
      reasoning: Object.freeze({ ...reasoning, preference: Object.freeze({ ...reasoning.preference }) }),
      tools: Object.freeze(tools),
      automaticToolCalling: capability.supportsToolCalling && tools.length > 0,
      context: cloneContext(context),
      skillId: skill?.id ?? null,
      skillInstructions: skill?.instructions.trim() || null,
      customInstructions: profile.customInstructions?.trim() || null
    }
  }
}

function normalizeReasoningPreference(preference?: LlmReasoningPreference): LlmReasoningPreference {
  return preference ? { effort: preference.effort, showReasoning: preference.showReasoning } : { ...DEFAULT_LLM_REASONING_PREFERENCE }
}

function normalizeContextPolicy(policy: LlmContextPolicy | undefined, contextWindowTokens: number): LlmContextPolicy {
  const requested = policy?.maxTokens ?? Math.min(DEFAULT_LLM_CONTEXT_BUDGET_TOKENS, contextWindowTokens)
  // Context injection is only one part of the total prompt; never allow a profile to claim more
  // context budget than the resolved provider/model window.
  const maxTokens = Math.min(Math.max(1, Math.trunc(requested)), contextWindowTokens)
  return {
    maxTokens,
    allowedTypes: new Set(policy?.allowedTypes ?? LLM_CONTEXT_TYPES)
  }
}

function cloneToolDescriptor(descriptor: LlmToolDescriptor): LlmToolDescriptor {
  return Object.freeze({
    ...descriptor,
    inputSchema: structuredClone(descriptor.inputSchema),
    outputSchema: descriptor.outputSchema == null ? null : structuredClone(descriptor.outputSchema)
  })
}

function cloneCapability(capability: AiProviderCapability): AiProviderCapability {
  return Object.freeze({ ...capability, supportedReasoningEfforts: new Set(capability.supportedReasoningEfforts) })
}

function cloneContext(context: ComposedLlmContext): ComposedLlmContext {
  return Object.freeze({
    ...context,
    includedIds: Object.freeze([...context.includedIds]) as unknown as string[],
    omittedIds: Object.freeze([...context.omittedIds]) as unknown as string[],
    renderedItems: Object.freeze(context.renderedItems.map((item) => Object.freeze({
      ...item,
      ...(item.evidenceBlockKeys ? { evidenceBlockKeys: Object.freeze([...item.evidenceBlockKeys]) as unknown as string[] } : {})
    }))) as unknown as ComposedLlmContext['renderedItems'],
    decisions: Object.freeze(context.decisions.map((item) => Object.freeze({ ...item }))) as unknown as ComposedLlmContext['decisions']
  })
}
