import {
  ExaWebSearchAdapter,
  KeenableWebSearchAdapter,
  TavilyWebSearchAdapter,
  type WebSearchProviderAdapter
} from '../src/main/search/web-search-adapters'
import { webSearchProviderDefinition, type WebSearchProviderKind, type WebSearchProviderProfile } from '../src/shared/web-search'

const providers: Array<{kind:WebSearchProviderKind;adapter:WebSearchProviderAdapter;apiKey:string}> = [
  { kind: 'KEENABLE', adapter: new KeenableWebSearchAdapter(), apiKey: '' },
  { kind: 'TAVILY', adapter: new TavilyWebSearchAdapter(), apiKey: process.env.TAVILY_API_KEY ?? '' },
  { kind: 'EXA', adapter: new ExaWebSearchAdapter(), apiKey: process.env.EXA_API_KEY ?? '' }
]

let failures=0
for(const candidate of providers){
  const definition=webSearchProviderDefinition(candidate.kind)
  if(definition.requiresApiKey&&!candidate.apiKey){
    console.log(`${candidate.kind}: SKIP (credential not provided)`)
    continue
  }
  const profile:WebSearchProviderProfile={
    id:`live-${candidate.kind.toLowerCase()}`,
    kind:candidate.kind,
    name:`Live ${definition.defaultName}`,
    endpoint:definition.defaultEndpoint,
    enabled:true,
    hasApiKey:Boolean(candidate.apiKey),
    apiKeyLength:candidate.apiKey.length
  }
  const started=performance.now()
  try{
    const response=await candidate.adapter.search(profile,candidate.apiKey,{
      query:'OpenAI latest news',maxResults:3,includeContent:false,timeoutMs:12_000
    })
    if(response.results.length===0)throw new Error('no usable results')
    console.log(`${candidate.kind}: PASS (${Math.round(performance.now()-started)} ms, ${response.results.length} results)`)
  }catch(error){
    failures+=1
    console.error(`${candidate.kind}: FAIL (${error instanceof Error?error.message:String(error)})`)
  }
}

if(failures>0)process.exitCode=1
