import http from 'node:http'
import https from 'node:https'
import type { AccountFetch } from './remote-account-api'

export interface ClientCertificateCredentials {
  pfx: Buffer
  passphrase?: string
  /** 测试/受管环境可显式提供 CA；普通用户账户默认使用系统信任链。 */
  ca?: string | Buffer
}

/**
 * Account providers need an optional client certificate just like Android's ProviderAPI.
 * Node's built-in fetch does not expose PFX/P12 TLS options, so remote account traffic uses
 * this tiny fetch-compatible adapter only when a certificate is configured.
 */
export function createCertificateAwareAccountFetch(certificate:ClientCertificateCredentials|null):AccountFetch {
  if(!certificate)return fetch
  return async(input,init)=>request(input,init,certificate,0)
}

async function request(
  input:string|URL|Request,
  init:RequestInit|undefined,
  certificate:ClientCertificateCredentials,
  redirects:number
):Promise<Response>{
  if(redirects>5)throw new Error('账户服务器重定向次数过多')
  const sourceRequest=input instanceof Request?input:null
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.toString():input.url)
  if(url.protocol!=='http:'&&url.protocol!=='https:')throw new Error('账户服务器仅支持 HTTP(S)')
  const method=(init?.method??sourceRequest?.method??'GET').toUpperCase()
  const headers=new Headers(sourceRequest?.headers)
  new Headers(init?.headers).forEach((value,key)=>headers.set(key,value))
  const body=await resolveBody(init?.body,sourceRequest,method)
  if(body!==null&&!headers.has('content-length'))headers.set('content-length',String(body.length))
  const requester=url.protocol==='https:'?https:http

  const response=await new Promise<Response>((resolve,reject)=>{
    const req=requester.request(url,{
      method,
      headers:Object.fromEntries(headers.entries()),
      signal:init?.signal??sourceRequest?.signal,
      ...(url.protocol==='https:'?{pfx:certificate.pfx,passphrase:certificate.passphrase||undefined,ca:certificate.ca,rejectUnauthorized:true}:{})
    },(incoming)=>{
      const chunks:Buffer[]=[]
      incoming.on('data',(chunk)=>chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)))
      incoming.on('error',reject)
      incoming.on('end',()=>{
        const responseHeaders=new Headers()
        for(const [key,value] of Object.entries(incoming.headers)){
          if(value===undefined)continue
          if(Array.isArray(value))for(const item of value)responseHeaders.append(key,item)
          else responseHeaders.set(key,String(value))
        }
        resolve(new Response(Buffer.concat(chunks),{status:incoming.statusCode??500,statusText:incoming.statusMessage,headers:responseHeaders}))
      })
    })
    req.on('error',reject)
    if(body!==null)req.write(body)
    req.end()
  })

  if(!isRedirect(response.status))return response
  const redirectMode=init?.redirect??sourceRequest?.redirect??'follow'
  if(redirectMode==='manual')return response
  if(redirectMode==='error')throw new Error(`账户服务器返回重定向：HTTP ${response.status}`)
  const location=response.headers.get('location')
  if(!location)return response
  const target=new URL(location,url)
  const nextInit:{method?:string;headers?:Headers;body?:RequestInit['body'];signal?:AbortSignal;redirect?:RequestInit['redirect']}={
    method,headers,signal:init?.signal??sourceRequest?.signal,redirect:'follow'
  }
  if((response.status===301||response.status===302||response.status===303)&&method==='POST'){
    nextInit.method='GET';headers.delete('content-length')
  }else if(body!==null){
    nextInit.body=body
  }
  if(target.origin!==url.origin){headers.delete('authorization');headers.delete('cookie')}
  return request(target,nextInit,certificate,redirects+1)
}

async function resolveBody(body:RequestInit['body']|null|undefined,sourceRequest:Request|null,method:string):Promise<Buffer|null>{
  if(method==='GET'||method==='HEAD')return null
  if(body!==undefined&&body!==null){
    if(typeof body==='string')return Buffer.from(body)
    if(body instanceof URLSearchParams)return Buffer.from(body.toString())
    if(body instanceof ArrayBuffer)return Buffer.from(body)
    if(ArrayBuffer.isView(body))return Buffer.from(body.buffer,body.byteOffset,body.byteLength)
    if(body instanceof Blob)return Buffer.from(await body.arrayBuffer())
    throw new Error('账户请求包含不支持的流式请求体')
  }
  if(sourceRequest)return Buffer.from(await sourceRequest.arrayBuffer())
  return null
}

function isRedirect(status:number):boolean{return status===301||status===302||status===303||status===307||status===308}
