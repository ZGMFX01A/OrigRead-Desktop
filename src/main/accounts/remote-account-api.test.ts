import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FeverApi, GoogleReaderApi, STREAM_READ, STREAM_STARRED, type AccountFetch } from './remote-account-api'

describe('GoogleReaderApi Android protocol parity', () => {
  it('uses Android ClientLogin fields, GoogleLogin authorization and optional action token', async () => {
    const calls:CapturedCall[]=[]
    const fetcher=mockFetch(calls,(url)=>{
      if(url.endsWith('/accounts/ClientLogin'))return json({Auth:'login-token'})
      if(url.endsWith('/reader/api/0/token'))return new Response('action-token',{status:200})
      if(url.includes('/reader/api/0/subscription/list'))return json({subscriptions:[]})
      return new Response('not found',{status:404})
    })
    const api=new GoogleReaderApi('https://reader.example/','alice','secret',fetcher)
    await api.authenticate()
    await api.getSubscriptionList()

    const login=calls[0]!
    expect(login.url).toBe('https://reader.example/accounts/ClientLogin')
    expect(login.method).toBe('POST')
    expect(Object.fromEntries(new URLSearchParams(login.body))).toEqual(Object.fromEntries(new URLSearchParams({
      output:'json',Email:'alice',Passwd:'secret',client:'ReadYou',accountType:'HOSTED_OR_GOOGLE',service:'reader'
    })))
    expect(calls[1]?.headers.authorization).toBe('GoogleLogin auth=login-token')
    expect(calls[2]?.headers.authorization).toBe('GoogleLogin auth=login-token')
  })

  it('does not reject valid ClientLogin when the optional action token endpoint fails', async () => {
    const calls:CapturedCall[]=[]
    const api=new GoogleReaderApi('https://reader.example/','alice','secret',mockFetch(calls,(url)=>{
      if(url.endsWith('/accounts/ClientLogin'))return new Response('Auth=line-token\n',{status:200})
      if(url.endsWith('/reader/api/0/token'))return new Response('no',{status:500})
      if(url.includes('/reader/api/0/user-info'))return json({userName:'Alice'})
      return new Response('missing',{status:404})
    }))
    expect(await api.validCredentials()).toBe(true)
    expect(await api.getUserInfo()).toEqual({userName:'Alice'})
  })

  it('quickadd sends the feed URL in both query and form, and edit-tag sends repeated item ids plus mark/unmark', async () => {
    const calls:CapturedCall[]=[]
    const api=new GoogleReaderApi('https://reader.example/','u','p',mockFetch(calls,(url)=>{
      if(url.endsWith('/accounts/ClientLogin'))return json({Auth:'t'})
      if(url.endsWith('/reader/api/0/token'))return new Response('at',{status:200})
      if(url.includes('/subscription/quickadd'))return json({streamId:'feed/123'})
      if(url.includes('/edit-tag'))return new Response('OK',{status:200})
      return new Response('missing',{status:404})
    }))
    await api.subscriptionQuickAdd('https://example.com/feed.xml')
    await api.editTag(['1','2'],STREAM_STARRED,STREAM_READ)
    const quick=calls.find((call)=>call.url.includes('/subscription/quickadd'))!
    expect(new URL(quick.url).searchParams.get('quickadd')).toBe('https://example.com/feed.xml')
    expect(new URLSearchParams(quick.body).get('quickadd')).toBe('https://example.com/feed.xml')
    expect(new URLSearchParams(quick.body).get('T')).toBe('at')
    const edit=calls.find((call)=>call.url.includes('/edit-tag'))!
    const form=new URLSearchParams(edit.body)
    expect(form.getAll('i')).toEqual(['1','2'])
    expect(form.get('a')).toBe(STREAM_STARRED)
    expect(form.get('r')).toBe(STREAM_READ)
  })

  it('reauthenticates once after a 401 and retries the original request', async () => {
    const calls:CapturedCall[]=[]
    let loginCount=0
    let listCount=0
    const api=new GoogleReaderApi('https://reader.example/','u','p',mockFetch(calls,(url)=>{
      if(url.endsWith('/accounts/ClientLogin'))return json({Auth:`token-${++loginCount}`})
      if(url.endsWith('/reader/api/0/token'))return new Response('action',{status:200})
      if(url.includes('/subscription/list')){
        listCount++
        if(listCount===1)return new Response('Unauthorized',{status:401})
        return json({subscriptions:[]})
      }
      return new Response('missing',{status:404})
    }))
    expect(await api.getSubscriptionList()).toEqual({subscriptions:[]})
    expect(loginCount).toBe(2)
    const lists=calls.filter((call)=>call.url.includes('/subscription/list'))
    expect(lists[0]?.headers.authorization).toBe('GoogleLogin auth=token-1')
    expect(lists[1]?.headers.authorization).toBe('GoogleLogin auth=token-2')
  })
})

describe('FeverApi Android protocol parity', () => {
  it('uses the exact Fever endpoint and md5(username:password) api_key', async () => {
    const calls:CapturedCall[]=[]
    const api=new FeverApi('https://fever.example/api/fever.php','alice','secret',mockFetch(calls,()=>json({auth:1})))
    expect(await api.validCredentials()).toBe(true)
    expect(calls[0]?.url).toBe('https://fever.example/api/fever.php?api=')
    const expected=createHash('md5').update('alice:secret').digest('hex')
    expect(new URLSearchParams(calls[0]!.body).get('api_key')).toBe(expected)
  })

  it('builds Fever query operations without changing the configured endpoint', async () => {
    const calls:CapturedCall[]=[]
    const api=new FeverApi('https://fever.example/custom.php?x=1','u','p',mockFetch(calls,()=>json({auth:1,items:[]})))
    await api.getItemsSince('42')
    expect(calls[0]?.url).toBe('https://fever.example/custom.php?x=1&api=&items&since_id=42')
  })
})

interface CapturedCall {url:string;method:string;headers:Record<string,string>;body:string}
function mockFetch(calls:CapturedCall[],handler:(url:string,init?:RequestInit)=>Response):AccountFetch {
  return async(input:string|URL|Request,init?:RequestInit)=>{
    const url=typeof input==='string'?input:input instanceof URL?input.toString():input.url
    const headers=Object.fromEntries(new Headers(init?.headers).entries())
    const body=init?.body instanceof URLSearchParams?init.body.toString():typeof init?.body==='string'?init.body:''
    calls.push({url,method:init?.method??'GET',headers,body})
    return handler(url,init)
  }
}
function json(value:unknown,status=200):Response{return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}})}
